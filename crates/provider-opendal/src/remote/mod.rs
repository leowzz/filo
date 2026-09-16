mod ftp;
mod sftp;
mod smb;

use async_trait::async_trait;
use storage_domain::*;
use storage_provider_api::{StagedWrite, StorageBackend, StorageReader};
use uuid::Uuid;

pub use ftp::FtpBackend;
use sftp::SftpBackend;
use smb::SmbBackend;

/// Dispatches the provider-independent storage contract to one connected
/// remote protocol implementation.
#[derive(Clone)]
enum RemoteBackendImpl {
    Ftp(FtpBackend),
    Sftp(SftpBackend),
    Smb(SmbBackend),
}

#[derive(Clone)]
pub struct RemoteBackend {
    backend: RemoteBackendImpl,
}

impl RemoteBackend {
    /// Create and authenticate a backend. SFTP and SMB connect during
    /// construction; FTP connects when an operation is requested.
    pub async fn new(
        volume: &StorageVolume,
        config: &RemoteConnectionConfig,
        credentials: &RemoteCredentials,
    ) -> StorageResult<Self> {
        let backend = match config.protocol {
            RemoteProtocol::Ftp | RemoteProtocol::Ftps => {
                RemoteBackendImpl::Ftp(FtpBackend::new(volume, config, credentials)?)
            }
            RemoteProtocol::Sftp => {
                RemoteBackendImpl::Sftp(SftpBackend::new(volume, config, credentials).await?)
            }
            RemoteProtocol::Smb => {
                RemoteBackendImpl::Smb(SmbBackend::new(volume, config, credentials).await?)
            }
        };
        Ok(Self { backend })
    }

    pub async fn test_connection(&self) -> StorageResult<()> {
        match &self.backend {
            RemoteBackendImpl::Ftp(backend) => backend.test_connection().await,
            RemoteBackendImpl::Sftp(backend) => backend.test_connection().await,
            RemoteBackendImpl::Smb(backend) => {
                let root = StorageLocator {
                    volume_id: backend.volume_id(),
                    logical_path: String::new(),
                    version_id: None,
                };
                backend.list(&root).await.map(|_| ())
            }
        }
    }
}

#[async_trait]
impl StorageBackend for RemoteBackend {
    fn is_remote(&self) -> bool {
        true
    }

    fn volume_id(&self) -> Uuid {
        match &self.backend {
            RemoteBackendImpl::Ftp(backend) => backend.volume_id(),
            RemoteBackendImpl::Sftp(backend) => backend.volume_id(),
            RemoteBackendImpl::Smb(backend) => backend.volume_id(),
        }
    }

    fn capabilities(&self) -> StorageCapabilities {
        match &self.backend {
            RemoteBackendImpl::Ftp(backend) => backend.capabilities(),
            RemoteBackendImpl::Sftp(backend) => backend.capabilities(),
            RemoteBackendImpl::Smb(backend) => backend.capabilities(),
        }
    }

    fn storage_path(&self, locator: &StorageLocator) -> Option<(String, String)> {
        match &self.backend {
            RemoteBackendImpl::Ftp(backend) => backend.storage_path(locator),
            RemoteBackendImpl::Sftp(backend) => backend.storage_path(locator),
            RemoteBackendImpl::Smb(backend) => backend.storage_path(locator),
        }
    }

    async fn list(&self, parent: &StorageLocator) -> StorageResult<Vec<StorageEntry>> {
        match &self.backend {
            RemoteBackendImpl::Ftp(backend) => backend.list(parent).await,
            RemoteBackendImpl::Sftp(backend) => backend.list(parent).await,
            RemoteBackendImpl::Smb(backend) => backend.list(parent).await,
        }
    }

    async fn list_for_mutation(&self, parent: &StorageLocator) -> StorageResult<Vec<StorageEntry>> {
        match &self.backend {
            RemoteBackendImpl::Ftp(backend) => backend.list_for_mutation(parent).await,
            RemoteBackendImpl::Sftp(backend) => backend.list_for_mutation(parent).await,
            RemoteBackendImpl::Smb(backend) => backend.list_for_mutation(parent).await,
        }
    }

    async fn stat(&self, locator: &StorageLocator) -> StorageResult<StorageEntry> {
        match &self.backend {
            RemoteBackendImpl::Ftp(backend) => backend.stat(locator).await,
            RemoteBackendImpl::Sftp(backend) => backend.stat(locator).await,
            RemoteBackendImpl::Smb(backend) => backend.stat(locator).await,
        }
    }

    async fn create_dir(&self, locator: &StorageLocator) -> StorageResult<()> {
        match &self.backend {
            RemoteBackendImpl::Ftp(backend) => backend.create_dir(locator).await,
            RemoteBackendImpl::Sftp(backend) => backend.create_dir(locator).await,
            RemoteBackendImpl::Smb(backend) => backend.create_dir(locator).await,
        }
    }

