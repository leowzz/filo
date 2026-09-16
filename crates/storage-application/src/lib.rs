use provider_opendal::OpenDalLocalBackend;
use std::{path::PathBuf, sync::Arc};
use storage_domain::*;
use storage_provider_api::StorageBackend;
use storage_repository::Repository;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(serde::Serialize)]
pub struct VolumeView {
    #[serde(flatten)]
    pub volume: StorageVolume,
    pub capabilities: StorageCapabilities,
}

pub struct StorageService {
    repository: Repository,
    mutation_lock: Mutex<()>,
}

impl StorageService {
    pub fn new(repository: Repository) -> Self {
        Self {
            repository,
            mutation_lock: Mutex::new(()),
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
        // Local single-file rename is the only operation plan in this slice.
        self.backend(source.volume_id)
            .await?
            .rename(&source, &target)
            .await
    }
    pub async fn delete_entry(
        &self,
        locator: StorageLocator,
        confirmed: bool,
    ) -> StorageResult<()> {
        if !confirmed {
            return Err(StorageError::new(
                StorageErrorCode::Conflict,
                "请先确认删除",
            ));
        }
        let _guard = self.mutation_lock.lock().await;
        self.backend(locator.volume_id)
            .await?
            .delete(&locator)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
                .delete_entry(locator.clone(), false)
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
        service.delete_entry(locator, true).await.unwrap();
        assert!(!directory.path().join("existing.txt").exists());
    }
}
