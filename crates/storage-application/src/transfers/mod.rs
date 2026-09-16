use crate::{operation_planner::plan, StorageService};
use std::sync::Arc;
use storage_domain::*;
use storage_provider_api::StorageBackend;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub type TransferObserver = Arc<dyn Fn(TransferJob) + Send + Sync>;
mod execution;
pub(crate) mod scheduler;

#[cfg(test)]
mod tests;

pub(super) struct ActiveTransfer {
    token: CancellationToken,
    source: Uuid,
    destination: Uuid,
}

fn cancelled() -> StorageError {
    StorageError::new(StorageErrorCode::Cancelled, "传输已取消，源文件保持不变")
}

impl StorageService {
    pub(super) async fn idle_volume(
        &self,
        volume_id: Uuid,
    ) -> StorageResult<tokio::sync::MutexGuard<'_, std::collections::HashMap<Uuid, ActiveTransfer>>>
    {
        let transfers = self.transfers.lock().await;
        if transfers
            .values()
            .any(|job| job.source == volume_id || job.destination == volume_id)
        {
            return Err(StorageError::new(
                StorageErrorCode::Conflict,
                "该位置还有传输任务，请等待完成或取消任务后再修改连接",
            ));
        }
        Ok(transfers)
    }
    pub async fn list_transfers(&self) -> StorageResult<Vec<TransferJob>> {
        self.repository.list_transfers().await
    }

    pub async fn cancel_transfer(&self, id: Uuid) -> StorageResult<()> {
        let transfers = self.transfers.lock().await;
        if let Some(job) = transfers.get(&id) {
            job.token.cancel();
        }
        Ok(())
    }

    pub async fn start_transfer(
        &self,
        kind: TransferKind,
        mut source: StorageLocator,
        mut destination: StorageLocator,
        observer: TransferObserver,
    ) -> StorageResult<TransferJob> {
        source.logical_path = normalize_path(&source.logical_path)?;
        destination.logical_path = normalize_path(&destination.logical_path)?;
        if source.logical_path.is_empty() || destination.logical_path.is_empty() {
            return Err(StorageError::new(
                StorageErrorCode::InvalidPath,
                "请选择文件或文件夹，并填写目标名称",
            ));
        }
        plan(kind, &source, &destination)?;
        let mut transfers = self.transfers.lock().await;
        if transfers.len() >= 100 {
            return Err(StorageError::new(
                StorageErrorCode::Conflict,
                "等待中的任务过多，请稍后再试",
            ));
        }
        // Queuing does not wait for an ongoing transfer's filesystem lock.
        // Configuration and permission checks are repeated when execution begins.
        let source_backend = self.backend(source.volume_id).await?;
        let destination_backend = self.backend(destination.volume_id).await?;
        let entry = source_backend.stat(&source).await?;
        crate::tree::check_overlap(
            source_backend.as_ref(),
            destination_backend.as_ref(),
            &source,
            &destination,
        )?;
        check_permissions(
            kind,
            &entry,
            source_backend.as_ref(),
            destination_backend.as_ref(),
        )?;
        let now = chrono::Utc::now().to_rfc3339();
        let job = TransferJob {
            id: Uuid::new_v4(),
            kind,
            source,
            destination,
            state: TransferState::Queued,
            bytes_total: entry.size,
            bytes_transferred: 0,
            error_code: None,
            error_message: None,
            created_at: now.clone(),
            updated_at: now,
        };
        let token = CancellationToken::new();
        self.repository.save_transfer(&job).await?;
        transfers.insert(
            job.id,
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
            service.run_transfer(queued, token, observer).await;
        });
        Ok(job)
    }

    async fn report(
        &self,
        job: &mut TransferJob,
        observer: &TransferObserver,
    ) -> StorageResult<()> {
        job.updated_at = chrono::Utc::now().to_rfc3339();
        self.repository.save_transfer(job).await?;
        observer(job.clone());
        Ok(())
    }

    async fn run_transfer(
        &self,
        mut job: TransferJob,
        token: CancellationToken,
        observer: TransferObserver,
    ) {
        // Shared mutation access allows independent transfers; ordinary mutations
        // retain exclusive access. Cancellation only interrupts preparation here:
        // execution owns its commit boundary and reports the actual outcome.
        let prepare = async {
            let guard = self.mutation_lock.read().await;
            let source = self.backend(job.source.volume_id).await?;
            let destination = self.backend(job.destination.volume_id).await?;
            let permit = self
                .transfer_scheduler
                .acquire(vec![
                    scheduler::Access::new(
                        source.as_ref(),
                        &job.source,
                        job.kind == TransferKind::Move,
                    ),
                    scheduler::Access::new(destination.as_ref(), &job.destination, true),
                ])
                .await;
            Ok::<_, StorageError>((guard, permit))
        };
        let prepared = tokio::select! {
            biased;
            _ = token.cancelled() => Err(cancelled()),
            result = prepare => result,
        };
        let result = match prepared {
            Ok((_guard, _permit)) => self.execute_transfer(&mut job, &token, &observer).await,
            Err(error) => Err(error),
        };
        match result {
            Ok(()) => job.state = TransferState::Completed,
            Err(error) => {
                job.state = if error.code == StorageErrorCode::Cancelled {
                    TransferState::Cancelled
                } else {
                    TransferState::Failed
                };
                job.error_code = Some(error.code);
                job.error_message = Some(error.message);
            }
        }
        self.transfers.lock().await.remove(&job.id);
        let mut temporary = self.temporary_backends.lock().await;
        temporary.remove(&job.source.volume_id);
        temporary.remove(&job.destination.volume_id);
        drop(temporary);
        // Always deliver the terminal event, even when persisting it fails.
        if let Err(error) = self.report(&mut job, &observer).await {
            job.error_message = Some(format!("{}；任务最终状态未能保存", error.message));
            observer(job.clone());
        }
    }
}

fn check_permissions(
    kind: TransferKind,
    entry: &StorageEntry,
    source: &dyn StorageBackend,
    destination: &dyn StorageBackend,
) -> StorageResult<()> {
    if entry.kind != StorageEntryKind::File && !crate::tree::directory(entry) {
        return Err(StorageError::new(
            StorageErrorCode::Unsupported,
            "仅支持普通文件和文件夹，符号链接不能传输",
        ));
    }
    if !destination.capabilities().write
        || (kind == TransferKind::Move && !source.capabilities().delete)
    {
        return Err(StorageError::new(
            StorageErrorCode::AccessDenied,
            "目标位置必须可写；移动时源位置也必须可写",
        ));
    }
    Ok(())
}
