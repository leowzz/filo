use provider_opendal::OpenDalLocalBackend;
use std::{path::PathBuf, sync::Arc};
use storage_domain::*;
use storage_provider_api::StorageBackend;
use storage_repository::Repository;
use tokio::sync::Mutex;
use uuid::Uuid;
mod file_operations;
mod operation_planner;
mod transfers;
pub use transfers::TransferObserver;

#[derive(serde::Serialize)]
pub struct VolumeView {
    #[serde(flatten)]
    pub volume: StorageVolume,
    pub capabilities: StorageCapabilities,
}

#[derive(Clone)]
pub struct StorageService {
    repository: Repository,
    mutation_lock: Arc<Mutex<()>>,
    transfers: Arc<Mutex<std::collections::HashMap<Uuid, transfers::ActiveTransfer>>>,
}

impl StorageService {
    pub fn new(repository: Repository) -> Self {
        Self {
            repository,
            mutation_lock: Arc::new(Mutex::new(())),
            transfers: Arc::new(Mutex::new(std::collections::HashMap::new())),
        }
    }

    pub async fn list_connections(&self) -> StorageResult<Vec<StorageConnection>> {
        self.repository.list_connections().await
    }

    pub async fn list_volumes(&self) -> StorageResult<Vec<VolumeView>> {
        Ok(self
            .repository
            .list_volumes()
            .await?
            .into_iter()
            .map(|volume| VolumeView {
                capabilities: StorageCapabilities::local(volume.read_only),
                volume,
            })
            .collect())
    }

    /// Called only with a path returned by the native dialog inside Rust.
    pub async fn add_selected_directory(
        &self,
        path: PathBuf,
        read_only: bool,
    ) -> StorageResult<StorageVolume> {
        let _guard = self.mutation_lock.lock().await;
        let root = tokio::fs::canonicalize(path)
            .await
            .map_err(|_| StorageError::new(StorageErrorCode::AccessDenied, "无法访问所选目录"))?;
        let probe = StorageVolume {
            id: Uuid::new_v4(),
            connection_id: Uuid::new_v4(),
            name: String::new(),
            root: VolumeRoot::Local {
                root_path: root.clone(),
            },
            read_only,
        };
        let backend = OpenDalLocalBackend::new(&probe).await?;
        backend
            .list(&StorageLocator {
                volume_id: probe.id,
                logical_path: String::new(),
                version_id: None,
            })
            .await?;
        self.repository.add_local(&root, read_only).await
    }

    async fn backend(&self, id: Uuid) -> StorageResult<Arc<dyn StorageBackend>> {
        let volume = self
            .repository
            .list_volumes()
            .await?
            .into_iter()
            .find(|v| v.id == id)
            .ok_or_else(|| StorageError::new(StorageErrorCode::NotFound, "未找到该存储空间"))?;
        Ok(Arc::new(OpenDalLocalBackend::new(&volume).await?))
    }

    /// selected_root, when present, comes only from a Rust native dialog.
    pub async fn update_local_storage(
        &self,
        id: Uuid,
        name: String,
        read_only: bool,
        selected_root: Option<PathBuf>,
    ) -> StorageResult<StorageVolume> {
        drop(self.idle_volume(id).await?);
        let _guard = self.mutation_lock.lock().await;
        let _transfers = self.idle_volume(id).await?;
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 100 || name.chars().any(char::is_control) {
            return Err(StorageError::new(
                StorageErrorCode::InvalidConfiguration,
                "连接名称须为 1–100 个字符，不能包含控制字符",
            ));
        }
        let mut volume = self
            .repository
            .list_volumes()
            .await?
            .into_iter()
            .find(|v| v.id == id)
            .ok_or_else(|| StorageError::new(StorageErrorCode::NotFound, "未找到该存储空间"))?;
        if !matches!(volume.root, VolumeRoot::Local { .. }) {
            return Err(StorageError::new(
                StorageErrorCode::Unsupported,
                "当前仅支持编辑本地连接",
            ));
        }
        volume.name = name.to_owned();
        volume.read_only = read_only;
        if let Some(path) = selected_root {
            let root = tokio::fs::canonicalize(path).await.map_err(|_| {
                StorageError::new(StorageErrorCode::AccessDenied, "无法访问所选目录")
            })?;
            volume.root = VolumeRoot::Local { root_path: root };
            let backend = OpenDalLocalBackend::new(&volume).await?;
            backend
                .list(&StorageLocator {
                    volume_id: id,
                    logical_path: String::new(),
                    version_id: None,
                })
                .await?;
        }
        self.repository.update_local(&volume).await?;
        Ok(volume)
    }

