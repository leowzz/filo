use aws_sdk_s3::{
    config::{BehaviorVersion, Credentials, Region},
    error::ProvideErrorMetadata,
    presigning::PresigningConfig,
    types::*,
    Client,
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, time::Duration};
use storage_domain::ObjectVersion;
use storage_domain::*;

pub struct S3Admin {
    client: Client,
    bucket: String,
    prefix: String,
    read_only: bool,
    region: String,
    tos_stats: Option<crate::tos_stats::TosStats>,
}
fn invalid(message: &str) -> StorageError {
    StorageError::new(StorageErrorCode::InvalidConfiguration, message)
}
fn failure<E: ProvideErrorMetadata>(error: aws_sdk_s3::error::SdkError<E>) -> StorageError {
    let code = error
        .as_service_error()
        .and_then(|e| e.code())
        .unwrap_or("");
    let (kind, message) = match code {
        "AccessDenied" | "InvalidAccessKeyId" | "SignatureDoesNotMatch" => (
            StorageErrorCode::AccessDenied,
            "S3 拒绝访问，请检查此操作的权限",
        ),
        "NoSuchKey" | "NoSuchVersion" | "NoSuchBucket" => {
            (StorageErrorCode::NotFound, "对象、版本或 Bucket 已不存在")
        }
        "BucketNotEmpty" => (
            StorageErrorCode::Conflict,
            "Bucket 仍包含对象、历史版本或删除标记，未删除",
        ),
        "PreconditionFailed" => (StorageErrorCode::Conflict, "对象已变化，请重新加载后编辑"),
        "NotImplemented" | "AccessControlListNotSupported" => {
            (StorageErrorCode::Unsupported, "此服务未启用或不支持该功能")
        }
        "BucketAlreadyExists" | "BucketAlreadyOwnedByYou" => {
            (StorageErrorCode::AlreadyExists, "Bucket 名称已被使用")
        }
        _ => (
            StorageErrorCode::Network,
            "S3 操作失败，请检查服务支持、权限和网络后重试",
        ),
    };
    StorageError::new(kind, message)
}
impl S3Admin {
    pub fn new(
        volume: &StorageVolume,
        config: &S3ConnectionConfig,
        credentials: &S3Credentials,
    ) -> StorageResult<Self> {
        // Reuse the ordinary provider's validation and credential/endpoint boundaries.
        crate::OpenDalS3Backend::new(volume, config, credentials)?;
        let VolumeRoot::S3 { bucket, prefix } = &volume.root else {
            return Err(invalid("需要 S3 连接"));
        };
        let mut builder = aws_sdk_s3::config::Builder::new()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new(config.region.clone()))
            .credentials_provider(Credentials::new(
                &credentials.access_key_id,
                &credentials.secret_access_key,
                credentials.session_token.clone(),
                None,
                "filo",
            ))
            .force_path_style(config.force_path_style)
            .timeout_config(
                aws_sdk_s3::config::timeout::TimeoutConfig::builder()
                    .operation_timeout(Duration::from_secs(60))
                    .build(),
            );
        if let Some(endpoint) = config.endpoint.as_ref().filter(|v| !v.is_empty()) {
            builder = builder.endpoint_url(endpoint);
        }
        Ok(Self {
            client: Client::from_conf(builder.build()),
            bucket: bucket.clone(),
            prefix: normalize_path(prefix)?,
            read_only: volume.read_only,
            region: config.region.clone(),
            tos_stats: crate::tos_stats::TosStats::new(config, credentials, bucket),
        })
    }
    pub async fn test_connection(&self) -> StorageResult<()> {
        // Test LIST access without mapping returned object keys to filesystem paths.
        // Keys such as "/" are valid in S3 but can panic OpenDAL's relative-path parser.
        let prefix = if self.prefix.is_empty() {
            String::new()
        } else {
            format!("{}/", self.prefix)
        };
        tokio::time::timeout(Duration::from_secs(2), async {
            self.client
                .list_objects_v2()
                .bucket(&self.bucket)
                .prefix(prefix)
                .max_keys(1)
                .send()
                .await
                .map_err(failure)?;
            Ok(())
        })
        .await
        .map_err(|_| {
            let mut error = StorageError::new(
                StorageErrorCode::Timeout,
                "连接测试超时（2 秒），请检查网络和服务地址后重试",
            );
            error.retryable = true;
            error
        })?
    }
    fn key(&self, path: &str) -> StorageResult<String> {
        let normal = normalize_path(path)?;
        if normal != path && (normal.is_empty() || format!("{normal}/") != path) {
            return Err(invalid(
                "此对象名称不能安全映射为文件路径，请使用原生 S3 控制台操作",
            ));
        }
        Ok([self.prefix.as_str(), path]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("/"))
    }
    fn copy_source(&self, key: &str, version: Option<&str>) -> String {
        let encode = |v: &str| {
            url::form_urlencoded::byte_serialize(v.as_bytes())
                .collect::<String>()
                .replace('+', "%20")
        };
        let mut value = format!("{}/{}", self.bucket, encode(key));
        if let Some(version) = version {
            value.push_str(&format!("?versionId={}", encode(version)));
        }
        value
    }
    fn confirm(&self, actual: &str, expected: &str) -> StorageResult<()> {
        if actual != expected {
            Err(invalid("确认名称不匹配"))
        } else {
            Ok(())
        }
    }
    pub async fn run(&self, path: &str, action: S3Action) -> StorageResult<Value> {
        if action.writes() && self.read_only {
            return Err(StorageError::new(
                StorageErrorCode::AccessDenied,
                "只读连接不能修改 S3",
            ));
        }
        let logical = path.to_string();
        let key = self.key(path)?;
        let bucket_action = matches!(
            action,
            S3Action::BucketStatus
                | S3Action::CreateBucket { .. }
                | S3Action::DeleteBucket { .. }
                | S3Action::SetVersioning { .. }
        );
        if bucket_action && (!self.prefix.is_empty() || !logical.is_empty()) {
            return Err(StorageError::new(
                StorageErrorCode::AccessDenied,
                "Bucket 管理需要连接整个 Bucket，不能使用受限 Prefix",
            ));
        }
        if !bucket_action
            && !matches!(
                action,
                S3Action::Versions { .. } | S3Action::StorageOverview
            )
            && logical.is_empty()
        {
            return Err(invalid("请选择对象"));
        }
        match action {
            S3Action::StorageOverview => {
                if !logical.is_empty() {
                    return Err(invalid("存储概览需要使用连接根目录"));
                }
                let bucket_stats_error = if let Some(tos) = &self.tos_stats {
                    match tos.overview().await {
                        Ok(overview) => return Ok(overview),
                        Err(error) => Some(error.message),
                    }
                } else {
                    None
                };
                // A single bounded LIST includes nested and hidden objects, but never
                // expands beyond the configured prefix or scans a large bucket.
                let prefix = if self.prefix.is_empty() {
                    String::new()
                } else {
                    format!("{}/", self.prefix)
                };
                let result = self
                    .client
                    .list_objects_v2()
                    .bucket(&self.bucket)
                    .prefix(prefix)
                    .max_keys(1000)
                    .send()
                    .await
                    .map_err(failure)?;
                let mut total_size = 0u64;
                for object in result.contents() {
                    let size = object.size().filter(|size| *size >= 0).ok_or_else(|| {
                        StorageError::new(
                            StorageErrorCode::Unsupported,
                            "服务未返回有效的对象大小，无法统计容量",
                        )
                    })?;
                    total_size += size as u64;
                }
                let mut overview = json!({
                    "object_count": result.contents().len(),
                    "total_size": total_size,
                    "complete": result.is_truncated() == Some(false),
                });
                if let Some(error) = bucket_stats_error {
                    overview["bucket_stats_error"] = json!(error);
                }
                Ok(overview)
            }
            S3Action::BucketStatus => {
                let r = self
                    .client
                    .get_bucket_versioning()
                    .bucket(&self.bucket)
                    .send()
                    .await
                    .map_err(failure)?;
                Ok(
                    json!({"bucket":self.bucket,"versioning":r.status.map(|v|v.as_str().to_owned()).unwrap_or("Disabled".into())}),
                )
            }
            S3Action::CreateBucket { name } => {
                if name.len() < 3
                    || name.len() > 63
                    || name.parse::<std::net::IpAddr>().is_ok()
                    || !name.bytes().all(|b| {
                        b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.'
                    })
                    || name.starts_with(['-', '.'])
                    || name.ends_with(['-', '.'])
                    || name.contains("..")
                {
                    return Err(invalid("Bucket 名称需为 3–63 位小写字母、数字、点或连字符"));
                }
                match self.client.head_bucket().bucket(&name).send().await {
                    Ok(_) => {
                        return Err(StorageError::new(
                            StorageErrorCode::AlreadyExists,
                            "Bucket 已存在，未修改",
                        ))
                    }
                    Err(error)
                        if error
                            .raw_response()
                            .is_some_and(|r| r.status().as_u16() == 404) => {}
                    Err(error) => return Err(failure(error)),
                }
                let mut req = self.client.create_bucket().bucket(&name);
                if self.region != "us-east-1" {
                    req = req.create_bucket_configuration(
                        CreateBucketConfiguration::builder()
                            .location_constraint(BucketLocationConstraint::from(
                                self.region.as_str(),
                            ))
                            .build(),
                    );
                }
                req.send().await.map_err(failure)?;
                Ok(json!({"bucket":name}))
            }
            S3Action::DeleteBucket { confirmation } => {
                self.confirm(&confirmation, &self.bucket)?;
                self.client
                    .delete_bucket()
                    .bucket(&self.bucket)
                    .send()
                    .await
                    .map_err(failure)?;
                Ok(Value::Null)
            }
            S3Action::SetVersioning {
                enabled,
                confirmation,
            } => {
                self.confirm(&confirmation, &self.bucket)?;
                self.client
                    .put_bucket_versioning()
                    .bucket(&self.bucket)
                    .versioning_configuration(
                        VersioningConfiguration::builder()
                            .status(if enabled {
                                BucketVersioningStatus::Enabled
                            } else {
                                BucketVersioningStatus::Suspended
                            })
                            .build(),
                    )
                    .send()
                    .await
                    .map_err(failure)?;
                Ok(Value::Null)
            }
            S3Action::Versions {
                exact,
                key_marker,
                version_marker,
            } => {
                if let Some(marker) = &key_marker {
                    if !self.prefix.is_empty() && !marker.starts_with(&format!("{}/", self.prefix))
                    {
                        return Err(invalid("无效的版本分页"));
                    }
                }
                let prefix = if !exact && !key.is_empty() {
                    format!("{key}/")
                } else {
                    key.clone()
                };
                let r = self
                    .client
                    .list_object_versions()
                    .bucket(&self.bucket)
                    .prefix(prefix)
                    .set_key_marker(key_marker)
                    .set_version_id_marker(version_marker)
                    .max_keys(200)
                    .send()
                    .await
                    .map_err(failure)?;
                let strip = |key: &str| {
                    if self.prefix.is_empty() {
                        key.to_string()
                    } else {
                        key.strip_prefix(&format!("{}/", self.prefix))
                            .unwrap_or("")
                            .to_string()
                    }
                };
                let mut versions = Vec::new();
                for v in r.versions() {
                    if exact && v.key() != Some(key.as_str()) {
                        continue;
                    }
                    versions.push(ObjectVersion {
                        key: strip(v.key().unwrap_or("")),
                        version_id: v.version_id().unwrap_or("null").into(),
                        latest: v.is_latest().unwrap_or(false),
                        delete_marker: false,
                        size: v.size().unwrap_or(0),
                        modified: v
                            .last_modified()
                            .map(ToString::to_string)
                            .unwrap_or_default(),
                    });
                }
                for v in r.delete_markers() {
                    if exact && v.key() != Some(key.as_str()) {
                        continue;
                    }
                    versions.push(ObjectVersion {
                        key: strip(v.key().unwrap_or("")),
                        version_id: v.version_id().unwrap_or("null").into(),
                        latest: v.is_latest().unwrap_or(false),
                        delete_marker: true,
                        size: 0,
                        modified: v
                            .last_modified()
                            .map(ToString::to_string)
                            .unwrap_or_default(),
                    });
                }
                versions
                    .sort_by(|a, b| a.key.cmp(&b.key).then_with(|| b.modified.cmp(&a.modified)));
                Ok(json!(VersionPage {
                    versions,
                    next_key: r.next_key_marker,
                    next_version: r.next_version_id_marker
                }))
            }
            S3Action::DeleteVersion {
                version,
                confirmation,
            } => {
                self.confirm(&confirmation, &logical)?;
                if version.is_empty() {
                    return Err(invalid("缺少版本编号"));
                }
                self.client
                    .delete_object()
                    .bucket(&self.bucket)
                    .key(key)
                    .version_id(version)
                    .send()
                    .await
                    .map_err(failure)?;
                Ok(Value::Null)
            }
            S3Action::RestoreVersion {
                version,
                confirmation,
            } => {
                self.confirm(&confirmation, &logical)?;
                let state = self
                    .client
                    .get_bucket_versioning()
                    .bucket(&self.bucket)
                    .send()
                    .await
                    .map_err(failure)?;
                if state.status != Some(BucketVersioningStatus::Enabled) {
                    return Err(invalid(
                        "请先启用 Bucket 版本控制，再恢复历史版本以保留当前内容",
                    ));
                }
                let head = self
                    .client
                    .head_object()
                    .bucket(&self.bucket)
                    .key(&key)
                    .version_id(&version)
                    .send()
                    .await
                    .map_err(failure)?;
                if head.content_length.unwrap_or(0) > 5 * 1024 * 1024 * 1024 {
                    return Err(invalid("超过 5 GiB 的版本请下载后重新上传"));
                }
                self.client
                    .copy_object()
                    .bucket(&self.bucket)
                    .key(&key)
                    .copy_source(self.copy_source(&key, Some(&version)))
                    .send()
                    .await
                    .map_err(failure)?;
                Ok(Value::Null)
            }
            S3Action::Share { expires, version } => {
                if !(60..=604800).contains(&expires) {
                    return Err(invalid("链接有效期需为 1 分钟至 7 天"));
                }
                self.client
                    .head_object()
                    .bucket(&self.bucket)
                    .key(&key)
                    .set_version_id(version.clone())
                    .send()
                    .await
                    .map_err(failure)?;
                let signed = self
                    .client
                    .get_object()
                    .bucket(&self.bucket)
                    .key(key)
                    .set_version_id(version)
                    .response_content_disposition("attachment")
                    .presigned(
                        PresigningConfig::expires_in(Duration::from_secs(expires))
                            .map_err(|_| invalid("无效有效期"))?,
                    )
                    .await
                    .map_err(failure)?;
                Ok(json!({"url":signed.uri(),"expires":expires}))
            }
            S3Action::Properties => {
                let r = self
                    .client
                    .head_object()
                    .bucket(&self.bucket)
                    .key(key)
                    .send()
                    .await
                    .map_err(failure)?;
                Ok(json!(ObjectProperties {
                    etag: r.e_tag.unwrap_or_default(),
                    content_type: r.content_type.unwrap_or("application/octet-stream".into()),
                    metadata: r.metadata.unwrap_or_default().into_iter().collect()
                }))
            }
            S3Action::SetMetadata {
                etag,
                content_type,
                metadata,
            } => {
                if etag.is_empty()
                    || content_type.is_empty()
                    || content_type.contains(['\r', '\n'])
                    || metadata.iter().any(|(k, v)| {
                        k.is_empty()
                            || !k
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                            || v.contains(['\r', '\n'])
                    })
                    || metadata
                        .iter()
                        .map(|(k, v)| k.len() + v.len())
                        .sum::<usize>()
                        > 2048
                {
                    return Err(invalid("Metadata 需为有效名称和值，合计不超过 2 KiB"));
                }
                let r = self
                    .client
                    .head_object()
                    .bucket(&self.bucket)
                    .key(&key)
                    .send()
                    .await
                    .map_err(failure)?;
                if r.e_tag.as_deref() != Some(&etag) {
                    return Err(StorageError::new(
                        StorageErrorCode::Conflict,
                        "对象已变化，请重新加载",
                    ));
                }
                if r.content_length.unwrap_or(0) > 5 * 1024 * 1024 * 1024 {
                    return Err(invalid("超过 5 GiB 的对象暂不支持原地修改 Metadata"));
                }
                // Self-copy preserves data, tags and standard headers; explicitly retain ACL grants too.
                let acl = self
                    .client
                    .get_object_acl()
                    .bucket(&self.bucket)
                    .key(&key)
                    .send()
                    .await
                    .map_err(failure)?;
                let owner = acl.owner().and_then(|owner| owner.id());
                // RustFS omits the ID on its sole default owner grant. No other
                // incomplete grant can be safely translated into a CopyObject header.
                let private = acl.grants().iter().all(|grant| {
                    grant.permission() == Some(&Permission::FullControl)
                        && grant.grantee().is_some_and(|g| {
                            g.id() == owner
                                || (acl.grants().len() == 1
                                    && g.r#type() == &Type::CanonicalUser
                                    && g.id().is_none()
                                    && g.uri().is_none()
                                    && g.email_address().is_none())
                        })
                });
                let grant_header = |permission: Permission| -> StorageResult<Option<String>> {
                    if private {
                        return Ok(None);
                    }
                    let values = acl
                        .grants()
                        .iter()
                        .filter(|g| g.permission() == Some(&permission))
                        .map(|grant| {
                            let grantee =
                                grant.grantee().ok_or_else(|| invalid("无法保留原 ACL"))?;
                            let (kind, value) = if let Some(id) = grantee.id() {
                                ("id", id)
                            } else if let Some(uri) = grantee.uri() {
                                ("uri", uri)
                            } else {
                                return Err(invalid("此 ACL 授权暂不支持保留"));
                            };
                            if value.contains(['"', '\r', '\n']) {
                                return Err(invalid("无效的 ACL 授权"));
                            }
                            Ok(format!("{kind}=\"{value}\""))
                        })
                        .collect::<StorageResult<Vec<_>>>()?;
                    Ok((!values.is_empty()).then(|| values.join(",")))
                };
                if acl.grants().iter().any(|g| {
                    !matches!(
                        g.permission(),
                        Some(
                            Permission::FullControl
                                | Permission::Read
                                | Permission::ReadAcp
                                | Permission::WriteAcp
                        )
                    )
                }) {
                    return Err(invalid("对象包含不能保留的 ACL 授权，Metadata 未修改"));
                }
                #[allow(deprecated)]
                let expires = r.expires;
                self.client
                    .copy_object()
                    .bucket(&self.bucket)
                    .key(&key)
                    .copy_source(self.copy_source(&key, None))
                    .copy_source_if_match(etag)
                    .metadata_directive(MetadataDirective::Replace)
                    .set_metadata(Some(metadata.into_iter().collect()))
                    .content_type(content_type)
                    .set_expires(expires)
                    .set_storage_class(r.storage_class)
                    .set_bucket_key_enabled(r.bucket_key_enabled)
                    .set_object_lock_mode(r.object_lock_mode)
                    .set_object_lock_retain_until_date(r.object_lock_retain_until_date)
                    .set_object_lock_legal_hold_status(r.object_lock_legal_hold_status)
                    .set_cache_control(r.cache_control)
                    .set_content_disposition(r.content_disposition)
                    .set_content_encoding(r.content_encoding)
                    .set_content_language(r.content_language)
                    .set_website_redirect_location(r.website_redirect_location)
                    .set_server_side_encryption(r.server_side_encryption)
                    .set_ssekms_key_id(r.ssekms_key_id)
                    .set_grant_full_control(grant_header(Permission::FullControl)?)
                    .set_grant_read(grant_header(Permission::Read)?)
                    .set_grant_read_acp(grant_header(Permission::ReadAcp)?)
                    .set_grant_write_acp(grant_header(Permission::WriteAcp)?)
                    .send()
                    .await
                    .map_err(failure)?;
                Ok(Value::Null)
            }
            S3Action::Tags => {
                let r = self
                    .client
                    .get_object_tagging()
                    .bucket(&self.bucket)
                    .key(key)
                    .send()
                    .await
                    .map_err(failure)?;
                let tags: BTreeMap<_, _> = r
                    .tag_set()
                    .iter()
                    .map(|t| (t.key().to_string(), t.value().to_string()))
                    .collect();
                Ok(json!(tags))
            }
            S3Action::SetTags { tags } => {
                if tags.len() > 10
                    || tags.iter().any(|(k, v)| {
                        k.is_empty()
                            || k.chars().count() > 128
                            || v.chars().count() > 256
                            || k.starts_with("aws:")
                    })
                {
                    return Err(invalid(
                        "最多 10 个标签，名称 1–128 字符，值不超过 256 字符，不能使用 aws: 前缀",
                    ));
                }
                let tags = tags
                    .into_iter()
                    .map(|(k, v)| {
                        Tag::builder()
                            .key(k)
                            .value(v)
                            .build()
                            .map_err(|_| invalid("标签无效"))
                    })
                    .collect::<StorageResult<Vec<_>>>()?;
                self.client
                    .put_object_tagging()
                    .bucket(&self.bucket)
                    .key(key)
                    .tagging(
                        Tagging::builder()
                            .set_tag_set(Some(tags))
                            .build()
                            .map_err(|_| invalid("标签无效"))?,
                    )
                    .send()
                    .await
                    .map_err(failure)?;
                Ok(Value::Null)
            }
            S3Action::Acl => {
                let r = self
                    .client
                    .get_object_acl()
                    .bucket(&self.bucket)
                    .key(key)
                    .send()
                    .await
                    .map_err(failure)?;
                Ok(
                    json!({"owner":r.owner().and_then(|o|o.id()).unwrap_or(""),"grants":r.grants().iter().map(|g|json!({"permission":g.permission().map(|p|p.as_str()),"id":g.grantee().and_then(|v|v.id()),"uri":g.grantee().and_then(|v|v.uri())})).collect::<Vec<_>>()}),
                )
            }
            S3Action::SetAcl { acl, confirmation } => {
                self.confirm(&confirmation, &logical)?;
                if ![
                    "private",
                    "public-read",
                    "authenticated-read",
                    "bucket-owner-full-control",
                ]
                .contains(&acl.as_str())
                {
                    return Err(invalid("不支持的 ACL"));
                }
                let bucket_owner = if acl == "bucket-owner-full-control" {
                    self.client
                        .get_bucket_acl()
                        .bucket(&self.bucket)
                        .send()
                        .await
                        .map_err(failure)?
                        .owner
                        .and_then(|owner| owner.id)
                } else {
                    None
                };
                self.client
                    .put_object_acl()
                    .bucket(&self.bucket)
                    .key(&key)
                    .acl(ObjectCannedAcl::from(acl.as_str()))
                    .send()
                    .await
                    .map_err(failure)?;
                let saved = self
                    .client
                    .get_object_acl()
                    .bucket(&self.bucket)
                    .key(key)
                    .send()
                    .await
                    .map_err(failure)?;
                let owner = saved.owner().and_then(|v| v.id());
                let matches = match acl.as_str() {
                    "private" => saved.grants().iter().all(|g| {
                        g.permission() == Some(&Permission::FullControl)
                            && g.grantee().is_some_and(|v| {
                                v.r#type() == &Type::CanonicalUser
                                    && (v.id() == owner || v.id().is_none())
                            })
                    }),
                    "public-read" | "authenticated-read" => {
                        let uri = if acl == "public-read" {
                            "http://acs.amazonaws.com/groups/global/AllUsers"
                        } else {
                            "http://acs.amazonaws.com/groups/global/AuthenticatedUsers"
                        };
                        saved.grants().iter().any(|g| {
                            g.permission() == Some(&Permission::Read)
                                && g.grantee().and_then(|v| v.uri()) == Some(uri)
                        })
                    }
                    _ => bucket_owner.as_deref().is_some_and(|id| {
                        saved.grants().iter().any(|g| {
                            g.permission() == Some(&Permission::FullControl)
                                && g.grantee().is_some_and(|v| {
                                    v.id() == Some(id) || (v.id().is_none() && owner == Some(id))
                                })
                        })
                    }),
                };
                if !matches {
                    return Err(StorageError::new(StorageErrorCode::Unsupported, "服务接受了 ACL 请求，但读回权限与所选设置不一致；无法确认修改，请在服务控制台检查"));
                }
                Ok(Value::Null)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn connection_test_accepts_root_keys_and_preserves_list_scope() {
        for (prefix, status, body) in [
            (
                "",
                "200 OK",
                "<Contents><Key>/</Key><Size>0</Size></Contents>",
            ),
            (
                "limited",
                "200 OK",
                "<CommonPrefixes><Prefix>/limited/</Prefix></CommonPrefixes>",
            ),
            ("limited", "403 Forbidden", "<Code>AccessDenied</Code>"),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buf = [0u8; 4096];
                while !request.windows(4).any(|b| b == b"\r\n\r\n") {
                    let n = socket.read(&mut buf).await.unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&buf[..n]);
                }
                let headers = String::from_utf8_lossy(&request);
                let target = headers
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .nth(1)
                    .unwrap();
                let url = url::Url::parse(&format!("http://localhost{target}")).unwrap();
                let query: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
                assert!(headers.starts_with("GET "));
                assert_eq!(url.path().trim_end_matches('/'), "/test-bucket");
                assert_eq!(query.get("list-type").map(String::as_str), Some("2"));
                assert_eq!(query.get("max-keys").map(String::as_str), Some("1"));
                assert_eq!(
                    query.get("prefix").map(String::as_str).unwrap_or(""),
                    if prefix.is_empty() { "" } else { "limited/" }
                );
                assert!(!query.contains_key("continuation-token"));
                let body = if status.starts_with("403") {
                    format!("<Error>{body}</Error>")
                } else {
                    format!(
                        r#"<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken>{body}</ListBucketResult>"#
                    )
                };
                socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/xml\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            });
            let admin = S3Admin::new(
                &StorageVolume {
                    id: uuid::Uuid::new_v4(),
                    connection_id: uuid::Uuid::new_v4(),
                    name: "test".into(),
                    root: VolumeRoot::S3 {
                        bucket: "test-bucket".into(),
                        prefix: prefix.into(),
                    },
                    read_only: true,
                },
                &S3ConnectionConfig {
                    provider: None,
                    endpoint: Some(endpoint),
                    region: "us-east-1".into(),
                    force_path_style: true,
                },
                &S3Credentials {
                    access_key_id: "test".into(),
                    secret_access_key: "test".into(),
                    session_token: None,
                },
            )
            .unwrap();
            let result = admin.test_connection().await;
            if status.starts_with("403") {
                assert_eq!(result.unwrap_err().code, StorageErrorCode::AccessDenied);
            } else {
                result.unwrap();
            }
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn connection_test_times_out_when_server_does_not_respond() {
        use std::time::{Duration, Instant};

        // Keep the TCP listener alive without responding to HTTP requests.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let volume = StorageVolume {
            id: uuid::Uuid::new_v4(),
            connection_id: uuid::Uuid::new_v4(),
            name: "timeout test".into(),
            root: VolumeRoot::S3 {
                bucket: "bucket".into(),
                prefix: String::new(),
            },
            read_only: true,
        };
        let backend = S3Admin::new(
            &volume,
            &S3ConnectionConfig {
                provider: None,
                endpoint: Some(format!("http://{}", listener.local_addr().unwrap())),
                region: "us-east-1".into(),
                force_path_style: true,
            },
            &S3Credentials {
                access_key_id: "test".into(),
                secret_access_key: "test".into(),
                session_token: None,
            },
        )
        .unwrap();

        let started = Instant::now();
        let error = tokio::time::timeout(Duration::from_secs(3), backend.test_connection())
            .await
            .expect("connection test must stop before the general request timeout")
            .unwrap_err();
        assert_eq!(error.code, StorageErrorCode::Timeout);
        assert!(error.retryable);
        assert!(started.elapsed() >= Duration::from_secs(2));
    }

    #[tokio::test]
    async fn storage_overview_is_bounded_scoped_and_distinguishes_incomplete_results() {
        for (prefix, body, status, expected) in [
            ("", "<IsTruncated>false</IsTruncated>", "200 OK", Ok((0, 0, true))),
            ("limited", "<IsTruncated>false</IsTruncated><Contents><Key>limited/nested/.hidden</Key><Size>123</Size></Contents><Contents><Key>limited/folder/</Key><Size>0</Size></Contents><Contents><Key>limited/file</Key><Size>456</Size></Contents>", "200 OK", Ok((3, 579, true))),
            ("limited", "<IsTruncated>true</IsTruncated><NextContinuationToken>next-page</NextContinuationToken><Contents><Key>limited/file</Key><Size>100</Size></Contents>", "200 OK", Ok((1, 100, false))),
            ("", "<Contents><Key>file</Key><Size>100</Size></Contents>", "200 OK", Ok((1, 100, false))),
            ("", "<IsTruncated>false</IsTruncated><Contents><Key>file</Key></Contents>", "200 OK", Err(StorageErrorCode::Unsupported)),
            ("limited", "", "403 Forbidden", Err(StorageErrorCode::AccessDenied)),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                // Accept exactly one request: a truncated result must not start a scan.
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buf = [0u8; 4096];
                while !request.windows(4).any(|b| b == b"\r\n\r\n") {
                    let n = socket.read(&mut buf).await.unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&buf[..n]);
                }
                let headers = String::from_utf8_lossy(&request);
                let target = headers.lines().next().unwrap().split_whitespace().nth(1).unwrap();
                let url = url::Url::parse(&format!("http://localhost{target}")).unwrap();
                let query: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
                assert!(headers.starts_with("GET "));
                assert_eq!(url.path().trim_end_matches('/'), "/test-bucket");
                assert_eq!(query.get("list-type").map(String::as_str), Some("2"));
                assert_eq!(query.get("max-keys").map(String::as_str), Some("1000"));
                assert_eq!(query.get("prefix").map(String::as_str).unwrap_or(""), if prefix.is_empty() { "" } else { "limited/" });
                assert!(!query.contains_key("delimiter"));
                assert!(!query.contains_key("continuation-token"));
                let body = if status.starts_with("403") {
                    "<Error><Code>AccessDenied</Code></Error>".to_string()
                } else {
                    format!(r#"<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">{body}</ListBucketResult>"#)
                };
                socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/xml\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            });
            let volume = StorageVolume {
                id: uuid::Uuid::new_v4(),
                connection_id: uuid::Uuid::new_v4(),
                name: "test".into(),
                root: VolumeRoot::S3 { bucket: "test-bucket".into(), prefix: prefix.into() },
                read_only: true,
            };
            let config = S3ConnectionConfig {
                provider: None,
                endpoint: Some(endpoint),
                region: "us-east-1".into(),
                force_path_style: true,
            };
            let credentials = S3Credentials {
                access_key_id: "test".into(),
                secret_access_key: "test".into(),
                session_token: None,
            };
            let admin = S3Admin::new(&volume, &config, &credentials).unwrap();
            assert!(admin.run("nested", S3Action::StorageOverview).await.is_err());
            let result = admin.run("", S3Action::StorageOverview).await;
            match expected {
                Ok((count, size, complete)) => assert_eq!(result.unwrap(), json!({"object_count":count,"total_size":size,"complete":complete})),
                Err(code) => assert_eq!(result.unwrap_err().code, code),
            }
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn tos_overview_uses_bucket_stats_and_falls_back_to_scoped_listing() {
        for denied in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                for step in 0..if denied { 2 } else { 1 } {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut request = Vec::new();
                    let mut buf = [0u8; 4096];
                    while !request.windows(4).any(|b| b == b"\r\n\r\n") {
                        let n = socket.read(&mut buf).await.unwrap();
                        assert!(n > 0);
                        request.extend_from_slice(&buf[..n]);
                    }
                    let headers = String::from_utf8_lossy(&request).to_lowercase();
                    let (status, body) = if step == 0 {
                        assert!(headers.starts_with("get /?stat= http/1.1"));
                        assert!(headers.contains("authorization: tos4-hmac-sha256"));
                        assert!(headers.contains("x-tos-security-token: test-token"));
                        assert!(!headers.contains("prefix="));
                        if denied {
                            ("403 Forbidden", r#"{"Code":"AccessDenied"}"#)
                        } else {
                            (
                                "200 OK",
                                r#"{"TotalStorageStat":{"Storage":"2048","ChargeStorage":"99999","ObjectCount":1234}}"#,
                            )
                        }
                    } else {
                        assert!(headers.contains("list-type=2"));
                        assert!(headers.contains("prefix=limited%2f"));
                        assert!(headers.contains("max-keys=1000"));
                        ("200 OK", "<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>limited/file</Key><Size>100</Size></Contents></ListBucketResult>")
                    };
                    socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                }
            });
            let volume = StorageVolume {
                id: uuid::Uuid::new_v4(),
                connection_id: uuid::Uuid::new_v4(),
                name: "tos".into(),
                root: VolumeRoot::S3 {
                    bucket: "test-bucket".into(),
                    prefix: "limited".into(),
                },
                read_only: true,
            };
            let mut config = S3ConnectionConfig {
                provider: Some(S3Provider::Tos),
                endpoint: Some(endpoint.clone()),
                region: "cn-beijing".into(),
                force_path_style: true,
            };
            let credentials = S3Credentials {
                access_key_id: "test".into(),
                secret_access_key: "test".into(),
                session_token: Some("test-token".into()),
            };
            let mut admin = S3Admin::new(&volume, &config, &credentials).unwrap();
            config.endpoint = Some("https://tos-s3-cn-beijing.volces.com".into());
            admin.tos_stats = Some(
                crate::tos_stats::TosStats::new(&config, &credentials, "test-bucket")
                    .unwrap()
                    .with_test_url(url::Url::parse(&format!("{endpoint}/?stat=")).unwrap()),
            );
            let overview = tokio::time::timeout(
                Duration::from_secs(5),
                admin.run("", S3Action::StorageOverview),
            )
            .await
            .unwrap()
            .unwrap();
            if denied {
                assert_eq!(overview["complete"], false);
                assert_eq!(overview["object_count"], 1);
                assert!(overview.get("source").is_none());
                assert!(overview["bucket_stats_error"]
                    .as_str()
                    .unwrap()
                    .contains("tos:GetBucketStat"));
            } else {
                assert_eq!(
                    overview,
                    json!({"object_count": 1234, "total_size": 2048, "complete": true, "source": "tos_bucket_stat"})
                );
            }
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn acl_saves_are_read_back_and_ignored_writes_are_not_reported_as_success() {
        for applied in [true, false] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                for step in 0..2 {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut request = Vec::new();
                    let mut buf = [0u8; 4096];
                    while !request.windows(4).any(|b| b == b"\r\n\r\n") {
                        let n = socket.read(&mut buf).await.unwrap();
                        assert!(n > 0);
                        request.extend_from_slice(&buf[..n]);
                    }
                    let headers = String::from_utf8_lossy(&request).to_lowercase();
                    assert!(headers.contains("?acl"));
                    if step == 0 {
                        assert!(headers.starts_with("put "));
                        assert!(headers.contains("x-amz-acl: public-read"));
                    } else {
                        assert!(headers.starts_with("get "));
                    }
                    let body = if step == 0 {
                        String::new()
                    } else {
                        format!(
                            r#"<AccessControlPolicy xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>owner</ID></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>owner</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant>{}</AccessControlList></AccessControlPolicy>"#,
                            if applied {
                                r#"<Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Group"><URI>http://acs.amazonaws.com/groups/global/AllUsers</URI></Grantee><Permission>READ</Permission></Grant>"#
                            } else {
                                ""
                            }
                        )
                    };
                    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/xml\r\nConnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await.unwrap();
                }
            });
            let volume = StorageVolume {
                id: uuid::Uuid::new_v4(),
                connection_id: uuid::Uuid::new_v4(),
                name: "test".into(),
                root: VolumeRoot::S3 {
                    bucket: "test-bucket".into(),
                    prefix: "limited".into(),
                },
                read_only: false,
            };
            let config = S3ConnectionConfig {
                provider: None,
                endpoint: Some(endpoint),
                region: "us-east-1".into(),
                force_path_style: true,
            };
            let credentials = S3Credentials {
                access_key_id: "test".into(),
                secret_access_key: "test".into(),
                session_token: None,
            };
            let admin = S3Admin::new(&volume, &config, &credentials).unwrap();
            assert!(admin
                .run(
                    "a//b",
                    S3Action::DeleteVersion {
                        version: "v1".into(),
                        confirmation: "a//b".into()
                    }
                )
                .await
                .is_err());
            let result = admin
                .run(
                    "file",
                    S3Action::SetAcl {
                        acl: "public-read".into(),
                        confirmation: "file".into(),
                    },
                )
                .await;
            if applied {
                result.unwrap();
            } else {
                assert_eq!(result.unwrap_err().code, StorageErrorCode::Unsupported);
            }
            server.await.unwrap();
        }
    }
}
