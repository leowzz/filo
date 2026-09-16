use super::{
    operation_planner::{plan, OperationPlan},
    StorageService,
};
use sha2::{Digest, Sha256};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use storage_domain::*;
use storage_provider_api::{StorageBackend, StorageReader};
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub type TransferObserver = Arc<dyn Fn(TransferJob) + Send + Sync>;
const BUFFER_SIZE: usize = 256 * 1024;

pub(super) struct ActiveTransfer {
    token: CancellationToken,
    source: Uuid,
    destination: Uuid,
}

fn cancelled() -> StorageError {
    StorageError::new(StorageErrorCode::Cancelled, "传输已取消，源文件保持不变")
}
fn io_error(_: std::io::Error) -> StorageError {
    StorageError::new(StorageErrorCode::Io, "无法读取文件，请检查存储和系统权限")
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
                "请选择普通文件和目标文件名",
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
        // Local writes remain serialized. Queued jobs can be cancelled immediately.
        let result = tokio::select! {
            biased;
            _ = token.cancelled() => Err(cancelled()),
            guard = self.mutation_lock.lock() => {
                let result = self.execute_transfer(&mut job, &token, &observer).await;
                drop(guard);
                result
            }
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
        // Always deliver the terminal event, even when persisting it fails.
        if let Err(error) = self.report(&mut job, &observer).await {
            job.error_message = Some(format!("{}；任务最终状态未能保存", error.message));
            observer(job.clone());
        }
    }

    async fn execute_transfer(
        &self,
        job: &mut TransferJob,
        token: &CancellationToken,
        observer: &TransferObserver,
    ) -> StorageResult<()> {
        if token.is_cancelled() {
            return Err(cancelled());
        }
        let source = self.backend(job.source.volume_id).await?;
        let destination = self.backend(job.destination.volume_id).await?;
        let before = source.stat(&job.source).await?;
        check_permissions(job.kind, &before, source.as_ref(), destination.as_ref())?;
        job.bytes_total = before.size;
        job.state = TransferState::Running;
        self.report(job, observer).await?;
        match plan(job.kind, &job.source, &job.destination)? {
            OperationPlan::NativeRename => {
                if token.is_cancelled() {
                    return Err(cancelled());
                }
                source.rename(&job.source, &job.destination).await?;
                job.bytes_transferred = before.size.unwrap_or(0);
            }
            OperationPlan::StreamCopy { delete_source } => {
                let mut reader = source.open_read(&job.source).await?;
                let mut writer = destination.stage_write(&job.destination).await?;
                let mut buffer = vec![0; BUFFER_SIZE];
                let mut hash = Sha256::new();
                let mut last_report = Instant::now();
                loop {
                    let count = tokio::select! { biased; _ = token.cancelled() => return Err(cancelled()), result = reader.read(&mut buffer) => result.map_err(io_error)? };
                    if count == 0 {
                        break;
                    }
                    tokio::select! { biased; _ = token.cancelled() => return Err(cancelled()), result = writer.write(&buffer[..count]) => result? };
                    hash.update(&buffer[..count]);
                    job.bytes_transferred += count as u64;
                    if last_report.elapsed() >= Duration::from_millis(150) {
                        self.report(job, observer).await?;
                        last_report = Instant::now();
                    }
                }
                drop(reader);
                unchanged(&before, &source.stat(&job.source).await?)?;
                if before.size != Some(job.bytes_transferred) {
                    return Err(StorageError::new(
                        StorageErrorCode::Conflict,
                        "复制期间源文件大小发生变化，请重试",
                    ));
                }
                job.state = TransferState::Verifying;
                self.report(job, observer).await?;
                let (size, target_hash) = digest(writer.reader().await?, token).await?;
                if size != job.bytes_transferred || hash.finalize().as_slice() != target_hash {
                    return Err(StorageError::new(
                        StorageErrorCode::Io,
                        "目标文件校验失败，源文件已保留",
                    ));
                }
                unchanged(&before, &source.stat(&job.source).await?)?;
                if token.is_cancelled() {
                    return Err(cancelled());
                }
                // Commit is the cancellation boundary. Once publication starts,
                // finish the operation and report its actual outcome.
                writer.commit().await?;
                if delete_source {
                    let after = source.stat(&job.source).await?;
                    if unchanged(&before, &after).is_err() {
                        return Err(StorageError::new(
                            StorageErrorCode::Conflict,
                            "目标已保存，但源文件发生变化，已保留源文件",
                        ));
                    }
                    source.delete(&job.source).await.map_err(|error| {
                        StorageError::new(
                            error.code,
                            format!("目标已保存，源文件未能删除：{}", error.message),
                        )
                    })?;
                }
            }
        }
        Ok(())
    }
}

