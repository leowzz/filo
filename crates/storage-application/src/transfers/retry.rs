use super::{ActiveTransfer, StorageService, TransferObserver};
use storage_domain::*;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

impl StorageService {
    pub async fn retry_transfer(
        &self,
        id: Uuid,
        policy: ConflictPolicy,
        observer: TransferObserver,
    ) -> StorageResult<TransferJob> {
        if policy == ConflictPolicy::Skip {
            return Err(StorageError::new(
                StorageErrorCode::InvalidConfiguration,
                "继续传输需要校验已有内容，请选择保留、覆盖或自动改名",
            ));
        }
        let snapshot = self
            .repository
            .list_transfers()
            .await?
            .into_iter()
            .find(|job| job.id == id)
            .ok_or_else(|| StorageError::new(StorageErrorCode::NotFound, "未找到该传输任务"))?;
        if !matches!(
            snapshot.state,
            TransferState::Failed | TransferState::Interrupted
        ) {
            return Err(StorageError::new(
                StorageErrorCode::Conflict,
                "只能重试失败或已中断的任务",
            ));
        }
        // Resolve remote credentials before enqueueing, so the caller can unlock
        // or supply them. Native selections are restored with their path scope
        // inside execution instead of granting general access here.
        for locator in [&snapshot.source, &snapshot.destination] {
            if self
                .repository
                .transfer_local_volume(locator.volume_id)
                .await?
                .is_none()
            {
                self.backend(locator.volume_id).await?;
            }
        }
        // Claim the existing ID before publishing a new queued state. Concurrent
        // clicks must never start two executions of the same failed operation.
        let mut transfers = self.transfers.lock().await;
        if transfers.contains_key(&id) {
            return Err(StorageError::new(
                StorageErrorCode::Conflict,
                "该任务正在传输中",
            ));
        }
        let mut job = self
            .repository
            .list_transfers()
            .await?
            .into_iter()
            .find(|job| job.id == id)
            .ok_or_else(|| StorageError::new(StorageErrorCode::NotFound, "未找到该传输任务"))?;
        if job.updated_at != snapshot.updated_at {
            return Err(StorageError::new(
                StorageErrorCode::Conflict,
                "任务状态已更新，请刷新后重试",
            ));
        }
        if !matches!(
            job.state,
            TransferState::Failed | TransferState::Interrupted
        ) {
            return Err(StorageError::new(
                StorageErrorCode::Conflict,
                "只能重试失败或已中断的任务",
            ));
        }
        if policy == ConflictPolicy::Rename
            && self
                .repository
                .transfer_local_volume(job.destination.volume_id)
                .await?
                .is_some()
        {
            return Err(StorageError::new(
                StorageErrorCode::InvalidConfiguration,
                "下载只能继续写入原先选定的文件；如需改名，请重新选择保存位置",
            ));
        }
        if transfers.len() >= 100 {
            return Err(StorageError::new(
                StorageErrorCode::Conflict,
                "等待中的任务过多，请稍后再试",
            ));
        }
        job.state = TransferState::Queued;
        job.bytes_transferred = 0;
        job.error_code = None;
        job.error_message = None;
        job.updated_at = chrono::Utc::now().to_rfc3339();
        self.repository.save_transfer(&job).await?;
        let token = CancellationToken::new();
        transfers.insert(
            id,
            ActiveTransfer {
                token: token.clone(),
                source: job.source.volume_id,
                destination: job.destination.volume_id,
            },
        );
        drop(transfers);
        observer(job.clone());
        let service = self.clone();
        let queued = job.clone();
        tokio::spawn(async move {
            service
                .run_transfer_with_options(queued, token, observer, policy, None, true)
                .await;
        });
        Ok(job)
    }
}
