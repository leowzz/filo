use opendal::{layers::TimeoutLayer, services::S3, ErrorKind, Metadata, Operator, Writer};
use sha2::{Digest, Sha256};
use storage_domain::*;
use storage_provider_api::{StagedWrite, StorageBackend, StorageReader};
use tokio::io::AsyncReadExt;
use tokio_util::compat::FuturesAsyncReadCompatExt;
use uuid::Uuid;

pub struct OpenDalS3Backend {
    volume_id: Uuid,
    read_only: bool,
    operator: Operator,
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
            volume_id: volume.id,
            read_only: volume.read_only,
            operator,
        })
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

async fn reader(operator: &Operator, path: &str) -> StorageResult<StorageReader> {
    let meta = operator.stat(path).await.map_err(error)?;
    let mut read = operator.reader_with(path);
    if let Some(etag) = meta.etag() {
        read = read.if_match(etag);
    }
    Ok(Box::pin(
        read.await
            .map_err(error)?
            .into_futures_async_read(..)
            .await
            .map_err(error)?
            .compat(),
    ))
}
async fn digest(mut source: StorageReader) -> StorageResult<(u64, Vec<u8>)> {
    let mut hash = Sha256::new();
    let mut size = 0;
    let mut buffer = vec![0; 256 * 1024];
    loop {
        let n = source
            .read(&mut buffer)
            .await
            .map_err(|_| StorageError::new(StorageErrorCode::Network, "S3 内容校验读取失败"))?;
        if n == 0 {
            return Ok((size, hash.finalize().to_vec()));
        }
        size += n as u64;
        hash.update(&buffer[..n]);
    }
}