    async fn rename(&self, source: &StorageLocator, target: &StorageLocator) -> StorageResult<()> {
        match &self.backend {
            RemoteBackendImpl::Ftp(backend) => backend.rename(source, target).await,
            RemoteBackendImpl::Sftp(backend) => backend.rename(source, target).await,
            RemoteBackendImpl::Smb(backend) => backend.rename(source, target).await,
        }
    }

    async fn delete(&self, locator: &StorageLocator) -> StorageResult<()> {
        match &self.backend {
            RemoteBackendImpl::Ftp(backend) => backend.delete(locator).await,
            RemoteBackendImpl::Sftp(backend) => backend.delete(locator).await,
            RemoteBackendImpl::Smb(backend) => backend.delete(locator).await,
        }
    }

    async fn open_read(&self, locator: &StorageLocator) -> StorageResult<StorageReader> {
        match &self.backend {
            RemoteBackendImpl::Ftp(backend) => backend.open_read(locator).await,
            RemoteBackendImpl::Sftp(backend) => backend.open_read(locator).await,
            RemoteBackendImpl::Smb(backend) => backend.open_read(locator).await,
        }
    }

    async fn stage_write(&self, locator: &StorageLocator) -> StorageResult<Box<dyn StagedWrite>> {
        match &self.backend {
            RemoteBackendImpl::Ftp(backend) => backend.stage_write(locator).await,
            RemoteBackendImpl::Sftp(backend) => backend.stage_write(locator).await,
            RemoteBackendImpl::Smb(backend) => backend.stage_write(locator).await,
        }
    }

    async fn stage_replace(&self, expected: &StorageEntry) -> StorageResult<Box<dyn StagedWrite>> {
        match &self.backend {
            RemoteBackendImpl::Ftp(backend) => backend.stage_replace(expected).await,
            RemoteBackendImpl::Sftp(backend) => backend.stage_replace(expected).await,
            RemoteBackendImpl::Smb(backend) => backend.stage_replace(expected).await,
        }
    }
}

pub(crate) fn invalid(message: &str) -> StorageError {
    StorageError::new(StorageErrorCode::InvalidConfiguration, message)
}

pub(crate) fn denied(message: &str) -> StorageError {
    StorageError::new(StorageErrorCode::AccessDenied, message)
}

pub(crate) fn unsupported(message: &str) -> StorageError {
    StorageError::new(StorageErrorCode::Unsupported, message)
}

/// Remote roots are authority boundaries and may be absolute for FTP/SFTP.
/// Locator paths remain relative and are always normalized by the domain API.
pub(crate) fn normalize_remote_root(path: &str, protocol: RemoteProtocol) -> StorageResult<String> {
    if path.contains('\\') || path.contains('\0') || path.chars().any(char::is_control) {
        return Err(StorageError::new(
            StorageErrorCode::InvalidPath,
            "远程目录包含无效字符",
        ));
    }
    if matches!(protocol, RemoteProtocol::Smb) {
        return normalize_path(path);
    }
    let absolute = path.starts_with('/');
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                return Err(StorageError::new(
                    StorageErrorCode::InvalidPath,
                    "远程目录不能访问上级路径",
                ))
            }
            value => parts.push(value),
        }
    }
    let result = parts.join("/");
    if absolute {
        Ok(if result.is_empty() {
            "/".into()
        } else {
            format!("/{result}")
        })
    } else {
        Ok(result)
    }
}

pub(crate) fn locator_path(locator: &StorageLocator, volume_id: Uuid) -> StorageResult<String> {
    if locator.volume_id != volume_id || locator.version_id.is_some() {
        return Err(StorageError::new(
            StorageErrorCode::InvalidPath,
            "无效的远程存储位置",
        ));
    }
    normalize_path(&locator.logical_path)
}

pub(crate) fn join_root(root: &str, logical: &str) -> String {
    if logical.is_empty() {
        return if root.is_empty() {
            ".".into()
        } else {
            root.into()
        };
    }
    if root.is_empty() || root == "." {
        logical.into()
    } else if root == "/" {
        format!("/{logical}")
    } else {
        format!("{}/{}", root.trim_end_matches('/'), logical)
    }
}

pub(crate) fn child_path(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.into()
    } else {
        format!("{parent}/{name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_root_rejects_parent_and_absolute_smb_paths() {
        assert!(normalize_remote_root("/srv/data", RemoteProtocol::Sftp).is_ok());
        assert!(normalize_remote_root("../outside", RemoteProtocol::Sftp).is_err());
        assert!(normalize_remote_root("/share", RemoteProtocol::Smb).is_err());
    }

    #[test]
    fn remote_paths_keep_protocol_root_separate_from_logical_path() {
        assert_eq!(join_root("/srv/data", "a/b"), "/srv/data/a/b");
        assert_eq!(join_root("", "a/b"), "a/b");
        assert_eq!(join_root("/", "a"), "/a");
    }
}
