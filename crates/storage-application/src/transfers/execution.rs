use super::{cancelled, check_permissions, StorageService, TransferObserver};
use crate::operation_planner::{plan, OperationPlan};
use crate::tree;
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use storage_domain::*;
use storage_provider_api::{StorageBackend, StorageReader};
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
        policy: ConflictPolicy,
    ) -> StorageResult<()> {
        if token.is_cancelled() {
            return Err(cancelled());
        }
        let source = self.backend(job.source.volume_id).await?;
        let destination = self.backend(job.destination.volume_id).await?;
        let before = source.stat(&job.source).await?;
        check_permissions(job.kind, &before, source.as_ref(), destination.as_ref())?;
        let mut existing =
            super::conflicts::existing(destination.as_ref(), &job.destination).await?;
        if existing.is_some() {
            match policy {
                ConflictPolicy::Skip => {
                    job.state = TransferState::Skipped;
                    return Ok(());
                }
                ConflictPolicy::Rename => {
                    job.destination = super::conflicts::available_name(
                        destination.as_ref(),
                        &job.destination,
                        tree::directory(&before),
                    )
                    .await?;
                    existing = None;
                    self.report(job, observer).await?;
                }
                ConflictPolicy::Overwrite => {
                    let target = existing.as_ref().unwrap();
                    if tree::directory(&before) != tree::directory(target)
                        || target.kind == StorageEntryKind::Symlink
                    {
                        return Err(StorageError::new(
                            StorageErrorCode::Conflict,
                            "文件与文件夹不能互相覆盖，请选择自动改名或跳过",
                        ));
                    }
                }
                ConflictPolicy::Reject => {}
            }
        }
        tree::check_overlap(
            source.as_ref(),
            destination.as_ref(),
            &job.source,
            &job.destination,
        )?;
        if tree::directory(&before) {
            return self
                .execute_tree(
                    job,
                    token,
                    observer,
                    source.as_ref(),
                    destination.as_ref(),
                    policy,
                )
                .await;
        }
        job.bytes_total = before.size;
        job.state = TransferState::Running;
        self.report(job, observer).await?;
        let strategy = if existing.is_some() && policy == ConflictPolicy::Overwrite {
            OperationPlan::StreamCopy {
                delete_source: job.kind == TransferKind::Move,
            }
        } else {
            plan(job.kind, &job.source, &job.destination)?
        };
        match strategy {
            OperationPlan::ProviderRename => {
                if token.is_cancelled() {
                    return Err(cancelled());
                }
                source.rename(&job.source, &job.destination).await?;
                job.bytes_transferred = before.size.unwrap_or(0);
            }
            OperationPlan::StreamCopy { delete_source } => {
                self.copy_file(
                    job,
                    token,
                    observer,
                    source.as_ref(),
                    destination.as_ref(),
                    &before,
                    &job.destination.clone(),
                    policy,
                )
                .await?;
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
    #[allow(clippy::too_many_arguments)]
    async fn copy_file(
        &self,
        job: &mut TransferJob,
        token: &CancellationToken,
        observer: &TransferObserver,
        source: &dyn StorageBackend,
        destination: &dyn StorageBackend,
        before: &StorageEntry,
        target: &StorageLocator,
        policy: ConflictPolicy,
    ) -> StorageResult<(u64, Vec<u8>)> {
        job.state = TransferState::Running;
        let mut reader = source.open_read(&before.locator).await?;
        let mut writer = if policy == ConflictPolicy::Overwrite {
            match super::conflicts::existing(destination, target).await? {
                Some(expected) => destination.stage_replace(&expected).await?,
                None => destination.stage_write(target).await?,
            }
        } else {
            destination.stage_write(target).await?
        };
        let initial_bytes = job.bytes_transferred;
        let mut buffer = vec![0; BUFFER_SIZE];
        let mut hash = Sha256::new();
        let mut last_report = Instant::now();
        let limits = self.transfer_limits().await?;
        loop {
            let chunk =
                limits.chunk_size(buffer.len(), destination.is_remote(), source.is_remote());
            let count = tokio::select! { biased; _ = token.cancelled() => return Err(cancelled()), result = reader.read(&mut buffer[..chunk]) => result.map_err(io_error)? };
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
        unchanged(before, &source.stat(&before.locator).await?)?;
        if before.size != Some(job.bytes_transferred - initial_bytes) {
            return Err(StorageError::new(
                StorageErrorCode::Conflict,
                "复制期间源文件大小发生变化，请重试",
            ));
        }
        job.state = TransferState::Verifying;
        self.report(job, observer).await?;
        let size = job.bytes_transferred - initial_bytes;
        let target_hash = hash.finalize().to_vec();
        if !writer.verifies_on_commit() {
            let verified = tokio::select! {
                biased;
                _ = token.cancelled() => return Err(cancelled()),
                result = async { digest(writer.reader().await?, token).await } => result?,
            };
            if verified != (size, target_hash.clone()) {
                return Err(StorageError::new(
                    StorageErrorCode::Io,
                    "目标文件校验失败，源文件已保留",
                ));
            }
        }
        unchanged(before, &source.stat(&before.locator).await?)?;
        if token.is_cancelled() {
            return Err(cancelled());
        }
        // Commit is the cancellation boundary. Once publication starts,
        // finish the operation and report its actual outcome.
        writer.commit().await?;

        Ok((size, target_hash))
    }

    #[allow(clippy::too_many_arguments)]
    async fn execute_tree(
        &self,
        job: &mut TransferJob,
        token: &CancellationToken,
        observer: &TransferObserver,
        source: &dyn StorageBackend,
        destination: &dyn StorageBackend,
        policy: ConflictPolicy,
    ) -> StorageResult<()> {
        job.state = TransferState::Running;
        job.bytes_total = None;
        self.report(job, observer).await?;
        let entries = tree::inventory(source, &job.source, token).await?;
        job.bytes_total = Some(entries.iter().filter_map(|entry| entry.size).sum());
        job.state = TransferState::Running;
        self.report(job, observer).await?;
        // Reserve a new root, or merge an existing folder when explicitly requested.
        tree::check_cancel(token)?;
        super::conflicts::directory(destination, &job.destination, policy).await?;
        let result = async {
            let mut verified = Vec::new();
            for entry in entries.iter().skip(1) {
                tree::check_cancel(token)?;
                let suffix = &entry.locator.logical_path[job.source.logical_path.len()..];
                let target = StorageLocator {
                    logical_path: format!("{}{suffix}", job.destination.logical_path),
                    ..job.destination.clone()
                };
                if tree::directory(entry) {
                    super::conflicts::directory(destination, &target, policy).await?;
                } else {
                    let hash = self
                        .copy_file(
                            job,
                            token,
                            observer,
                            source,
                            destination,
                            entry,
                            &target,
                            policy,
                        )
                        .await?;
                    verified.push((target, hash));
                }
            }
            if job.kind == TransferKind::Move {
                job.state = TransferState::Verifying;
                self.report(job, observer).await?;
                let current = tree::inventory(source, &job.source, token).await?;
                let current: std::collections::HashMap<_, _> = current
                    .iter()
                    .map(|entry| (&entry.locator.logical_path, entry))
                    .collect();
                if current.len() != entries.len() {
                    return Err(StorageError::new(
                        StorageErrorCode::Conflict,
                        "源文件夹内容发生变化",
                    ));
                }
                for entry in &entries {
                    let after = current.get(&entry.locator.logical_path).ok_or_else(|| {
                        StorageError::new(StorageErrorCode::Conflict, "源文件夹内容发生变化")
                    })?;
                    tree::unchanged(entry, after)?;
                }
                for (target, expected) in verified {
                    if digest(destination.open_read(&target).await?, token).await? != expected {
                        return Err(StorageError::new(
                            StorageErrorCode::Conflict,
                            "目标内容发生变化",
                        ));
                    }
                }
                // Empty directories have no file digest but are part of the copy too.
                for entry in entries.iter().filter(|entry| tree::directory(entry)) {
                    let suffix = &entry.locator.logical_path[job.source.logical_path.len()..];
                    let target = StorageLocator {
                        logical_path: format!("{}{suffix}", job.destination.logical_path),
                        ..job.destination.clone()
                    };
                    if !tree::directory(&destination.stat(&target).await?) {
                        return Err(StorageError::new(
                            StorageErrorCode::Conflict,
                            "目标文件夹发生变化",
                        ));
                    }
                }
                tree::check_cancel(token)?;
                // Once source cleanup begins, finish it without cancellation.
                tree::remove_inventory(source, &entries)
                    .await
                    .map_err(|error| {
                        StorageError::new(
                            error.code,
                            format!(
                                "目标已完整保存，源文件夹未完全清理，请检查剩余内容：{}",
                                error.message
                            ),
                        )
                    })?;
            }
            Ok(())
        }
        .await;
        result.map_err(|error: StorageError| {
            StorageError::new(
                error.code,
                format!(
                    "{}；目标中已完成的内容会保留，请检查后再重试",
                    error.message
                ),
            )
        })
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
