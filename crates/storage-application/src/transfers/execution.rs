use super::{cancelled, check_permissions, StorageService, TransferObserver};
use crate::operation_planner::{plan, OperationPlan};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use storage_domain::*;
use storage_provider_api::StorageReader;
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

pub(super) const BUFFER_SIZE: usize = 256 * 1024;

fn io_error(_: std::io::Error) -> StorageError {
    StorageError::new(StorageErrorCode::Io, "无法读取文件，请检查存储和系统权限")
}

impl StorageService {
    pub(super) async fn execute_transfer(
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
            OperationPlan::ProviderRename => {
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

fn unchanged(before: &StorageEntry, after: &StorageEntry) -> StorageResult<()> {
    if before.kind != after.kind
        || before.size != after.size
        || before.modified_at != after.modified_at
        || before.etag != after.etag
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
