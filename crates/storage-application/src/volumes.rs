use crate::{StorageService, VolumeView};
use provider_opendal::OpenDalLocalBackend;
use std::path::PathBuf;
use storage_domain::*;
use storage_provider_api::StorageBackend;
use uuid::Uuid;

impl StorageService {
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
                capabilities: match volume.root {
                    VolumeRoot::Local { .. } => StorageCapabilities::local(volume.read_only),
                    VolumeRoot::S3 { .. } => StorageCapabilities::s3(volume.read_only),
                },
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
        let _guard = self.mutation_lock.write().await;
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

    /// selected_root, when present, comes only from a Rust native dialog.
    pub async fn update_local_storage(
        &self,
        id: Uuid,
        name: String,
        read_only: bool,
        selected_root: Option<PathBuf>,
    ) -> StorageResult<StorageVolume> {
        drop(self.idle_volume(id).await?);
        let _guard = self.mutation_lock.write().await;
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
        let _guard = self.mutation_lock.write().await;
        let _transfers = self.idle_volume(volume_id).await?;
        self.remove_storage_configuration(volume_id).await
    }
}

#[cfg(test)]
mod tests;