#[async_trait::async_trait]
impl StorageBackend for OpenDalS3Backend {
    fn volume_id(&self) -> Uuid {
        self.volume_id
    }
    fn capabilities(&self) -> StorageCapabilities {
        StorageCapabilities::s3(self.read_only)
    }
    async fn list(&self, parent: &StorageLocator) -> StorageResult<Vec<StorageEntry>> {
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
            let key = entry.path().trim_end_matches('/');
            if key == prefix.trim_end_matches('/') {
                continue;
            }
            // Never alias a non-portable S3 key to another object through normalization.
            if !normalize_path(key).is_ok_and(|normalized| normalized == key) {
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
            if !self.list(locator).await?.is_empty() {
                return Err(StorageError::new(
                    StorageErrorCode::Unsupported,
                    "暂不支持递归删除 S3 Prefix，请先清空目录",
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
        let original = digest(reader(&self.operator, &from).await?).await?;
        publish(&self.operator, &from, &to, before.size.unwrap_or(0)).await?;
        if digest(reader(&self.operator, &to).await?).await? != original
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
        reader(&self.operator, &self.path(locator, false)?).await
    }
    async fn stage_write(&self, locator: &StorageLocator) -> StorageResult<Box<dyn StagedWrite>> {
        let target = self.path(locator, true)?;
        self.absent(&target).await?;
        let parent = target
            .rsplit_once('/')
            .map(|(p, _)| format!("{p}/"))
            .unwrap_or_default();
        let temporary = format!("{parent}.filo-transfer-{}", Uuid::new_v4());
        let writer = self
            .operator
            .writer_with(&temporary)
            .chunk(8 * 1024 * 1024)
            .if_not_exists(true)
            .await
            .map_err(error)?;
        Ok(Box::new(S3StagedWrite {
            operator: self.operator.clone(),
            temporary,
            target,
            writer: Some(writer),
            size: 0,
        }))
    }
}

/// CopyObject is limited to 5 GiB. Larger files are streamed with conditional multipart completion.
async fn publish(operator: &Operator, from: &str, to: &str, size: u64) -> StorageResult<()> {
    if size <= 5 * 1024 * 1024 * 1024 {
        operator
            .copy_with(from, to)
            .if_not_exists(true)
            .await
            .map(|_| ())
            .map_err(error)
    } else {
        let mut source = reader(operator, from).await?;
        let mut target = operator
            .writer_with(to)
            .chunk(16 * 1024 * 1024)
            .if_not_exists(true)
            .await
            .map_err(error)?;
        let result = async {
            let mut buffer = vec![0; 256 * 1024];
            loop {
                let n = source.read(&mut buffer).await.map_err(|_| {
                    StorageError::new(
                        StorageErrorCode::Network,
                        "发布目标时读取失败，源对象已保留",
                    )
                })?;
                if n == 0 {
                    break;
                }
                target.write(buffer[..n].to_vec()).await.map_err(error)?;
            }
            target.close().await.map_err(error)?;
            Ok(())
        }
        .await;
        if result.is_err() {
            let _ = target.abort().await;
        }
        result
    }
}

struct S3StagedWrite {
    operator: Operator,
    temporary: String,
    target: String,
    writer: Option<Writer>,
    size: u64,
}
#[async_trait::async_trait]
impl StagedWrite for S3StagedWrite {
    async fn write(&mut self, bytes: &[u8]) -> StorageResult<()> {
        self.writer
            .as_mut()
            .ok_or_else(|| invalid("写入已经结束"))?
            .write(bytes.to_vec())
            .await
            .map_err(error)?;
        self.size += bytes.len() as u64;
        Ok(())
    }
    async fn reader(&mut self) -> StorageResult<StorageReader> {
        if let Some(writer) = self.writer.as_mut() {
            writer.close().await.map_err(error)?;
        }
        self.writer = None;
        reader(&self.operator, &self.temporary).await
    }
    async fn commit(mut self: Box<Self>) -> StorageResult<()> {
        let expected = digest(self.reader().await?).await?;
        publish(&self.operator, &self.temporary, &self.target, self.size).await?;
        let verified = digest(reader(&self.operator, &self.target).await?).await?;
        if expected != verified {
            return Err(StorageError::new(
                StorageErrorCode::Io,
                "目标已发布但内容校验失败，源文件已保留",
            ));
        }
        Ok(()) // Drop removes only this uniquely named temporary object.
    }
}
impl Drop for S3StagedWrite {
    fn drop(&mut self) {
        let operator = self.operator.clone();
        let temporary = self.temporary.clone();
        let writer = self.writer.take();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                if let Some(mut writer) = writer {
                    let _ = writer.abort().await;
                }
                let _ = operator.delete(&temporary).await;
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_credential_urls_and_preserves_volume_boundaries() {
        let volume = StorageVolume {
            id: Uuid::new_v4(),
            connection_id: Uuid::new_v4(),
            name: "test".into(),
            root: VolumeRoot::S3 {
                bucket: "bucket".into(),
                prefix: "allowed".into(),
            },
            read_only: true,
        };
        let credentials = S3Credentials {
            access_key_id: "access".into(),
            secret_access_key: "secret".into(),
            session_token: None,
        };
        let mut config = S3ConnectionConfig {
            endpoint: Some("http://127.0.0.1:9000".into()),
            region: "us-east-1".into(),
            force_path_style: true,
        };
        let backend = OpenDalS3Backend::new(&volume, &config, &credentials).unwrap();
        let locator = StorageLocator {
            volume_id: volume.id,
            logical_path: "folder/file".into(),
            version_id: None,
        };
        assert_eq!(backend.path(&locator, false).unwrap(), "folder/file");
        assert!(backend.path(&locator, true).is_err());
        assert!(backend
            .path(
                &StorageLocator {
                    volume_id: Uuid::new_v4(),
                    ..locator.clone()
                },
                false
            )
            .is_err());
        assert!(backend
            .path(
                &StorageLocator {
                    logical_path: "../escape".into(),
                    ..locator.clone()
                },
                false
            )
            .is_err());
        assert!(backend
            .path(
                &StorageLocator {
                    version_id: Some("version".into()),
                    ..locator
                },
                false
            )
            .is_err());
        for endpoint in [
            "file:///tmp",
            "https://user:secret@example.com",
            "https://example.com/bucket",
            "https://example.com/?key=secret",
        ] {
            config.endpoint = Some(endpoint.into());
            assert!(OpenDalS3Backend::new(&volume, &config, &credentials).is_err());
        }
        assert!(
            !backend.capabilities().write
                && !backend.capabilities().trash
                && !backend.capabilities().native_open
        );
    }
}
