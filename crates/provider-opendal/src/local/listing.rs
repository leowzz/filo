use super::*;
use storage_provider_api::DirectoryReader;

struct LocalDirectory {
    backend: OpenDalLocalBackend,
    parent: String,
    reader: tokio::fs::ReadDir,
}

impl OpenDalLocalBackend {
    pub(super) async fn directory_reader(
        &self,
        parent: &StorageLocator,
    ) -> StorageResult<Box<dyn DirectoryReader>> {
        let logical = self.check_locator(parent)?;
        let path = self.checked_path(&logical, false).await?;
        Ok(Box::new(LocalDirectory {
            backend: self.clone(),
            parent: logical,
            reader: tokio::fs::read_dir(path).await.map_err(io_error)?,
        }))
    }
}

#[async_trait::async_trait]
impl DirectoryReader for LocalDirectory {
    async fn next_batch(&mut self, limit: usize) -> StorageResult<Vec<StorageEntry>> {
        let mut entries = Vec::new();
        while entries.len() < limit.clamp(1, 500) {
            let Some(item) = self.reader.next_entry().await.map_err(io_error)? else {
                break;
            };
            let Ok(name) = item.file_name().into_string() else {
                continue;
            };
            if validate_name(&name).is_err() {
                continue;
            }
            let path = if self.parent.is_empty() {
                name
            } else {
                format!("{}/{name}", self.parent)
            };
            match self.backend.entry(&path, &item.path()).await {
                Ok(entry) => entries.push(entry),
                Err(error)
                    if matches!(
                        error.code,
                        StorageErrorCode::NotFound | StorageErrorCode::Unsupported
                    ) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(entries)
    }
}