    pub async fn remove_local_storage(
        &self,
        volume_id: Uuid,
        confirmed: bool,
    ) -> StorageResult<()> {
        if !confirmed {
            return Err(StorageError::new(
                StorageErrorCode::Conflict,
                "请先确认移除位置",
            ));
        }
        drop(self.idle_volume(volume_id).await?);
        let _guard = self.mutation_lock.lock().await;
        let _transfers = self.idle_volume(volume_id).await?;
        self.repository.remove_local(volume_id).await
    }

    pub async fn list_entries(&self, parent: StorageLocator) -> StorageResult<Vec<StorageEntry>> {
        self.backend(parent.volume_id).await?.list(&parent).await
    }
    pub async fn stat_entry(&self, locator: StorageLocator) -> StorageResult<StorageEntry> {
        self.backend(locator.volume_id).await?.stat(&locator).await
    }
    pub async fn create_directory(
        &self,
        parent: StorageLocator,
        name: String,
    ) -> StorageResult<()> {
        let _guard = self.mutation_lock.lock().await;
        validate_name(&name)?;
        let path = normalize_path(&parent.logical_path)?;
        let target = StorageLocator {
            logical_path: if path.is_empty() {
                name
            } else {
                format!("{path}/{name}")
            },
            ..parent
        };
        self.backend(target.volume_id)
            .await?
            .create_dir(&target)
            .await
    }
    pub async fn rename_entry(&self, source: StorageLocator, name: String) -> StorageResult<()> {
        let _guard = self.mutation_lock.lock().await;
        validate_name(&name)?;
        let normalized = normalize_path(&source.logical_path)?;
        let target_path = match normalized.rsplit_once('/') {
            Some((parent, _)) => format!("{parent}/{name}"),
            None => name,
        };
        let target = StorageLocator {
            logical_path: target_path,
            ..source.clone()
        };
        // Explicit rename stays within one local volume; transfers use operation_planner.
        self.backend(source.volume_id)
            .await?
            .rename(&source, &target)
            .await
    }
    pub async fn delete_entry(
        &self,
        locator: StorageLocator,
        mode: DeleteMode,
        confirmed: bool,
    ) -> StorageResult<DeleteOutcome> {
        if !confirmed {
            return Err(StorageError::new(
                StorageErrorCode::Conflict,
                "请先确认删除",
            ));
        }
        let _guard = self.mutation_lock.lock().await;
        let backend = self.backend(locator.volume_id).await?;
        file_operations::delete(backend.as_ref(), &locator, mode).await
    }

