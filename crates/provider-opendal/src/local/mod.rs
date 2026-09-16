use std::path::{Path, PathBuf};

use opendal::{services::Fs, ErrorKind, Operator};
use storage_domain::*;
use storage_provider_api::{StagedWrite, StorageBackend, StorageReader};
use uuid::Uuid;
mod listing;
mod paths;
mod rename;
mod staged_write;
use rename::rename_no_replace;

#[cfg(test)]
mod tests;

#[derive(Clone)]
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

impl OpenDalLocalBackend {
    async fn open_path(&self, locator: &StorageLocator) -> StorageResult<PathBuf> {
        let logical = self.check_locator(locator)?;
        let path = self.checked_path(&logical, false).await?;
        if self.stat(locator).await?.kind != StorageEntryKind::File {
            return Err(StorageError::new(
                StorageErrorCode::Unsupported,
                "请选择普通文件，文件夹请在 Filo 中打开",
            ));
        }
        Ok(path)
    }

    async fn trash_with(
        &self,
        locator: &StorageLocator,
        operation: impl FnOnce(PathBuf) -> StorageResult<()> + Send + 'static,
    ) -> StorageResult<()> {
        let logical = self.check_locator(locator)?;
        self.writable(&logical)?;
        let path = self.checked_path(&logical, false).await?;
        let kind = self.stat(locator).await?.kind;
        if !matches!(kind, StorageEntryKind::File | StorageEntryKind::Directory) {
            return Err(StorageError::new(
                StorageErrorCode::Unsupported,
                "此项目不支持移入回收站",
            ));
        }
        tokio::task::spawn_blocking(move || operation(path))
            .await
            .map_err(|_| StorageError::new(StorageErrorCode::Internal, "移入回收站任务意外中断"))?
    }

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

    fn storage_path(&self, locator: &StorageLocator) -> Option<(String, String)> {
        let path = self
            .root
            .join(&locator.logical_path)
            .to_string_lossy()
            .into_owned();
        // Conservatively protect aliases on the default case-insensitive macOS filesystem.
        Some((
            "local".into(),
            if cfg!(target_os = "macos") {
                path.to_lowercase()
            } else {
                path
            },
        ))
    }

    async fn list_for_mutation(&self, parent: &StorageLocator) -> StorageResult<Vec<StorageEntry>> {
        let logical = self.check_locator(parent)?;
        let path = self.checked_path(&logical, false).await?;
        let mut reader = tokio::fs::read_dir(path).await.map_err(io_error)?;
        let mut entries = Vec::new();
        while let Some(item) = reader.next_entry().await.map_err(io_error)? {
            let name = item.file_name().into_string().map_err(|_| {
                StorageError::new(
                    StorageErrorCode::Unsupported,
                    "文件夹包含无法识别的文件名，操作已停止",
                )
            })?;
            validate_name(&name)?;
            let child = if logical.is_empty() {
                name
            } else {
                format!("{logical}/{name}")
            };
            entries.push(self.entry(&child, &item.path()).await?);
        }
        Ok(entries)
    }

    async fn open(&self, locator: &StorageLocator) -> StorageResult<()> {
        let path = self.open_path(locator).await?;
        tokio::task::spawn_blocking(move || {
            open::that(path).map_err(|_| {
                StorageError::new(
                    StorageErrorCode::Io,
                    "无法使用系统默认应用打开文件，请检查文件关联和系统权限",
                )
            })
        })
        .await
        .map_err(|_| StorageError::new(StorageErrorCode::Internal, "打开文件任务意外中断"))?
    }

    async fn trash(&self, locator: &StorageLocator) -> StorageResult<()> {
        #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
        {
            self.trash_with(locator, |path| {
                #[cfg(target_os = "macos")]
                let context = {
                    use trash::macos::{DeleteMethod, TrashContextExtMacos};
                    let mut context = trash::TrashContext::new();
                    context.set_delete_method(DeleteMethod::NsFileManager);
                    context
                };
                #[cfg(not(target_os = "macos"))]
                let context = trash::TrashContext::new();
                context.delete(path).map_err(|_| {
                    StorageError::new(
                        StorageErrorCode::TrashUnavailable,
                        "无法移入系统回收站。继续删除将永久删除，无法找回；当前尚未执行永久删除",
                    )
                })
            })
            .await
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        {
            let _ = locator;
            Err(StorageError::new(
                StorageErrorCode::Unsupported,
                "当前平台暂不支持系统回收站",
            ))
        }
    }

    async fn open_read(&self, locator: &StorageLocator) -> StorageResult<StorageReader> {
        let logical = self.check_locator(locator)?;
        let path = self.checked_path(&logical, false).await?;
        if self.stat(locator).await?.kind != StorageEntryKind::File {
            return Err(StorageError::new(
                StorageErrorCode::Unsupported,
                "当前只支持传输普通文件",
            ));
        }
        Ok(Box::pin(
            tokio::fs::File::open(path).await.map_err(io_error)?,
        ))
    }

    async fn stage_write(&self, locator: &StorageLocator) -> StorageResult<Box<dyn StagedWrite>> {
        OpenDalLocalBackend::prepare_write(self, locator).await
    }

    async fn stage_replace(&self, expected: &StorageEntry) -> StorageResult<Box<dyn StagedWrite>> {
        self.prepare_write_mode(&expected.locator, Some(expected.clone()))
            .await
    }

    async fn open_listing(
        &self,
        parent: &StorageLocator,
    ) -> StorageResult<Box<dyn storage_provider_api::DirectoryReader>> {
        self.directory_reader(parent).await
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
        tokio::fs::create_dir(self.checked_path(&logical, true).await?)
            .await
            .map_err(io_error)
    }

    async fn rename(&self, source: &StorageLocator, target: &StorageLocator) -> StorageResult<()> {
        let source_path = self.check_locator(source)?;
        let target_path = self.check_locator(target)?;
        self.writable(&source_path)?;
        self.writable(&target_path)?;
        self.checked_path(&source_path, false).await?;
        if !matches!(
            self.stat(source).await?.kind,
            StorageEntryKind::File | StorageEntryKind::Directory
        ) {
            return Err(StorageError::new(
                StorageErrorCode::Unsupported,
                "仅支持重命名普通文件和文件夹",
            ));
        }
        if target_path.starts_with(&format!("{source_path}/")) {
            return Err(StorageError::new(
                StorageErrorCode::InvalidPath,
                "不能将文件夹移入自身内部",
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
            if !self.list_for_mutation(locator).await?.is_empty() {
                return Err(StorageError::new(
                    StorageErrorCode::Unsupported,
                    "文件夹仍有内容，未删除该文件夹",
                ));
            }
            format!("{logical}/")
        } else {
            logical
        };
        self.operator.delete(&path).await.map_err(provider_error)
    }
}
