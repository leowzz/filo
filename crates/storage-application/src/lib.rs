use provider_opendal::{OpenDalLocalBackend, OpenDalS3Backend};
use std::sync::Arc;
use storage_domain::*;
use storage_provider_api::StorageBackend;
use storage_repository::Repository;
use tokio::sync::Mutex;
use uuid::Uuid;
mod credentials;
mod entries;
mod file_operations;
mod s3;
mod volumes;
pub use credentials::{CredentialStore, SystemCredentialStore};
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
    credentials: Arc<dyn CredentialStore>,
    temporary_backends: Arc<Mutex<std::collections::HashMap<Uuid, Arc<dyn StorageBackend>>>>,
    transfers: Arc<Mutex<std::collections::HashMap<Uuid, transfers::ActiveTransfer>>>,
}

impl StorageService {
    pub fn new(repository: Repository) -> Self {
        Self::with_credentials(repository, Arc::new(SystemCredentialStore))
    }

    pub fn with_credentials(repository: Repository, credentials: Arc<dyn CredentialStore>) -> Self {
        Self {
            credentials,
            temporary_backends: Arc::new(Mutex::new(std::collections::HashMap::new())),
            repository,
            mutation_lock: Arc::new(Mutex::new(())),
            transfers: Arc::new(Mutex::new(std::collections::HashMap::new())),
        }
    }

    async fn backend(&self, id: Uuid) -> StorageResult<Arc<dyn StorageBackend>> {
        if let Some(backend) = self.temporary_backends.lock().await.get(&id).cloned() {
            return Ok(backend);
        }
        let volume = self
            .repository
            .list_volumes()
            .await?
            .into_iter()
            .find(|v| v.id == id)
            .ok_or_else(|| StorageError::new(StorageErrorCode::NotFound, "未找到该存储空间"))?;
        match &volume.root {
            VolumeRoot::Local { .. } => Ok(Arc::new(OpenDalLocalBackend::new(&volume).await?)),
            VolumeRoot::S3 { .. } => {
                let connection = self.connection(volume.connection_id).await?;
                let credentials = self
                    .load_credentials(connection.credential_ref.clone())
                    .await?;
                let config = serde_json::from_value(connection.config).map_err(|_| {
                    StorageError::new(StorageErrorCode::InvalidConfiguration, "S3 配置损坏")
                })?;
                Ok(Arc::new(OpenDalS3Backend::new(
                    &volume,
                    &config,
                    &credentials,
                )?))
            }
        }
    }
}
