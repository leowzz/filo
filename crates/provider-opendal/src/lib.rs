use std::path::{Path, PathBuf};

use opendal::{services::Fs, ErrorKind, Operator};
use storage_domain::*;
use storage_provider_api::StorageBackend;
use uuid::Uuid;

pub struct OpenDalLocalBackend {
    volume_id: Uuid,
    root: PathBuf,
    read_only: bool,
    operator: Operator,
}

fn io_error(error: std::io::Error) -> StorageError {
    let (code, message) = match error.kind() {
        std::io::ErrorKind::NotFound => (StorageErrorCode::NotFound, "目录或文件已不存在，请刷新"),
        std::io::ErrorKind::PermissionDenied => {
            (StorageErrorCode::AccessDenied, "没有权限访问该目录或文件")
        }
        std::io::ErrorKind::AlreadyExists => (StorageErrorCode::AlreadyExists, "同名项目已存在"),
        _ => (
            StorageErrorCode::Io,
            "文件系统操作失败，请检查目录和系统权限",
        ),
    };
    StorageError::new(code, message)
}

fn provider_error(error: opendal::Error) -> StorageError {
    let (code, message) = match error.kind() {
        ErrorKind::NotFound => (StorageErrorCode::NotFound, "目录或文件已不存在，请刷新"),
        ErrorKind::PermissionDenied => (StorageErrorCode::AccessDenied, "没有权限执行此操作"),
        ErrorKind::AlreadyExists => (StorageErrorCode::AlreadyExists, "同名项目已存在"),
        ErrorKind::Unsupported => (StorageErrorCode::Unsupported, "当前存储不支持此操作"),
        _ => (StorageErrorCode::Io, "存储操作失败，请刷新后重试"),
    };
    StorageError::new(code, message)
}

// OpenDAL's fs rename overwrites an existing destination. Use the OS no-replace
// primitive for this one operation so an external writer cannot defeat the preflight check.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn rename_no_replace(root: &Path, source: &str, target: &str) -> StorageResult<()> {
    use rustix::fs::{open, openat, renameat_with, Mode, OFlags, RenameFlags};
    fn parent_fd(root: &Path, logical: &str) -> StorageResult<(rustix::fd::OwnedFd, String)> {
        let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let mut fd = open(root, flags, Mode::empty()).map_err(|e| io_error(e.into()))?;
        let mut parts = logical.split('/').peekable();
        while let Some(part) = parts.next() {
            if parts.peek().is_none() {
                return Ok((fd, part.to_owned()));
            }
            fd = openat(&fd, part, flags, Mode::empty()).map_err(|e| io_error(e.into()))?;
        }
        Err(StorageError::new(
            StorageErrorCode::InvalidPath,
            "不能重命名存储根目录",
        ))
    }
    let (source_parent, source_name) = parent_fd(root, source)?;
    let (target_parent, target_name) = parent_fd(root, target)?;
    renameat_with(
        source_parent,
        source_name,
        target_parent,
        target_name,
        RenameFlags::NOREPLACE,
    )
    .map_err(|e| io_error(e.into()))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn rename_no_replace(_: &Path, _: &str, _: &str) -> StorageResult<()> {
    Err(StorageError::new(
        StorageErrorCode::Unsupported,
        "此平台暂未接入防覆盖重命名",
    ))
}

impl OpenDalLocalBackend {
    pub async fn new(volume: &StorageVolume) -> StorageResult<Self> {
        let VolumeRoot::Local { root_path } = &volume.root else {
            return Err(StorageError::new(
                StorageErrorCode::Unsupported,
                "当前版本仅支持本地文件系统",
            ));
        };
        let root = tokio::fs::canonicalize(root_path).await.map_err(io_error)?;
        // Saved roots are canonical: replacing a saved root with a symlink must not change authority.
        if root != *root_path || !tokio::fs::metadata(&root).await.map_err(io_error)?.is_dir() {
            return Err(StorageError::new(
                StorageErrorCode::InvalidPath,
                "存储根目录已变化，请重新添加",
            ));
        }
        let root_str = root.to_str().ok_or_else(|| {
            StorageError::new(StorageErrorCode::InvalidPath, "目录路径必须是有效的 UTF-8")
        })?;
        let operator = Operator::new(Fs::default().root(root_str))
            .map_err(provider_error)?
            .finish();
        Ok(Self {
            volume_id: volume.id,
            root,
            read_only: volume.read_only,
            operator,
        })
    }

    fn check_locator(&self, locator: &StorageLocator) -> StorageResult<String> {
        if locator.volume_id != self.volume_id || locator.version_id.is_some() {
            return Err(StorageError::new(
                StorageErrorCode::InvalidPath,
                "文件位置与当前存储空间不匹配",
            ));
        }
        normalize_path(&locator.logical_path)
    }

