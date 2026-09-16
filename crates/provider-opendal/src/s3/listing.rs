use super::*;
use futures::TryStreamExt;
use storage_provider_api::DirectoryReader;

struct S3Directory {
    backend: OpenDalS3Backend,
    parent: String,
    reader: opendal::Lister,
}

impl OpenDalS3Backend {
    pub(super) async fn directory_reader(
        &self,
        parent: &StorageLocator,
    ) -> StorageResult<Box<dyn DirectoryReader>> {
        let path = self.path(parent, false)?;
        let prefix = if path.is_empty() {
            String::new()
        } else {
            format!("{path}/")
        };
        let reader = self
            .operator
            .lister_with(&prefix)
            .limit(500)
            .await
            .map_err(error)?;
        Ok(Box::new(S3Directory {
            backend: self.clone(),
            parent: path,
            reader,
        }))
    }
}

#[async_trait::async_trait]
impl DirectoryReader for S3Directory {
    async fn next_batch(&mut self, limit: usize) -> StorageResult<Vec<StorageEntry>> {
        let mut entries = Vec::new();
        while entries.len() < limit.clamp(1, 500) {
            let Some(item) = self.reader.try_next().await.map_err(error)? else {
                break;
            };
            let path = item.path().strip_suffix('/').unwrap_or(item.path());
            if path == self.parent || !normalize_path(path).is_ok_and(|normal| normal == path) {
                continue;
            }
            entries.push(self.backend.entry(item.path(), item.metadata()));
        }
        Ok(entries)
    }
}
