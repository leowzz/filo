use std::{collections::HashMap, path::PathBuf, sync::Mutex};

use storage_application::StorageService;
use storage_domain::*;
use tauri::State;

/// Only native drop events can grant access to external files.
#[derive(Default)]
pub struct DroppedFiles(Mutex<HashMap<String, Vec<Vec<PathBuf>>>>);

impl DroppedFiles {
    pub fn record(&self, window: &str, paths: &[PathBuf]) {
        if let Ok(mut pending) = self.0.lock() {
            let batches = pending.entry(window.to_owned()).or_default();
            // A drop ignored by an open dialog must not invalidate that dialog's files.
            // Window and webview callbacks may describe the same native drop.
            if batches.last().is_none_or(|previous| previous != paths) {
                batches.push(paths.to_vec());
                if batches.len() > 8 {
                    batches.remove(0);
                }
            }
        }
    }

    fn take(&self, window: &str, paths: &[PathBuf]) -> StorageResult<Vec<PathBuf>> {
        let mut pending = self.0.lock().map_err(|_| {
            StorageError::new(StorageErrorCode::Internal, "无法读取拖入文件，请重新拖入")
        })?;
        let denied =
            || StorageError::new(StorageErrorCode::AccessDenied, "拖入文件已失效，请重新拖入");
        if paths.is_empty() {
            return Err(denied());
        }
        let batches = pending.get_mut(window).ok_or_else(denied)?;
        let index = batches
            .iter()
            .position(|allowed| allowed == paths)
            .ok_or_else(denied)?;
        Ok(batches.remove(index))
    }
}

#[tauri::command]
pub async fn upload_dropped_files(
    window: tauri::Window,
    dropped: State<'_, DroppedFiles>,
    service: State<'_, StorageService>,
    remote: StorageLocator,
    paths: Vec<PathBuf>,
    conflict_policy: ConflictPolicy,
    on_progress: tauri::ipc::Channel<TransferJob>,
) -> StorageResult<super::FileTransferBatch> {
    let paths = dropped.take(window.label(), &paths)?;
    let destination = service.stat_entry(remote.clone()).await?;
    if !matches!(
        destination.kind,
        StorageEntryKind::Directory | StorageEntryKind::VirtualPrefix
    ) {
        return Err(StorageError::new(
            StorageErrorCode::InvalidPath,
            "请拖入目标文件夹",
        ));
    }
    let mut batch = super::FileTransferBatch {
        jobs: Vec::new(),
        failures: Vec::new(),
    };
    for path in paths {
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        match tokio::fs::symlink_metadata(&path).await {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => {
                batch.failures.push(format!(
                    "{name}：目前仅支持拖入文件，不支持文件夹或符号链接"
                ));
                continue;
            }
            Err(_) => {
                batch.failures.push(format!(
                    "{name}：无法读取文件，请检查文件是否存在及访问权限"
                ));
                continue;
            }
        }
        let progress = on_progress.clone();
        match service
            .transfer_selected_file_with_policy(
                path,
                remote.clone(),
                true,
                conflict_policy,
                std::sync::Arc::new(move |job| {
                    let _ = progress.send(job);
                }),
            )
            .await
        {
            Ok(job) => batch.jobs.push(job),
            Err(error) => batch.failures.push(format!("{name}：{}", error.message)),
        }
    }
    Ok(batch)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_native_drop_can_be_consumed_once_by_its_window() {
        let dropped = DroppedFiles::default();
        let paths = vec![
            PathBuf::from("/chosen/a.txt"),
            PathBuf::from("/chosen/b.txt"),
        ];
        assert!(dropped.take("main", &paths).is_err());
        dropped.record("main", &paths);
        assert!(dropped.take("other", &paths).is_err());
        assert!(dropped
            .take("main", &[PathBuf::from("/private/secret")])
            .is_err());
        assert!(dropped.take("main", &[]).is_err());
        assert_eq!(dropped.take("main", &paths).unwrap(), paths);
        assert!(dropped.take("main", &paths).is_err());
    }

    #[test]
    fn a_drop_ignored_by_a_dialog_does_not_invalidate_its_selection() {
        let dropped = DroppedFiles::default();
        let old = vec![PathBuf::from("/old")];
        let current = vec![PathBuf::from("/current")];
        dropped.record("main", &old);
        dropped.record("main", &current);
        assert_eq!(dropped.take("main", &old).unwrap(), old);
        assert_eq!(dropped.take("main", &current).unwrap(), current);
    }

    #[test]
    fn duplicate_events_are_not_replayable_and_pending_drops_are_bounded() {
        let dropped = DroppedFiles::default();
        let paths = vec![PathBuf::from("/same")];
        dropped.record("main", &paths);
        dropped.record("main", &paths);
        assert!(dropped.take("main", &paths).is_ok());
        assert!(dropped.take("main", &paths).is_err());
        for index in 0..9 {
            dropped.record("main", &[PathBuf::from(format!("/{index}"))]);
        }
        assert!(dropped.take("main", &[PathBuf::from("/0")]).is_err());
        assert!(dropped.take("main", &[PathBuf::from("/8")]).is_ok());
    }
}
