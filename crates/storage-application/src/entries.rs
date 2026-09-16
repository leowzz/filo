use crate::{file_operations, StorageService};
use storage_domain::*;

impl StorageService {
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
        // Each provider preserves its advertised rename semantics and verifies remote copies.
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
