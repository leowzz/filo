use opendal::{layers::TimeoutLayer, services::S3, ErrorKind, Metadata, Operator};
use std::sync::Arc;
use storage_domain::*;
use storage_provider_api::{StagedWrite, StorageBackend, StorageReader, TransferLimits};
use uuid::Uuid;

mod checksum;
mod io;
mod listing;
use io::{digest, publish, reader};

#[cfg(test)]
mod tests;

#[derive(Clone)]
pub struct OpenDalS3Backend {
    volume_id: Uuid,
    read_only: bool,
    operator: Operator,
    namespace: String,
    prefix: String,
    limits: Arc<TransferLimits>,
}

fn error(error: opendal::Error) -> StorageError {
    // OpenDAL errors can contain signed URLs and request details. Never forward them.
    let (code, message) = match error.kind() {
        ErrorKind::NotFound => (StorageErrorCode::NotFound, "S3 对象或 Bucket 不存在"),
        ErrorKind::PermissionDenied => (
            StorageErrorCode::AccessDenied,
            "S3 拒绝访问，请检查凭据及 Bucket/Prefix 权限",
        ),
        ErrorKind::AlreadyExists | ErrorKind::ConditionNotMatch => (
            StorageErrorCode::Conflict,
            "同名对象已存在或源对象已变化，操作已停止",
        ),
        ErrorKind::Unsupported => (
            StorageErrorCode::Unsupported,
            "此 S3 服务不支持所需操作或安全写入条件",
        ),
        ErrorKind::ConfigInvalid => (StorageErrorCode::InvalidConfiguration, "S3 连接配置无效"),
        _ => (
            StorageErrorCode::Network,
            "S3 请求失败，请检查服务地址、网络或超时后重试",
        ),
    };
    let mut result = StorageError::new(code, message);
    result.retryable = error.is_temporary();
    result
}
fn invalid(message: &str) -> StorageError {
    StorageError::new(StorageErrorCode::InvalidConfiguration, message)
}

impl OpenDalS3Backend {
    pub fn with_transfer_limits(mut self, limits: Arc<TransferLimits>) -> Self {
        self.limits = limits;
        self
    }
    pub fn new(
        volume: &StorageVolume,
        config: &S3ConnectionConfig,
        credentials: &S3Credentials,
    ) -> StorageResult<Self> {
        let VolumeRoot::S3 { bucket, prefix } = &volume.root else {
            return Err(invalid("需要 S3 存储空间"));
        };
        if bucket.is_empty()
            || bucket.contains(['/', '\\', ':'])
            || bucket.chars().any(char::is_whitespace)
            || config.region.trim().is_empty()
            || credentials.access_key_id.is_empty()
            || credentials.secret_access_key.is_empty()
        {
            return Err(invalid("请填写有效的 Bucket、Region 和访问凭据"));
        }
        let prefix = normalize_path(prefix)?;
        let mut builder = S3::default()
            .bucket(bucket)
            .root(&prefix)
            .region(&config.region)
            .access_key_id(&credentials.access_key_id)
            .secret_access_key(&credentials.secret_access_key)
            .disable_config_load()
            .disable_ec2_metadata();
        if let Some(endpoint) = config.endpoint.as_deref().filter(|v| !v.is_empty()) {
            let url = url::Url::parse(endpoint)
                .map_err(|_| invalid("Endpoint 必须是完整的 HTTP(S) 地址"))?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
                || url.path() != "/"
            {
                return Err(invalid(
                    "Endpoint 仅包含协议、主机及端口，不包含凭据、路径或查询参数",
                ));
            }
            builder = builder.endpoint(endpoint);
        }
        if !config.force_path_style {
            builder = builder.enable_virtual_host_style();
        }
        if let Some(token) = &credentials.session_token {
            builder = builder.session_token(token);
        }
        let operator = Operator::new(builder)
            .map_err(error)?
            .layer(
                TimeoutLayer::new()
                    .with_timeout(std::time::Duration::from_secs(30))
                    .with_io_timeout(std::time::Duration::from_secs(60)),
            )
            .finish();
        Ok(Self {
            limits: Arc::new(TransferLimits::default()),
            namespace: format!(
                "s3:{}:{}",
                config
                    .endpoint
                    .as_deref()
                    .unwrap_or("https://s3.amazonaws.com")
                    .trim_end_matches('/')
                    .to_lowercase(),
                bucket
            ),
            prefix,
            volume_id: volume.id,
            read_only: volume.read_only,
            operator,
        })
    }

