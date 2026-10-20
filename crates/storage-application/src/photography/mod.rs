//! The photography journal owns identity, plans and review state; storage backends own I/O.
use crate::*;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use storage_provider_api::StorageReader;
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;
mod directory;
mod exporting;
mod importing;
mod metadata;
mod model;
mod planning;
mod review;
mod review_dates;
mod review_library;
mod review_scan;
mod sync;
mod xmp;
pub use model::*;

fn invalid(message: impl Into<String>) -> StorageError {
    StorageError::new(StorageErrorCode::InvalidConfiguration, message)
}
fn conflict(message: impl Into<String>) -> StorageError {
    StorageError::new(StorageErrorCode::Conflict, message)
}
fn io_error(_: std::io::Error) -> StorageError {
    StorageError::new(
        StorageErrorCode::Io,
        "无法读取照片，请检查存储卡或 NAS 连接",
    )
}
fn bytes_hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn child(root: &StorageLocator, path: &str) -> StorageResult<StorageLocator> {
    let path = normalize_path(path)?;
    Ok(StorageLocator {
        logical_path: normalize_path(
            format!("{}/{path}", root.logical_path).trim_start_matches('/'),
        )?,
        ..root.clone()
    })
}
fn file_target(archive: &PhotoArchive, file: &PhotoFile) -> StorageResult<StorageLocator> {
    child(
        if file.kind == PhotoFileKind::Jpg {
            &archive.jpg
        } else {
            &archive.raw
        },
        &file.path,
    )
}
async fn existing(
    backend: &dyn StorageBackend,
    path: &StorageLocator,
) -> StorageResult<Option<StorageEntry>> {
    match backend.stat(path).await {
        Ok(entry) => Ok(Some(entry)),
        Err(error) if error.code == StorageErrorCode::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}
async fn digest(
    mut reader: StorageReader,
    token: &CancellationToken,
) -> StorageResult<(u64, String)> {
    let mut hash = Sha256::new();
    let mut size = 0;
    let mut bytes = vec![0u8; 256 * 1024];
    loop {
        let count = tokio::select! { biased; _ = token.cancelled() => return Err(StorageError::new(StorageErrorCode::Cancelled, "导入已暂停，已完成的文件会保留")), result = reader.read(&mut bytes) => result.map_err(io_error)? };
        if count == 0 {
            break;
        }
        size += count as u64;
        hash.update(&bytes[..count]);
    }
    Ok((size, format!("{:x}", hash.finalize())))
}
async fn file_digest(
    backend: &dyn StorageBackend,
    entry: &StorageEntry,
    token: &CancellationToken,
) -> StorageResult<(u64, String)> {
    if entry.kind != StorageEntryKind::File {
        return Err(conflict("照片路径已被文件夹或链接占用"));
    }
    let result = digest(backend.open_read(&entry.locator).await?, token).await?;
    if entry.size != Some(result.0)
        || !crate::browsing::nef::same_file(entry, &backend.stat(&entry.locator).await?)
    {
        return Err(conflict("读取期间照片发生变化，请重新扫描"));
    }
    Ok(result)
}
async fn ensure_parent(backend: &dyn StorageBackend, target: &StorageLocator) -> StorageResult<()> {
    let parts: Vec<_> = target.logical_path.split('/').collect();
    for end in 1..parts.len() {
        let path = StorageLocator {
            logical_path: parts[..end].join("/"),
            ..target.clone()
        };
        match existing(backend, &path).await? {
            Some(entry) if crate::tree::directory(&entry) => {}
            Some(_) => return Err(conflict("目标目录被其他文件占用")),
            None => match backend.create_dir(&path).await {
                Ok(()) => {}
                Err(error) if error.code == StorageErrorCode::AlreadyExists => {
                    if !crate::tree::directory(&backend.stat(&path).await?) {
                        return Err(error);
                    }
                }
                Err(error) => return Err(error),
            },
        }
    }
    Ok(())
}
fn session_index(catalog: &PhotoCatalog, id: Uuid) -> StorageResult<usize> {
    catalog
        .sessions
        .iter()
        .position(|s| s.id == id)
        .ok_or_else(|| invalid("未找到此拍摄批次"))
}
fn archive_for(catalog: &PhotoCatalog, id: Uuid) -> StorageResult<&PhotoArchive> {
    catalog
        .archives
        .iter()
        .find(|a| a.id == id)
        .ok_or_else(|| invalid("此批次缺少归档位置，请重新关联目录"))
}
fn touch(catalog: &mut PhotoCatalog, photo: Uuid) {
    for session in &mut catalog.sessions {
        if session.photo_ids.contains(&photo) {
            session.revision += 1;
        }
    }
}

impl StorageService {
    /// A separate local journal and NAS namespace; no import records are read.
    pub fn photo_review_workspace(&self) -> Self {
        let mut service = self.clone();
        service.photo_review_workspace = true;
        service.photo_lock = self.photo_review_lock.clone();
        service.photo_sync_lock = self.photo_review_sync_lock.clone();
        service
    }
    fn manifest_directory(&self) -> &'static str {
        if self.photo_review_workspace {
            ".filo/reviews"
        } else {
            ".filo/sessions"
        }
    }
    pub async fn photo_paths(&self, session_id: Uuid) -> StorageResult<serde_json::Value> {
        let catalog = self.photo_catalog().await?;
        let session = &catalog.sessions[session_index(&catalog, session_id)?];
        let archive = archive_for(&catalog, session.archive_id)?;
        let (jpg, raw) = self.photo_archive_backends(archive).await?;
        let mut targets = BTreeMap::new();
        for file in catalog
            .photos
            .iter()
            .filter(|p| session.photo_ids.contains(&p.id))
            .flat_map(|p| &p.files)
        {
            let backend = if file.kind == PhotoFileKind::Jpg {
                jpg.as_ref()
            } else {
                raw.as_ref()
            };
            let target = file_target(archive, file)?;
            targets.insert(
                file.id.to_string(),
                backend
                    .storage_path(&target)
                    .map(|(_, path)| path)
                    .unwrap_or(target.logical_path),
            );
        }
        let source = match &session.source {
            Some(root) => self
                .backend(root.volume_id)
                .await?
                .storage_path(root)
                .map(|(_, path)| path),
            None => None,
        };
        Ok(serde_json::json!({"source_root": source, "targets": targets}))
    }
    pub async fn photo_has_active_imports(&self) -> bool {
        !self.photo_jobs.lock().await.is_empty()
    }
    pub async fn photo_catalog(&self) -> StorageResult<PhotoCatalog> {
        self.load_photos().await.map(|(_, catalog)| catalog)
    }
    async fn load_photos(&self) -> StorageResult<(i64, PhotoCatalog)> {
        let (revision, document) = if self.photo_review_workspace {
            self.repository.photo_review_catalog().await?
        } else {
            self.repository.photo_catalog().await?
        };
        let mut catalog: PhotoCatalog = serde_json::from_value(document)
            .map_err(|_| invalid("摄影记录无法读取，请保留本机数据库并重试"))?;
        for session in &mut catalog.sessions {
            session.undo.retain(|undo| undo.before != undo.after);
        }
        Ok((revision, catalog))
    }
    async fn save_photos(&self, revision: i64, catalog: &PhotoCatalog) -> StorageResult<()> {
        let mut directory_catalog;
        let catalog = if self.photo_review_workspace
            && catalog.sessions.iter().any(|s| s.directory.is_some())
        {
            directory_catalog = catalog.clone();
            self.save_directory_progress(&mut directory_catalog).await?;
            &directory_catalog
        } else {
            catalog
        };
        let value = serde_json::to_value(catalog).map_err(|_| invalid("摄影记录无法保存"))?;
        if self.photo_review_workspace {
            self.repository
                .save_photo_review_catalog(revision, value)
                .await
        } else {
            self.repository.save_photo_catalog(revision, value).await
        }
    }
    /// Resolve each root through the configured storage provider.
    async fn photo_archive_backends(
        &self,
        archive: &PhotoArchive,
    ) -> StorageResult<(Arc<dyn StorageBackend>, Arc<dyn StorageBackend>)> {
        Ok((
            self.backend(archive.jpg.volume_id).await?,
            self.backend(archive.raw.volume_id).await?,
        ))
    }
}

#[cfg(test)]
mod tests;
