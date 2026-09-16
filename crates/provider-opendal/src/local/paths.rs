use super::{io_error, OpenDalLocalBackend};
use std::path::PathBuf;
use storage_domain::*;

impl OpenDalLocalBackend {
    pub(super) fn check_locator(&self, locator: &StorageLocator) -> StorageResult<String> {
        if locator.volume_id != self.volume_id || locator.version_id.is_some() {
            return Err(StorageError::new(
                StorageErrorCode::InvalidPath,
                "文件位置与当前存储空间不匹配",
            ));
        }
        normalize_path(&locator.logical_path)
    }

    /// Existing ancestors must be actual directories, never symlinks (including links inside the root).
    pub(super) async fn checked_path(
        &self,
        logical: &str,
        allow_missing_leaf: bool,
    ) -> StorageResult<PathBuf> {
        let canonical_root = tokio::fs::canonicalize(&self.root)
            .await
            .map_err(io_error)?;
        if canonical_root != self.root {
            return Err(StorageError::new(
                StorageErrorCode::InvalidPath,
                "存储根目录已变化，请重新添加",
            ));
        }
        let mut current = self.root.clone();
        let parts: Vec<_> = logical.split('/').filter(|part| !part.is_empty()).collect();
        for (index, part) in parts.iter().enumerate() {
            current.push(part);
            match tokio::fs::symlink_metadata(&current).await {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink() {
                        return Err(StorageError::new(
                            StorageErrorCode::AccessDenied,
                            "初版不允许通过符号链接访问或修改文件",
                        ));
                    }
                    if index + 1 < parts.len() && !metadata.is_dir() {
                        return Err(StorageError::new(
                            StorageErrorCode::InvalidPath,
                            "父路径不是目录",
                        ));
                    }
                }
                Err(error)
                    if allow_missing_leaf
                        && index + 1 == parts.len()
                        && error.kind() == std::io::ErrorKind::NotFound =>
                {
                    return Ok(current)
                }
                Err(error) => return Err(io_error(error)),
            }
        }
        let canonical = tokio::fs::canonicalize(&current).await.map_err(io_error)?;
        if !canonical.starts_with(&self.root) {
            return Err(StorageError::new(
                StorageErrorCode::AccessDenied,
                "路径超出存储根目录",
            ));
        }
        Ok(current)
    }

    pub(super) fn writable(&self, path: &str) -> StorageResult<()> {
        if self.read_only {
            return Err(StorageError::new(
                StorageErrorCode::AccessDenied,
                "该存储空间为只读",
            ));
        }
        if path.is_empty() {
            return Err(StorageError::new(
                StorageErrorCode::InvalidPath,
                "不能修改存储根目录",
            ));
        }
        Ok(())
    }

    pub(super) async fn require_absent(&self, logical: &str) -> StorageResult<()> {
        let path = self.checked_path(logical, true).await?;
        match tokio::fs::symlink_metadata(path).await {
            Ok(_) => Err(StorageError::new(
                StorageErrorCode::AlreadyExists,
                "同名项目已存在，不会覆盖",
            )),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_error(e)),
        }
    }
}