    async fn list_checked(
        &self,
        parent: &StorageLocator,
        strict: bool,
    ) -> StorageResult<Vec<StorageEntry>> {
        let path = self.path(parent, false)?;
        let prefix = if path.is_empty() {
            path
        } else {
            format!("{path}/")
        };
        let entries = self.operator.list(&prefix).await.map_err(error)?;
        let mut result = Vec::new();
        let mut paths = std::collections::HashSet::new();
        for entry in entries {
            let key = entry.path().strip_suffix('/').unwrap_or(entry.path());
            if key == prefix.trim_end_matches('/') {
                continue;
            }
            // Never alias a non-portable S3 key to another object through normalization.
            if !normalize_path(key).is_ok_and(|normalized| normalized == key) {
                if strict {
                    return Err(StorageError::new(
                        StorageErrorCode::Unsupported,
                        "文件夹包含不支持的 S3 对象名称，操作已停止",
                    ));
                }
                continue;
            }
            if !paths.insert(key.to_owned()) {
                return Err(StorageError::new(
                    StorageErrorCode::Unsupported,
                    "此 Prefix 包含同名文件和目录，需在 S3 控制台整理后浏览",
                ));
            }
            result.push(self.entry(entry.path(), entry.metadata()));
        }
        Ok(result)
    }

    pub async fn test_connection(&self) -> StorageResult<()> {
        // List within the configured bucket/prefix, never ListBuckets or synthetic root stat.
        use futures::TryStreamExt;
        self.operator
            .lister_with("")
            .limit(1)
            .await
            .map_err(error)?
            .try_next()
            .await
            .map_err(error)?;
        Ok(())
    }

    fn path(&self, locator: &StorageLocator, write: bool) -> StorageResult<String> {
        if locator.volume_id != self.volume_id || locator.version_id.is_some() {
            return Err(StorageError::new(
                StorageErrorCode::InvalidPath,
                "无效的存储位置或不支持的对象版本",
            ));
        }
        let path = normalize_path(&locator.logical_path)?;
        if write && (self.read_only || path.is_empty()) {
            return Err(StorageError::new(
                StorageErrorCode::AccessDenied,
                "只读位置或存储根目录不能修改",
            ));
        }
        Ok(path)
    }

    fn entry(&self, path: &str, metadata: &Metadata) -> StorageEntry {
        let path = path.trim_end_matches('/');
        let directory = metadata.is_dir();
        StorageEntry {
            locator: StorageLocator {
                volume_id: self.volume_id,
                logical_path: path.into(),
                version_id: None,
            },
            name: path.rsplit('/').next().unwrap_or_default().into(),
            kind: if directory {
                StorageEntryKind::VirtualPrefix
            } else {
                StorageEntryKind::File
            },
            size: (!directory).then(|| metadata.content_length()),
            modified_at: metadata.last_modified().map(|v| v.to_string()),
            etag: metadata.etag().map(str::to_owned),
            content_type: metadata.content_type().map(str::to_owned),
            metadata: serde_json::json!({}),
        }
    }

    async fn absent(&self, path: &str) -> StorageResult<()> {
        if self.operator.exists(path).await.map_err(error)?
            || self
                .operator
                .exists(&format!("{path}/"))
                .await
                .map_err(error)?
        {
            return Err(StorageError::new(
                StorageErrorCode::AlreadyExists,
                "同名项目已存在",
            ));
        }
        Ok(())
    }
}

