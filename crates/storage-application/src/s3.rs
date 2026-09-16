use super::*;
use std::path::PathBuf;
use storage_provider_api::{StagedWrite, StorageReader};

/// A file picker authorizes one file, never all its siblings.
struct SelectedFileBackend {
    inner: OpenDalLocalBackend,
    path: String,
}

impl SelectedFileBackend {
    fn check(&self, locator: &StorageLocator) -> StorageResult<()> {
        if normalize_path(&locator.logical_path)? != self.path {
            return Err(StorageError::new(
                StorageErrorCode::AccessDenied,
                "只允许访问系统选择器选中的文件",
            ));
        }
        Ok(())
    }
    fn denied() -> StorageError {
        StorageError::new(
            StorageErrorCode::Unsupported,
            "临时文件授权仅用于上传或下载",
        )
    }
}
#[async_trait::async_trait]
impl StorageBackend for SelectedFileBackend {
    fn storage_path(&self, locator: &StorageLocator) -> Option<(String, String)> {
        self.inner.storage_path(locator)
    }
    fn volume_id(&self) -> Uuid {
        self.inner.volume_id()
    }
    fn capabilities(&self) -> StorageCapabilities {
        StorageCapabilities {
            delete: false,
            trash: false,
            native_open: false,
            create_directory: false,
            rename: RenameSemantics::Unsupported,
            ..self.inner.capabilities()
        }
    }
    async fn stat(&self, locator: &StorageLocator) -> StorageResult<StorageEntry> {
        self.check(locator)?;
        self.inner.stat(locator).await
    }
    async fn open_read(&self, locator: &StorageLocator) -> StorageResult<StorageReader> {
        self.check(locator)?;
        self.inner.open_read(locator).await
    }
    async fn stage_write(&self, locator: &StorageLocator) -> StorageResult<Box<dyn StagedWrite>> {
        self.check(locator)?;
        self.inner.stage_write(locator).await
    }
    async fn stage_replace(&self, expected: &StorageEntry) -> StorageResult<Box<dyn StagedWrite>> {
        self.check(&expected.locator)?;
        self.inner.stage_replace(expected).await
    }
    async fn list(&self, _: &StorageLocator) -> StorageResult<Vec<StorageEntry>> {
        Err(Self::denied())
    }
    async fn create_dir(&self, _: &StorageLocator) -> StorageResult<()> {
        Err(Self::denied())
    }
    async fn delete(&self, _: &StorageLocator) -> StorageResult<()> {
        Err(Self::denied())
    }
    async fn rename(&self, _: &StorageLocator, _: &StorageLocator) -> StorageResult<()> {
        Err(Self::denied())
    }
}

