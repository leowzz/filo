use std::pin::Pin;
use storage_domain::*;
use tokio::io::AsyncRead;
use uuid::Uuid;
mod rate_limit;
pub use rate_limit::{RateLimit, TransferLimits};

pub type StorageReader = Pin<Box<dyn AsyncRead + Send + Unpin>>;

#[async_trait::async_trait]
pub trait DirectoryReader: Send {
    /// Empty means exhausted. Implementations bound each batch and fetch lazily.
    async fn next_batch(&mut self, limit: usize) -> StorageResult<Vec<StorageEntry>>;
}

struct BufferedDirectory(std::collections::VecDeque<StorageEntry>);
#[async_trait::async_trait]
impl DirectoryReader for BufferedDirectory {
    async fn next_batch(&mut self, limit: usize) -> StorageResult<Vec<StorageEntry>> {
        Ok(self.0.drain(..limit.min(self.0.len())).collect())
    }
}

/// An unpublished write. Dropping it abandons the temporary file.
#[async_trait::async_trait]
pub trait StagedWrite: Send {
    /// True only when commit verifies the published bytes against a digest
    /// computed from every successful write, and fails on any mismatch.
    /// This avoids a second full remote read before publication.
    fn verifies_on_commit(&self) -> bool {
        false
    }
    async fn write(&mut self, bytes: &[u8]) -> StorageResult<()>;
    async fn reader(&mut self) -> StorageResult<StorageReader>;
    /// Publish atomically, rejecting an existing destination.
    async fn commit(self: Box<Self>) -> StorageResult<()>;
}

/// Provider-independent browsing, mutation and staged streaming operations.
#[async_trait::async_trait]
pub trait StorageBackend: Send + Sync {
    fn is_remote(&self) -> bool {
        false
    }
    fn volume_id(&self) -> Uuid;
    fn capabilities(&self) -> StorageCapabilities;
    async fn list(&self, parent: &StorageLocator) -> StorageResult<Vec<StorageEntry>>;
    async fn open_listing(
        &self,
        parent: &StorageLocator,
    ) -> StorageResult<Box<dyn DirectoryReader>> {
        Ok(Box::new(BufferedDirectory(self.list(parent).await?.into())))
    }
    /// Mutation traversal must never silently skip unsupported or disappearing entries.
    async fn list_for_mutation(&self, parent: &StorageLocator) -> StorageResult<Vec<StorageEntry>> {
        self.list(parent).await
    }
    /// Physical namespace and path, used to detect overlapping connected roots.
    fn storage_path(&self, _locator: &StorageLocator) -> Option<(String, String)> {
        None
    }
    async fn stat(&self, locator: &StorageLocator) -> StorageResult<StorageEntry>;
    async fn create_dir(&self, locator: &StorageLocator) -> StorageResult<()>;
    async fn rename(&self, source: &StorageLocator, target: &StorageLocator) -> StorageResult<()>;
    /// Permanent removal, also used for verified move source cleanup.
    async fn delete(&self, locator: &StorageLocator) -> StorageResult<()>;
    async fn trash(&self, _locator: &StorageLocator) -> StorageResult<()> {
        Err(StorageError::new(
            StorageErrorCode::Unsupported,
            "该存储不支持回收站",
        ))
    }
    async fn open(&self, _locator: &StorageLocator) -> StorageResult<()> {
        Err(StorageError::new(
            StorageErrorCode::Unsupported,
            "该存储不支持直接打开文件",
        ))
    }
    async fn open_read(&self, locator: &StorageLocator) -> StorageResult<StorageReader>;
    async fn stage_write(&self, locator: &StorageLocator) -> StorageResult<Box<dyn StagedWrite>>;
    /// Replace a known regular file only after the staged content has been verified.
    async fn stage_replace(&self, _expected: &StorageEntry) -> StorageResult<Box<dyn StagedWrite>> {
        Err(StorageError::new(
            StorageErrorCode::Unsupported,
            "该存储不支持覆盖文件",
        ))
    }
}