    /// Existing ancestors must be actual directories, never symlinks (including links inside the root).
    async fn checked_path(
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

    fn writable(&self, path: &str) -> StorageResult<()> {
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

    async fn require_absent(&self, logical: &str) -> StorageResult<()> {
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

    async fn entry(&self, logical: &str, path: &Path) -> StorageResult<StorageEntry> {
        let metadata = tokio::fs::symlink_metadata(path).await.map_err(io_error)?;
        let kind = if metadata.file_type().is_symlink() {
            StorageEntryKind::Symlink
        } else if metadata.is_dir() {
            StorageEntryKind::Directory
        } else if metadata.is_file() {
            StorageEntryKind::File
        } else {
            return Err(StorageError::new(
                StorageErrorCode::Unsupported,
                "不支持特殊设备文件",
            ));
        };
        let modified_at = metadata
            .modified()
            .ok()
            .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339());
        Ok(StorageEntry {
            locator: StorageLocator {
                volume_id: self.volume_id,
                logical_path: logical.to_owned(),
                version_id: None,
            },
            name: path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default(),
            kind,
            size: metadata.is_file().then_some(metadata.len()),
            modified_at,
            etag: None,
            content_type: None,
            metadata: serde_json::json!({}),
        })
    }
}

#[async_trait::async_trait]
impl StorageBackend for OpenDalLocalBackend {
    fn volume_id(&self) -> Uuid {
        self.volume_id
    }
    fn capabilities(&self) -> StorageCapabilities {
        StorageCapabilities::local(self.read_only)
    }

    async fn list(&self, parent: &StorageLocator) -> StorageResult<Vec<StorageEntry>> {
        let logical = self.check_locator(parent)?;
        let path = self.checked_path(&logical, false).await?;
        if !tokio::fs::metadata(path).await.map_err(io_error)?.is_dir() {
            return Err(StorageError::new(
                StorageErrorCode::InvalidPath,
                "该位置不是目录",
            ));
        }
        let prefix = if logical.is_empty() {
            "/".to_owned()
        } else {
            format!("{logical}/")
        };
        let mut entries = Vec::new();
        for item in self.operator.list(&prefix).await.map_err(provider_error)? {
            let item_path = normalize_path(item.path().trim_matches('/'))?;
            if item_path == logical {
                continue;
            }
            // Inspect the link itself; never follow it while listing.
            match self.entry(&item_path, &self.root.join(&item_path)).await {
                Ok(entry) => entries.push(entry),
                Err(e)
                    if matches!(
                        e.code,
                        StorageErrorCode::NotFound | StorageErrorCode::Unsupported
                    ) => {}
                Err(e) => return Err(e),
            }
        }
        entries.sort_by(|a, b| {
            let a_dir = a.kind == StorageEntryKind::Directory;
            let b_dir = b.kind == StorageEntryKind::Directory;
            b_dir
                .cmp(&a_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    }

    async fn stat(&self, locator: &StorageLocator) -> StorageResult<StorageEntry> {
        let logical = self.check_locator(locator)?;
        let path = self.checked_path(&logical, false).await?;
        self.entry(&logical, &path).await
    }

    async fn create_dir(&self, locator: &StorageLocator) -> StorageResult<()> {
        let logical = self.check_locator(locator)?;
        self.writable(&logical)?;
        self.require_absent(&logical).await?;
        self.operator
            .create_dir(&format!("{logical}/"))
            .await
            .map_err(provider_error)
    }

    async fn rename(&self, source: &StorageLocator, target: &StorageLocator) -> StorageResult<()> {
        let source_path = self.check_locator(source)?;
        let target_path = self.check_locator(target)?;
        self.writable(&source_path)?;
        self.writable(&target_path)?;
        self.checked_path(&source_path, false).await?;
        if self.stat(source).await?.kind != StorageEntryKind::File {
            return Err(StorageError::new(
                StorageErrorCode::Unsupported,
                "初版只支持重命名普通文件",
            ));
        }
        self.require_absent(&target_path).await?;
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || rename_no_replace(&root, &source_path, &target_path))
            .await
            .map_err(|_| StorageError::new(StorageErrorCode::Internal, "重命名任务意外中断"))?
    }

    async fn delete(&self, locator: &StorageLocator) -> StorageResult<()> {
        let logical = self.check_locator(locator)?;
        self.writable(&logical)?;
        self.checked_path(&logical, false).await?;
        let entry = self.stat(locator).await?;
        let path = if entry.kind == StorageEntryKind::Directory {
            if !self.list(locator).await?.is_empty() {
                return Err(StorageError::new(
                    StorageErrorCode::Unsupported,
                    "初版只允许删除空目录，请先移出目录内文件",
                ));
            }
            format!("{logical}/")
        } else {
            logical
        };
        self.operator.delete(&path).await.map_err(provider_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn atomic_rename_cannot_replace_a_target_created_after_preflight() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("source"), b"source").unwrap();
        // Simulate an external writer creating the target after the preflight check.
        std::fs::write(directory.path().join("target"), b"external").unwrap();
        assert_eq!(
            rename_no_replace(directory.path(), "source", "target")
                .unwrap_err()
                .code,
            StorageErrorCode::AlreadyExists
        );
        assert_eq!(
            std::fs::read(directory.path().join("target")).unwrap(),
            b"external"
        );
        assert_eq!(
            std::fs::read(directory.path().join("source")).unwrap(),
            b"source"
        );
    }
    async fn fixture(read_only: bool) -> (tempfile::TempDir, OpenDalLocalBackend) {
        let dir = tempfile::tempdir().unwrap();
        let volume = StorageVolume {
            id: Uuid::new_v4(),
            connection_id: Uuid::new_v4(),
            name: "test".into(),
            root: VolumeRoot::Local {
                root_path: std::fs::canonicalize(dir.path()).unwrap(),
            },
            read_only,
        };
        let backend = OpenDalLocalBackend::new(&volume).await.unwrap();
        (dir, backend)
    }
    fn locator(backend: &OpenDalLocalBackend, path: &str) -> StorageLocator {
        StorageLocator {
            volume_id: backend.volume_id,
            logical_path: path.into(),
            version_id: None,
        }
    }
    #[tokio::test]
    async fn existing_files_and_mutations() {
        let (dir, backend) = fixture(false).await;
        std::fs::write(dir.path().join("original.txt"), b"hello existing file").unwrap();
        assert_eq!(backend.list(&locator(&backend, "")).await.unwrap().len(), 1);
        backend
            .create_dir(&locator(&backend, "folder"))
            .await
            .unwrap();
        backend
            .rename(
                &locator(&backend, "original.txt"),
                &locator(&backend, "renamed.txt"),
            )
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(dir.path().join("renamed.txt")).unwrap(),
            b"hello existing file"
        );
        backend
            .delete(&locator(&backend, "renamed.txt"))
            .await
            .unwrap();
        backend.delete(&locator(&backend, "folder")).await.unwrap();
        assert!(backend.delete(&locator(&backend, "")).await.is_err());
    }
    #[tokio::test]
    async fn rejects_overwrite_nonempty_delete_and_read_only() {
        let (dir, backend) = fixture(false).await;
        std::fs::write(dir.path().join("a"), b"a").unwrap();
        std::fs::write(dir.path().join("b"), b"b").unwrap();
        assert_eq!(
            backend
                .rename(&locator(&backend, "a"), &locator(&backend, "b"))
                .await
                .unwrap_err()
                .code,
            StorageErrorCode::AlreadyExists
        );
        std::fs::create_dir(dir.path().join("full")).unwrap();
        std::fs::write(dir.path().join("full/keep"), b"keep").unwrap();
        assert!(backend.delete(&locator(&backend, "full")).await.is_err());
        assert!(dir.path().join("full/keep").exists());
        let (read_dir, read_backend) = fixture(true).await;
        std::fs::write(read_dir.path().join("keep"), b"keep").unwrap();
        assert!(read_backend
            .delete(&locator(&read_backend, "keep"))
            .await
            .is_err());
        assert!(read_backend
            .create_dir(&locator(&read_backend, "new"))
            .await
            .is_err());
        assert!(read_backend
            .rename(
                &locator(&read_backend, "keep"),
                &locator(&read_backend, "new")
            )
            .await
            .is_err());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symlinks_and_path_escape() {
        let (dir, backend) = fixture(false).await;
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), b"secret").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escape")).unwrap();
        for path in ["../secret", "/etc/passwd", "escape/secret", "escape"] {
            assert!(backend.stat(&locator(&backend, path)).await.is_err());
            assert!(backend.delete(&locator(&backend, path)).await.is_err());
        }
        assert!(backend
            .create_dir(&locator(&backend, "escape/new"))
            .await
            .is_err());
        assert!(backend.list(&locator(&backend, "escape")).await.is_err());
        assert_eq!(
            backend.list(&locator(&backend, "")).await.unwrap()[0].kind,
            StorageEntryKind::Symlink
        );
        assert!(outside.path().join("secret").exists());
    }
}