fn check_permissions(
    kind: TransferKind,
    entry: &StorageEntry,
    source: &dyn StorageBackend,
    destination: &dyn StorageBackend,
) -> StorageResult<()> {
    if entry.kind != StorageEntryKind::File {
        return Err(StorageError::new(
            StorageErrorCode::Unsupported,
            "当前只支持普通文件，暂不支持文件夹递归传输",
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

fn unchanged(before: &StorageEntry, after: &StorageEntry) -> StorageResult<()> {
    if before.kind != after.kind
        || before.size != after.size
        || before.modified_at != after.modified_at
    {
        return Err(StorageError::new(
            StorageErrorCode::Conflict,
            "传输期间源文件发生变化，已保留源文件",
        ));
    }
    Ok(())
}

async fn digest(
    mut reader: StorageReader,
    token: &CancellationToken,
) -> StorageResult<(u64, Vec<u8>)> {
    let mut hash = Sha256::new();
    let mut buffer = vec![0; BUFFER_SIZE];
    let mut size = 0;
    loop {
        let count = tokio::select! { biased; _ = token.cancelled() => return Err(cancelled()), result = reader.read(&mut buffer) => result.map_err(io_error)? };
        if count == 0 {
            return Ok((size, hash.finalize().to_vec()));
        }
        size += count as u64;
        hash.update(&buffer[..count]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use storage_repository::Repository;

    struct Fixture {
        service: StorageService,
        source: tempfile::TempDir,
        destination: tempfile::TempDir,
        _database: tempfile::TempDir,
        source_id: Uuid,
        destination_id: Uuid,
    }
    impl Fixture {
        async fn new() -> Self {
            let source = tempfile::tempdir().unwrap();
            let destination = tempfile::tempdir().unwrap();
            let database = tempfile::tempdir().unwrap();
            let service = StorageService::new(
                Repository::open(&database.path().join("test.sqlite"))
                    .await
                    .unwrap(),
            );
            let source_id = service
                .add_selected_directory(source.path().to_path_buf(), false)
                .await
                .unwrap()
                .id;
            let destination_id = service
                .add_selected_directory(destination.path().to_path_buf(), false)
                .await
                .unwrap()
                .id;
            std::fs::write(
                source.path().join("source.bin"),
                vec![42; BUFFER_SIZE * 3 + 17],
            )
            .unwrap();
            Self {
                service,
                source,
                destination,
                _database: database,
                source_id,
                destination_id,
            }
        }
        fn job(&self, kind: TransferKind) -> TransferJob {
            let now = chrono::Utc::now().to_rfc3339();
            TransferJob {
                id: Uuid::new_v4(),
                kind,
                source: StorageLocator {
                    volume_id: self.source_id,
                    logical_path: "source.bin".into(),
                    version_id: None,
                },
                destination: StorageLocator {
                    volume_id: self.destination_id,
                    logical_path: "target.bin".into(),
                    version_id: None,
                },
                state: TransferState::Queued,
                bytes_total: None,
                bytes_transferred: 0,
                error_code: None,
                error_message: None,
                created_at: now.clone(),
                updated_at: now,
            }
        }
        async fn result(&self, id: Uuid) -> TransferJob {
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if let Some(job) = self
                        .service
                        .list_transfers()
                        .await
                        .unwrap()
                        .into_iter()
                        .find(|job| job.id == id && !job.state.active())
                    {
                        return job;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap()
        }
    }

    #[tokio::test]
    async fn copies_verified_content_then_moves_without_overwriting() {
        let fixture = Fixture::new().await;
        let request = fixture.job(TransferKind::Copy);
        let job = fixture
            .service
            .start_transfer(
                request.kind,
                request.source.clone(),
                request.destination.clone(),
                Arc::new(|_| {}),
            )
            .await
            .unwrap();
        let result = fixture.result(job.id).await;
        assert_eq!(result.state, TransferState::Completed);
        assert_eq!(result.bytes_total, Some(result.bytes_transferred));
        assert_eq!(
            std::fs::read(fixture.source.path().join("source.bin")).unwrap(),
            std::fs::read(fixture.destination.path().join("target.bin")).unwrap()
        );
        // Moving onto the existing target must fail and retain both files.
        let job = fixture
            .service
            .start_transfer(
                TransferKind::Move,
                request.source.clone(),
                request.destination.clone(),
                Arc::new(|_| {}),
            )
            .await
            .unwrap();
        assert_eq!(
            fixture.result(job.id).await.error_code,
            Some(StorageErrorCode::AlreadyExists)
        );
        assert!(fixture.source.path().join("source.bin").exists());
        let mut target = request.destination;
        target.logical_path = "moved.bin".into();
        let job = fixture
            .service
            .start_transfer(TransferKind::Move, request.source, target, Arc::new(|_| {}))
            .await
            .unwrap();
        assert_eq!(fixture.result(job.id).await.state, TransferState::Completed);
        assert!(!fixture.source.path().join("source.bin").exists());
        assert_eq!(
            std::fs::read(fixture.destination.path().join("moved.bin")).unwrap(),
            std::fs::read(fixture.destination.path().join("target.bin")).unwrap()
        );
        assert_eq!(
            std::fs::read_dir(fixture.destination.path())
                .unwrap()
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn cancel_during_verification_discards_staging_and_keeps_source() {
        let fixture = Fixture::new().await;
        let job = fixture.job(TransferKind::Move);
        let id = job.id;
        let token = CancellationToken::new();
        let cancel = token.clone();
        fixture
            .service
            .run_transfer(
                job,
                token,
                Arc::new(move |job| {
                    if job.state == TransferState::Verifying {
                        cancel.cancel();
                    }
                }),
            )
            .await;
        assert_eq!(fixture.result(id).await.state, TransferState::Cancelled);
        assert!(fixture.source.path().join("source.bin").exists());
        assert_eq!(
            std::fs::read_dir(fixture.destination.path())
                .unwrap()
                .count(),
            0
        );
    }

    #[tokio::test]
    async fn source_changed_during_verification_is_never_removed() {
        let fixture = Fixture::new().await;
        let job = fixture.job(TransferKind::Move);
        let id = job.id;
        let source_path = fixture.source.path().join("source.bin");
        fixture
            .service
            .run_transfer(
                job,
                CancellationToken::new(),
                Arc::new(move |job| {
                    if job.state == TransferState::Verifying {
                        std::fs::write(&source_path, b"external change").unwrap();
                    }
                }),
            )
            .await;
        assert_eq!(fixture.result(id).await.state, TransferState::Failed);
        assert_eq!(
            std::fs::read(fixture.source.path().join("source.bin")).unwrap(),
            b"external change"
        );
        assert_eq!(
            std::fs::read_dir(fixture.destination.path())
                .unwrap()
                .count(),
            0
        );
    }

    #[tokio::test]
    async fn queued_cancel_and_permission_recheck() {
        let fixture = Fixture::new().await;
        let request = fixture.job(TransferKind::Copy);
        let guard = fixture.service.mutation_lock.lock().await;
        let job = fixture
            .service
            .start_transfer(
                request.kind,
                request.source.clone(),
                request.destination.clone(),
                Arc::new(|_| {}),
            )
            .await
            .unwrap();
        assert_eq!(
            fixture
                .service
                .update_local_storage(fixture.source_id, "changed".into(), true, None)
                .await
                .unwrap_err()
                .code,
            StorageErrorCode::Conflict
        );
        assert_eq!(
            fixture
                .service
                .remove_local_storage(fixture.destination_id, true)
                .await
                .unwrap_err()
                .code,
            StorageErrorCode::Conflict
        );
        fixture.service.cancel_transfer(job.id).await.unwrap();
        assert_eq!(fixture.result(job.id).await.state, TransferState::Cancelled);
        drop(guard);
        fixture
            .service
            .update_local_storage(fixture.destination_id, "只读目标".into(), true, None)
            .await
            .unwrap();
        assert_eq!(
            fixture
                .service
                .start_transfer(
                    request.kind,
                    request.source.clone(),
                    request.destination.clone(),
                    Arc::new(|_| {})
                )
                .await
                .unwrap_err()
                .code,
            StorageErrorCode::AccessDenied
        );
        assert_eq!(
            std::fs::read_dir(fixture.destination.path())
                .unwrap()
                .count(),
            0
        );
    }

    #[tokio::test]
    async fn same_volume_move_uses_native_rename_and_empty_copy_succeeds() {
        let fixture = Fixture::new().await;
        std::fs::write(fixture.source.path().join("source.bin"), []).unwrap();
        let mut request = fixture.job(TransferKind::Move);
        request.destination.volume_id = fixture.source_id;
        let job = fixture
            .service
            .start_transfer(
                request.kind,
                request.source,
                request.destination,
                Arc::new(|_| {}),
            )
            .await
            .unwrap();
        assert_eq!(fixture.result(job.id).await.state, TransferState::Completed);
        assert!(!fixture.source.path().join("source.bin").exists());
        assert!(fixture.source.path().join("target.bin").exists());
        let mut request = fixture.job(TransferKind::Copy);
        request.source.logical_path = "target.bin".into();
        let job = fixture
            .service
            .start_transfer(
                request.kind,
                request.source,
                request.destination,
                Arc::new(|_| {}),
            )
            .await
            .unwrap();
        assert_eq!(fixture.result(job.id).await.state, TransferState::Completed);
        assert_eq!(
            std::fs::metadata(fixture.destination.path().join("target.bin"))
                .unwrap()
                .len(),
            0
        );
    }
}
