use storage_domain::*;
use uuid::Uuid;

/// The first vertical slice. Streaming transfer methods are added with the transfer engine.
#[async_trait::async_trait]
pub trait StorageBackend: Send + Sync {
    fn volume_id(&self) -> Uuid;
    fn capabilities(&self) -> StorageCapabilities;
    async fn list(&self, parent: &StorageLocator) -> StorageResult<Vec<StorageEntry>>;
    async fn stat(&self, locator: &StorageLocator) -> StorageResult<StorageEntry>;
    async fn create_dir(&self, locator: &StorageLocator) -> StorageResult<()>;
    async fn rename(&self, source: &StorageLocator, target: &StorageLocator) -> StorageResult<()>;
    async fn delete(&self, locator: &StorageLocator) -> StorageResult<()>;
}