    pub async fn open_entry(&self, locator: StorageLocator) -> StorageResult<()> {
        let _guard = self.mutation_lock.lock().await;
        self.backend(locator.volume_id).await?.open(&locator).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn removing_location_preserves_files_and_revokes_access() {
        let directory = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let database = tempfile::tempdir().unwrap();
        let database_path = database.path().join("test.sqlite");
        let repo = Repository::open(&database_path).await.unwrap();
        let service = StorageService::new(repo);
        std::fs::write(directory.path().join("keep.txt"), b"keep").unwrap();
        let volume = service
            .add_selected_directory(directory.path().to_path_buf(), true)
            .await
            .unwrap();
        let remaining = service
            .add_selected_directory(other.path().to_path_buf(), false)
            .await
            .unwrap();
        assert_eq!(
            service
                .remove_local_storage(volume.id, false)
                .await
                .unwrap_err()
                .code,
            StorageErrorCode::Conflict
        );
        assert_eq!(service.list_volumes().await.unwrap().len(), 2);
        service.remove_local_storage(volume.id, true).await.unwrap();
        assert_eq!(
            std::fs::read(directory.path().join("keep.txt")).unwrap(),
            b"keep"
        );
        assert_eq!(
            service
                .list_entries(StorageLocator {
                    volume_id: volume.id,
                    logical_path: String::new(),
                    version_id: None
                })
                .await
                .unwrap_err()
                .code,
            StorageErrorCode::NotFound
        );
        let reopened = Repository::open(&database_path).await.unwrap();
        assert_eq!(reopened.list_volumes().await.unwrap()[0].id, remaining.id);
        assert_eq!(reopened.list_connections().await.unwrap().len(), 1);
        assert_eq!(
            service
                .remove_local_storage(volume.id, true)
                .await
                .unwrap_err()
                .code,
            StorageErrorCode::NotFound
        );
        let added = service
            .add_selected_directory(directory.path().to_path_buf(), true)
            .await
            .unwrap();
        assert_ne!(added.id, volume.id);
    }

    #[tokio::test]
    async fn edited_read_only_is_enforced_by_subsequent_operations() {
        let directory = tempfile::tempdir().unwrap();
        let database = tempfile::tempdir().unwrap();
        let repo = Repository::open(&database.path().join("test.sqlite"))
            .await
            .unwrap();
        let service = StorageService::new(repo);
        let volume = service
            .add_selected_directory(directory.path().to_path_buf(), true)
            .await
            .unwrap();
        let parent = StorageLocator {
            volume_id: volume.id,
            logical_path: String::new(),
            version_id: None,
        };
        service
            .update_local_storage(volume.id, "可写目录".into(), false, None)
            .await
            .unwrap();
        service
            .create_directory(parent.clone(), "created".into())
            .await
            .unwrap();
        service
            .update_local_storage(volume.id, "只读目录".into(), true, None)
            .await
            .unwrap();
        assert_eq!(
            service
                .create_directory(parent.clone(), "blocked".into())
                .await
                .unwrap_err()
                .code,
            StorageErrorCode::AccessDenied
        );
        let folder = StorageLocator {
            logical_path: "created".into(),
            ..parent
        };
        assert_eq!(
            service
                .delete_entry(folder, DeleteMode::Default, true)
                .await
                .unwrap_err()
                .code,
            StorageErrorCode::AccessDenied
        );
        let view = service.list_volumes().await.unwrap().remove(0);
        assert_eq!(view.volume.name, "只读目录");
        assert!(!view.capabilities.create_directory && !view.capabilities.delete);
        assert!(service
            .update_local_storage(volume.id, "  ".into(), false, None)
            .await
            .is_err());
        assert!(service
            .update_local_storage(
                volume.id,
                "失败保存".into(),
                false,
                Some(directory.path().join("missing"))
            )
            .await
            .is_err());
        assert!(service.list_volumes().await.unwrap()[0].volume.read_only);
        assert_eq!(
            service
                .update_local_storage(Uuid::new_v4(), "未知".into(), false, None)
                .await
                .unwrap_err()
                .code,
            StorageErrorCode::NotFound
        );
    }

    #[tokio::test]
    async fn changing_root_switches_listing_without_moving_files() {
        let original = tempfile::tempdir().unwrap();
        let replacement = tempfile::tempdir().unwrap();
        let database = tempfile::tempdir().unwrap();
        std::fs::write(original.path().join("old.txt"), b"old").unwrap();
        std::fs::write(replacement.path().join("new.txt"), b"new").unwrap();
        let repo = Repository::open(&database.path().join("test.sqlite"))
            .await
            .unwrap();
        let service = StorageService::new(repo);
        let volume = service
            .add_selected_directory(original.path().to_path_buf(), true)
            .await
            .unwrap();
        let updated = service
            .update_local_storage(
                volume.id,
                "新目录".into(),
                true,
                Some(replacement.path().to_path_buf()),
            )
            .await
            .unwrap();
        assert_eq!(updated.id, volume.id);
        assert_eq!(updated.connection_id, volume.connection_id);
        let entries = service
            .list_entries(StorageLocator {
                volume_id: volume.id,
                logical_path: String::new(),
                version_id: None,
            })
            .await
            .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "new.txt");
        assert_eq!(
            std::fs::read(original.path().join("old.txt")).unwrap(),
            b"old"
        );
        assert!(!replacement.path().join("old.txt").exists());
    }

    #[tokio::test]
    async fn service_requires_confirmation_and_registered_volume() {
        let directory = tempfile::tempdir().unwrap();
        let database = tempfile::tempdir().unwrap();
        let repository = Repository::open(&database.path().join("test.sqlite"))
            .await
            .unwrap();
        let service = StorageService::new(repository);
        std::fs::write(directory.path().join("existing.txt"), b"keep").unwrap();
        let volume = service
            .add_selected_directory(directory.path().to_path_buf(), false)
            .await
            .unwrap();
        let locator = StorageLocator {
            volume_id: volume.id,
            logical_path: "existing.txt".into(),
            version_id: None,
        };
        assert_eq!(
            service
                .delete_entry(locator.clone(), DeleteMode::Default, false)
                .await
                .unwrap_err()
                .code,
            StorageErrorCode::Conflict
        );
        assert!(directory.path().join("existing.txt").exists());
        assert!(service
            .rename_entry(locator.clone(), "../escape".into())
            .await
            .is_err());
        let unknown = StorageLocator {
            volume_id: Uuid::new_v4(),
            ..locator.clone()
        };
        assert_eq!(
            service.stat_entry(unknown).await.unwrap_err().code,
            StorageErrorCode::NotFound
        );
        service
            .delete_entry(locator, DeleteMode::Permanent, true)
            .await
            .unwrap();
        assert!(!directory.path().join("existing.txt").exists());
    }
}
