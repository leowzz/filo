use std::pin::Pin;
use storage_domain::*;
use tokio::io::AsyncRead;
use uuid::Uuid;

pub type StorageReader = Pin<Box<dyn AsyncRead + Send + Unpin>>;

/// An unpublished write. Dropping it abandons the temporary file.
#[async_trait::async_trait]
pub trait StagedWrite: Send {
    async fn write(&mut self, bytes: &[u8]) -> StorageResult<()>;
    async fn reader(&mut self) -> StorageResult<StorageReader>;
    /// Publish atomically, rejecting an existing destination.
    async fn commit(self: Box<Self>) -> StorageResult<()>;
}

/// Provider-independent browsing, mutation and staged streaming operations.
#[async_trait::async_trait]
pub trait StorageBackend: Send + Sync {
    fn volume_id(&self) -> Uuid;
    fn capabilities(&self) -> StorageCapabilities;
    async fn list(&self, parent: &StorageLocator) -> StorageResult<Vec<StorageEntry>>;
    async fn stat(&self, locator: &StorageLocator) -> StorageResult<StorageEntry>;
    async fn create_dir(&self, locator: &StorageLocator) -> StorageResult<()>;
    async fn rename(&self, source: &StorageLocator, target: &StorageLocator) -> StorageResult<()>;
    async fn delete(&self, locator: &StorageLocator) -> StorageResult<()>;
    async fn open_read(&self, locator: &StorageLocator) -> StorageResult<StorageReader>;
    async fn stage_write(&self, locator: &StorageLocator) -> StorageResult<Box<dyn StagedWrite>>;
}