fn configuration(message: &str) -> StorageError {
    StorageError::new(StorageErrorCode::InvalidConfiguration, message)
}
impl StorageService {
    pub(super) async fn connection(&self, id: Uuid) -> StorageResult<StorageConnection> {
        self.repository
            .list_connections()
            .await?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| configuration("未找到连接配置"))
    }
    pub(super) async fn load_credentials(
        &self,
        reference: Option<String>,
    ) -> StorageResult<S3Credentials> {
        let reference =
            reference.ok_or_else(|| configuration("缺少凭据引用，请编辑连接重新保存"))?;
        let store = self.credentials.clone();
        tokio::task::spawn_blocking(move || store.get(&reference))
            .await
            .map_err(|_| configuration("凭据读取任务失败"))?
    }
    async fn store_credentials(
        &self,
        reference: String,
        credentials: S3Credentials,
    ) -> StorageResult<()> {
        let store = self.credentials.clone();
        tokio::task::spawn_blocking(move || store.set(&reference, &credentials))
            .await
            .map_err(|_| configuration("凭据保存任务失败"))?
    }
    async fn delete_credentials(&self, reference: String) -> StorageResult<()> {
        let store = self.credentials.clone();
        tokio::task::spawn_blocking(move || store.delete(&reference))
            .await
            .map_err(|_| configuration("凭据删除任务失败"))?
    }
    async fn prepare_s3(
        &self,
        id: Option<Uuid>,
        input: &S3StorageInput,
    ) -> StorageResult<(StorageVolume, S3Credentials)> {
        let name = input.name.trim();
        if name.is_empty() || name.chars().count() > 100 || name.chars().any(char::is_control) {
            return Err(configuration("连接名称须为 1–100 个字符，不能包含控制字符"));
        }
        let mut volume = if let Some(id) = id {
            self.repository
                .list_volumes()
                .await?
                .into_iter()
                .find(|v| v.id == id && matches!(v.root, VolumeRoot::S3 { .. }))
                .ok_or_else(|| configuration("未找到 S3 位置"))?
        } else {
            StorageVolume {
                id: Uuid::new_v4(),
                connection_id: Uuid::new_v4(),
                name: String::new(),
                root: VolumeRoot::S3 {
                    bucket: String::new(),
                    prefix: String::new(),
                },
                read_only: false,
            }
        };
        let credentials = if let Some(credentials) = &input.credentials {
            credentials.clone()
        } else if id.is_some() {
            self.load_credentials(self.connection(volume.connection_id).await?.credential_ref)
                .await?
        } else {
            return Err(configuration("请填写 S3 访问凭据"));
        };
        volume.name = name.into();
        volume.read_only = input.read_only;
        volume.root = VolumeRoot::S3 {
            bucket: input.bucket.trim().into(),
            prefix: normalize_path(&input.prefix)?,
        };
        Ok((volume, credentials))
    }
    pub async fn test_s3_connection(
        &self,
        id: Option<Uuid>,
        input: S3StorageInput,
    ) -> StorageResult<()> {
        let (volume, credentials) = self.prepare_s3(id, &input).await?;
        provider_opendal::S3Admin::new(&volume, &input.config, &credentials)?
            .test_connection()
            .await
    }
    pub async fn save_s3_storage(
        &self,
        id: Option<Uuid>,
        input: S3StorageInput,
    ) -> StorageResult<StorageVolume> {
        if let Some(id) = id {
            drop(self.idle_volume(id).await?);
        }
        let _guard = self.mutation_lock.write().await;
        let _transfers = if let Some(id) = id {
            Some(self.idle_volume(id).await?)
        } else {
            None
        };
        let (volume, credentials) = self.prepare_s3(id, &input).await?;
        provider_opendal::S3Admin::new(&volume, &input.config, &credentials)?
            .test_connection()
            .await?;
        let old_reference = if id.is_some() {
            self.connection(volume.connection_id).await?.credential_ref
        } else {
            None
        };
        // Use a new credential reference so a database failure never invalidates the old connection.
        let reference = Uuid::new_v4().to_string();
        self.store_credentials(reference.clone(), credentials)
            .await?;
        let connection = StorageConnection {
            id: volume.connection_id,
            name: volume.name.clone(),
            provider: ProviderKind::S3,
            config: serde_json::to_value(&input.config)
                .map_err(|_| configuration("配置序列化失败"))?,
            credential_ref: Some(reference.clone()),
            enabled: true,
        };
        if let Err(error) = self.repository.save_s3(&connection, &volume).await {
            let _ = self.delete_credentials(reference).await;
            return Err(error);
        }
        if let Some(old) = old_reference {
            let _ = self.delete_credentials(old).await;
        }
        Ok(volume)
    }
    pub(super) async fn remove_storage_configuration(&self, id: Uuid) -> StorageResult<()> {
        let volume = self
            .repository
            .list_volumes()
            .await?
            .into_iter()
            .find(|v| v.id == id)
            .ok_or_else(|| StorageError::new(StorageErrorCode::NotFound, "未找到该位置"))?;
        let connection = self.connection(volume.connection_id).await?;
        if let Some(reference) = connection.credential_ref {
            let credentials = self.load_credentials(Some(reference.clone())).await?;
            self.delete_credentials(reference.clone()).await?;
            if let Err(error) = self.repository.remove_local(id).await {
                self.store_credentials(reference, credentials).await?;
                return Err(error);
            }
            Ok(())
        } else {
            self.repository.remove_local(id).await
        }
    }

    /// `path` is authorized by a native file picker or drop event in the Tauri command.
    /// Its authorization expires with this task; it is never added as a saved location.
    pub async fn transfer_selected_file(
        &self,
        path: PathBuf,
        remote: StorageLocator,
        upload: bool,
        observer: TransferObserver,
    ) -> StorageResult<TransferJob> {
        self.transfer_selected_file_with_policy(
            path,
            remote,
            upload,
            ConflictPolicy::Reject,
            observer,
        )
        .await
    }
    pub async fn transfer_selected_file_with_policy(
        &self,
        path: PathBuf,
        remote: StorageLocator,
        upload: bool,
        policy: ConflictPolicy,
        observer: TransferObserver,
    ) -> StorageResult<TransferJob> {
        if !upload && policy == ConflictPolicy::Rename {
            return Err(configuration("下载自动改名请在保存窗口中选择新的文件名"));
        }
        let parent = path
            .parent()
            .ok_or_else(|| configuration("请选择本地文件"))?;
        let root = tokio::fs::canonicalize(parent)
            .await
            .map_err(|_| configuration("无法访问所选目录"))?;
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| configuration("文件名必须是有效 UTF-8"))?;
        validate_name(name)?;
        let volume = StorageVolume {
            id: Uuid::new_v4(),
            connection_id: Uuid::new_v4(),
            name: "所选本地文件".into(),
            root: VolumeRoot::Local { root_path: root },
            read_only: upload,
        };
        let local = StorageLocator {
            volume_id: volume.id,
            logical_path: name.into(),
            version_id: None,
        };
        let backend = Arc::new(SelectedFileBackend {
            inner: OpenDalLocalBackend::new(&volume).await?,
            path: name.into(),
        });
        let (source, destination) = if upload {
            let prefix = normalize_path(&remote.logical_path)?;
            (
                local,
                StorageLocator {
                    logical_path: if prefix.is_empty() {
                        name.into()
                    } else {
                        format!("{prefix}/{name}")
                    },
                    ..remote
                },
            )
        } else {
            (remote, local)
        };
        self.temporary_backends
            .lock()
            .await
            .insert(volume.id, backend);
        let result = self
            .start_transfer_with_policy(TransferKind::Copy, source, destination, policy, observer)
            .await;
        if result.is_err() {
            self.temporary_backends.lock().await.remove(&volume.id);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn selected_file_never_authorizes_siblings_or_directory_mutations() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("selected"), b"selected").unwrap();
        std::fs::write(dir.path().join("private"), b"private").unwrap();
        let volume = StorageVolume {
            id: Uuid::new_v4(),
            connection_id: Uuid::new_v4(),
            name: "selected".into(),
            root: VolumeRoot::Local {
                root_path: std::fs::canonicalize(dir.path()).unwrap(),
            },
            read_only: false,
        };
        let backend = SelectedFileBackend {
            inner: OpenDalLocalBackend::new(&volume).await.unwrap(),
            path: "selected".into(),
        };
        let selected = StorageLocator {
            volume_id: volume.id,
            logical_path: "selected".into(),
            version_id: None,
        };
        let sibling = StorageLocator {
            logical_path: "private".into(),
            ..selected.clone()
        };
        assert!(backend.stat(&selected).await.is_ok());
        assert!(backend.stat(&sibling).await.is_err());
        assert!(backend.open_read(&sibling).await.is_err());
        assert!(backend.stage_write(&sibling).await.is_err());
        assert!(backend.list(&selected).await.is_err());
        assert!(backend.delete(&selected).await.is_err());
        assert!(backend.rename(&selected, &sibling).await.is_err());
        assert!(!backend.capabilities().delete);
    }
}
