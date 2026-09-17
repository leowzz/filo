use provider_opendal::{OpenDalLocalBackend, OpenDalS3Backend, RemoteBackend};
use std::sync::Arc;
use storage_domain::*;
use storage_provider_api::{StorageBackend, TransferLimits};
use storage_repository::Repository;
use tokio::sync::{Mutex, OnceCell, RwLock};
use uuid::Uuid;
mod browsing;
mod credentials;
mod errors;
pub use errors::catch_panic;
mod entries;
mod file_operations;
mod listing;
mod remote;
mod s3;
mod s3_admin;
mod volumes;
pub use credentials::{CredentialStore, SystemCredentialStore};
mod operation_planner;
mod transfers;
mod tree;
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
    listings: Arc<listing::Listings>,
    preview_slots: Arc<tokio::sync::Semaphore>,
    thumbnail_slots: Arc<tokio::sync::Semaphore>,
    searches: Arc<Mutex<std::collections::HashMap<Uuid, browsing::SearchTask>>>,
    mutation_lock: Arc<RwLock<()>>,
    transfer_scheduler: Arc<transfers::scheduler::TransferScheduler>,
    transfer_limits: Arc<OnceCell<Arc<TransferLimits>>>,
    settings_lock: Arc<Mutex<()>>,
    credentials: Arc<dyn CredentialStore>,
    selected_volumes: Arc<Mutex<std::collections::HashMap<Uuid, StorageVolume>>>,
    temporary_backends: Arc<Mutex<std::collections::HashMap<Uuid, Arc<dyn StorageBackend>>>>,
    transfers: Arc<Mutex<std::collections::HashMap<Uuid, transfers::ActiveTransfer>>>,
}

impl StorageService {
    pub fn new(repository: Repository) -> Self {
        Self::with_credentials(repository, Arc::new(SystemCredentialStore))
    }

    pub fn with_credentials(repository: Repository, credentials: Arc<dyn CredentialStore>) -> Self {
        Self {
            credentials: Arc::new(credentials::CachedCredentialStore::new(credentials)),
            listings: Arc::new(listing::Listings::default()),
            // Reserve capacity for interactive previews while thumbnails load.
            preview_slots: Arc::new(tokio::sync::Semaphore::new(2)),
            thumbnail_slots: Arc::new(tokio::sync::Semaphore::new(1)),
            searches: Arc::new(Mutex::new(std::collections::HashMap::new())),
            selected_volumes: Arc::new(Mutex::new(std::collections::HashMap::new())),
            temporary_backends: Arc::new(Mutex::new(std::collections::HashMap::new())),
            repository,
            mutation_lock: Arc::new(RwLock::new(())),
            transfer_scheduler: Arc::new(transfers::scheduler::TransferScheduler::default()),
            transfer_limits: Arc::new(OnceCell::new()),
            settings_lock: Arc::new(Mutex::new(())),
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
                Ok(Arc::new(
                    OpenDalS3Backend::new(&volume, &config, &credentials)?
                        .with_transfer_limits(self.transfer_limits().await?),
                ))
            }
            VolumeRoot::Remote { .. } => {
                let connection = self.connection(volume.connection_id).await?;
                if connection.provider != ProviderKind::Remote {
                    return Err(StorageError::new(
                        StorageErrorCode::InvalidConfiguration,
                        "远程位置缺少匹配的连接配置",
                    ));
                }
                let config: RemoteConnectionConfig = serde_json::from_value(connection.config)
                    .map_err(|_| {
                        StorageError::new(
                            StorageErrorCode::InvalidConfiguration,
                            "远程连接配置损坏",
                        )
                    })?;
                let reference = connection.credential_ref.clone().ok_or_else(|| {
                    StorageError::new(
                        StorageErrorCode::InvalidConfiguration,
                        "缺少远程凭据引用，请编辑连接重新保存",
                    )
                })?;
                if !credentials::is_remote_reference(&reference) {
                    return Err(StorageError::new(
                        StorageErrorCode::InvalidConfiguration,
                        "远程凭据引用格式无效，请编辑连接重新保存",
                    ));
                }
                let packed = self.load_credentials(Some(reference)).await?;
                let credentials = credentials::unpack_remote_credentials(&packed)?;
                Ok(Arc::new(
                    RemoteBackend::new(&volume, &config, &credentials).await?,
                ))
            }
        }
    }

    async fn transfer_limits(&self) -> StorageResult<Arc<TransferLimits>> {
        self.transfer_limits
            .get_or_try_init(|| async {
                let limits = Arc::new(TransferLimits::default());
                limits.update(self.repository.transfer_settings().await?);
                Ok(limits)
            })
            .await
            .cloned()
    }

    pub async fn transfer_settings(&self) -> StorageResult<TransferSettings> {
        self.repository.transfer_settings().await
    }

    pub async fn save_transfer_settings(
        &self,
        settings: TransferSettings,
    ) -> StorageResult<TransferSettings> {
        settings.validate()?;
        let _guard = self.settings_lock.lock().await;
        let limits = self.transfer_limits().await?;
        self.repository.save_transfer_settings(settings).await?;
        limits.update(settings);
        Ok(settings)
    }
}