#[async_trait::async_trait]
impl StorageBackend for OpenDalS3Backend {
    fn is_remote(&self) -> bool {
        true
    }
    fn volume_id(&self) -> Uuid {
        self.volume_id
    }
    fn capabilities(&self) -> StorageCapabilities {
        StorageCapabilities::s3(self.read_only)
    }
    fn storage_path(&self, locator: &StorageLocator) -> Option<(String, String)> {
        Some((
            self.namespace.clone(),
            format!("{}/{}", self.prefix, locator.logical_path)
                .trim_start_matches('/')
                .into(),
        ))
    }
    async fn open_listing(
        &self,
        parent: &StorageLocator,
    ) -> StorageResult<Box<dyn storage_provider_api::DirectoryReader>> {
        self.directory_reader(parent).await
    }
    async fn list(&self, parent: &StorageLocator) -> StorageResult<Vec<StorageEntry>> {
        self.list_checked(parent, false).await
    }
    async fn list_for_mutation(&self, parent: &StorageLocator) -> StorageResult<Vec<StorageEntry>> {
        self.list_checked(parent, true).await
    }
    async fn stat(&self, locator: &StorageLocator) -> StorageResult<StorageEntry> {
        let path = self.path(locator, false)?;
        match self.operator.stat(&path).await {
            Ok(meta) => {
                if meta.is_file()
                    && self
                        .operator
                        .exists(&format!("{path}/"))
                        .await
                        .map_err(error)?
                {
                    return Err(StorageError::new(
                        StorageErrorCode::Unsupported,
                        "此名称同时对应文件与 Prefix，请先在 S3 控制台整理",
                    ));
                }
                Ok(self.entry(&path, &meta))
            }
            Err(e) if e.kind() == ErrorKind::NotFound && !path.is_empty() => {
                let meta = self
                    .operator
                    .stat(&format!("{path}/"))
                    .await
                    .map_err(error)?;
                Ok(self.entry(&path, &meta))
            }
            Err(e) => Err(error(e)),
        }
    }
    async fn create_dir(&self, locator: &StorageLocator) -> StorageResult<()> {
        let path = self.path(locator, true)?;
        self.absent(&path).await?;
        self.operator
            .create_dir(&format!("{path}/"))
            .await
            .map_err(error)
    }
    async fn delete(&self, locator: &StorageLocator) -> StorageResult<()> {
        let path = self.path(locator, true)?;
        let entry = self.stat(locator).await?;
        if entry.kind == StorageEntryKind::VirtualPrefix {
            if !self.list_for_mutation(locator).await?.is_empty() {
                return Err(StorageError::new(
                    StorageErrorCode::Unsupported,
                    "文件夹仍有内容，未删除该文件夹",
                ));
            }
            self.operator
                .delete(&format!("{path}/"))
                .await
                .map_err(error)
        } else {
            self.operator.delete(&path).await.map_err(error)
        }
    }
    async fn rename(&self, source: &StorageLocator, target: &StorageLocator) -> StorageResult<()> {
        let from = self.path(source, true)?;
        let to = self.path(target, true)?;
        if from == to {
            return Err(StorageError::new(
                StorageErrorCode::Conflict,
                "源对象和目标对象相同",
            ));
        }
        let before = self.stat(source).await?;
        if before.kind != StorageEntryKind::File {
            return Err(StorageError::new(
                StorageErrorCode::Unsupported,
                "暂不支持 Prefix 重命名",
            ));
        }
        self.absent(&to).await?;
        let original = digest(reader(&self.operator, &from, &self.limits).await?).await?;
        publish(
            &self.operator,
            &from,
            &to,
            before.size.unwrap_or(0),
            &self.limits,
        )
        .await?;
        if digest(reader(&self.operator, &to, &self.limits).await?).await? != original
            || self.stat(source).await?.etag != before.etag
        {
            return Err(StorageError::new(
                StorageErrorCode::Conflict,
                "目标已保存，但校验不一致或源对象已变化，源对象已保留",
            ));
        }
        self.operator.delete(&from).await.map_err(|e| {
            let mut e = error(e);
            e.message = format!("目标已保存，源对象未能删除：{}", e.message);
            e
        })
    }
    async fn open_read(&self, locator: &StorageLocator) -> StorageResult<StorageReader> {
        reader(&self.operator, &self.path(locator, false)?, &self.limits).await
    }
    async fn stage_replace(&self, expected: &StorageEntry) -> StorageResult<Box<dyn StagedWrite>> {
        self.prepare_write_mode(&expected.locator, Some(expected))
            .await
    }
    async fn stage_write(&self, locator: &StorageLocator) -> StorageResult<Box<dyn StagedWrite>> {
        OpenDalS3Backend::prepare_write(self, locator).await
    }
}
