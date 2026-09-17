use crate::{file_operations, OpenDalLocalBackend, StorageService};
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
        let _guard = self.mutation_lock.write().await;
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
        self.rename_entry_with_policy(source, name, ConflictPolicy::Reject)
            .await
            .map(|_| ())
    }
    pub async fn rename_entry_with_policy(
        &self,
        source: StorageLocator,
        name: String,
        policy: ConflictPolicy,
    ) -> StorageResult<TransferState> {
        validate_name(&name)?;
        let normalized = normalize_path(&source.logical_path)?;
        if normalized.is_empty() {
            return Err(StorageError::new(
                StorageErrorCode::AccessDenied,
                "存储根目录不能重命名",
            ));
        }
        let target_path = match normalized.rsplit_once('/') {
            Some((parent, _)) => format!("{parent}/{name}"),
            None => name,
        };
        let target = StorageLocator {
            logical_path: target_path,
            ..source.clone()
        };
        let backend = self.backend(source.volume_id).await?;
        if backend.stat(&source).await?.kind == StorageEntryKind::VirtualPrefix
            || policy != ConflictPolicy::Reject
        {
            let (sender, receiver) = tokio::sync::oneshot::channel();
            let sender = std::sync::Mutex::new(Some(sender));
            self.start_transfer_with_policy(
                TransferKind::Move,
                source,
                target,
                policy,
                std::sync::Arc::new(move |job| {
                    if !job.state.active() {
                        if let Some(sender) = sender.lock().unwrap().take() {
                            let _ = sender.send(job);
                        }
                    }
                }),
            )
            .await?;
            let job = receiver.await.map_err(|_| {
                StorageError::new(StorageErrorCode::Internal, "重命名任务中断，请查看传输任务")
            })?;
            if !matches!(job.state, TransferState::Completed | TransferState::Skipped) {
                return Err(StorageError::new(
                    job.error_code.unwrap_or(StorageErrorCode::Io),
                    job.error_message.unwrap_or_else(|| "重命名未完成".into()),
                ));
            }
            return Ok(job.state);
        }
        let _guard = self.mutation_lock.write().await;
        self.backend(source.volume_id)
            .await?
            .rename(&source, &target)
            .await?;
        Ok(TransferState::Completed)
    }
    pub async fn delete_entry(
        &self,
        locator: StorageLocator,
        mode: DeleteMode,
        confirmed: bool,
    ) -> StorageResult<DeleteOutcome> {
        self.delete_entry_recursive(locator, mode, confirmed, false)
            .await
    }

    pub async fn delete_entry_recursive(
        &self,
        locator: StorageLocator,
        mode: DeleteMode,
        confirmed: bool,
        recursive: bool,
    ) -> StorageResult<DeleteOutcome> {
        if !confirmed {
            return Err(StorageError::new(
                StorageErrorCode::Conflict,
                "请先确认删除",
            ));
        }
        let _guard = self.mutation_lock.write().await;
        let backend = self.backend(locator.volume_id).await?;
        if recursive && (mode == DeleteMode::Permanent || !backend.capabilities().trash) {
            if !backend.capabilities().delete || normalize_path(&locator.logical_path)?.is_empty() {
                return Err(StorageError::new(
                    StorageErrorCode::AccessDenied,
                    "只读位置或存储根目录不能删除",
                ));
            }
            let entries = crate::tree::inventory(
                backend.as_ref(),
                &locator,
                &tokio_util::sync::CancellationToken::new(),
            )
            .await?;
            crate::tree::remove_inventory(backend.as_ref(), &entries)
                .await
                .map_err(|error| {
                    StorageError::new(
                        error.code,
                        format!(
                            "删除未全部完成，已删除的内容无法恢复，请刷新检查剩余项目：{}",
                            error.message
                        ),
                    )
                })?;
            return Ok(DeleteOutcome::PermanentlyDeleted);
        }
        file_operations::delete(backend.as_ref(), &locator, mode).await
    }

    pub async fn open_transfer_file(
        &self,
        job_id: uuid::Uuid,
        directory: bool,
    ) -> StorageResult<Option<String>> {
        let (volume, locator) = self.transfer_file_location(job_id).await?;
        OpenDalLocalBackend::new(&volume)
            .await?
            .open_transfer_path(&locator, directory)
            .await
    }

    pub(crate) async fn transfer_file_location(
        &self,
        job_id: uuid::Uuid,
    ) -> StorageResult<(StorageVolume, StorageLocator)> {
        let job = self
            .repository
            .list_transfers()
            .await?
            .into_iter()
            .find(|job| job.id == job_id && job.state == TransferState::Completed)
            .ok_or_else(|| {
                StorageError::new(StorageErrorCode::NotFound, "未找到已完成的传输记录")
            })?;
        let volumes = self.repository.list_volumes().await?;
        for locator in [&job.destination, &job.source] {
            let selected = self
                .repository
                .transfer_local_volume(locator.volume_id)
                .await?;
            let volume =
                selected.or_else(|| volumes.iter().find(|v| v.id == locator.volume_id).cloned());
            if let Some(volume) = volume.filter(|v| matches!(v.root, VolumeRoot::Local { .. })) {
                return Ok((volume, locator.clone()));
            }
        }
        Err(StorageError::new(
            StorageErrorCode::NotFound,
            "此旧传输记录未保存本地目录，请从文件管理器打开文件；重新下载后将保留位置",
        ))
    }

    pub async fn open_entry(&self, locator: StorageLocator) -> StorageResult<()> {
        let _guard = self.mutation_lock.write().await;
        self.backend(locator.volume_id).await?.open(&locator).await
    }
}
