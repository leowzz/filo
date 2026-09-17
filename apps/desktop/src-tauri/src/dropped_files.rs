use std::{collections::HashMap, path::PathBuf, sync::Mutex};

use storage_application::StorageService;
use storage_domain::*;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

/// Only native drop events and file pickers can grant access to external files.
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

    fn validate(&self, window: &str, paths: &[PathBuf]) -> StorageResult<()> {
        let pending = self.0.lock().map_err(|_| {
            StorageError::new(StorageErrorCode::Internal, "无法读取上传文件，请重新选择")
        })?;
        if !paths.is_empty()
            && pending
                .get(window)
                .is_some_and(|batches| batches.iter().any(|batch| batch == paths))
        {
            Ok(())
        } else {
            Err(StorageError::new(
                StorageErrorCode::AccessDenied,
                "上传文件已失效，请重新选择",
            ))
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

#[derive(serde::Serialize)]
pub struct UploadPreflight {
    paths: Vec<PathBuf>,
    conflicts: Vec<PathBuf>,
}

crate::errors::commands! {
pub async fn preflight_upload(
    app: tauri::AppHandle,
    window: tauri::Window,
    dropped: State<'_, DroppedFiles>,
    service: State<'_, StorageService>,
    remote: StorageLocator,
    paths: Option<Vec<PathBuf>>,
) -> StorageResult<Option<UploadPreflight>> {
    let destination = service.stat_entry(remote.clone()).await?;
    if !matches!(destination.kind, StorageEntryKind::Directory | StorageEntryKind::VirtualPrefix) {
        return Err(StorageError::new(StorageErrorCode::InvalidPath, "请选择目标文件夹"));
    }
    let paths = match paths {
        Some(paths) => {
            dropped.validate(window.label(), &paths)?;
            paths
        }
        None => {
            let selected = tauri::async_runtime::spawn_blocking(move || {
                app.dialog().file().set_title("选择上传文件").blocking_pick_files()
            }).await.map_err(|_| StorageError::new(StorageErrorCode::Internal, "无法打开文件选择器"))?;
            let Some(selected) = selected else { return Ok(None); };
            let paths = selected.into_iter().map(|file| file.into_path().map_err(|_| {
                StorageError::new(StorageErrorCode::InvalidPath, "无法读取所选文件路径")
            })).collect::<StorageResult<Vec<_>>>()?;
            dropped.record(window.label(), &paths);
            paths
        }
    };
    let conflicts = service.preflight_upload(&remote, &paths).await?;
    Ok(Some(UploadPreflight { paths, conflicts }))
}

pub async fn upload_dropped_files(
    window: tauri::Window,
    dropped: State<'_, DroppedFiles>,
    service: State<'_, StorageService>,
    remote: StorageLocator,
    paths: Vec<PathBuf>,
    conflict_policy: ConflictPolicy,
    conflict_paths: Option<Vec<PathBuf>>,
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
            Ok(metadata) if metadata.is_file() || metadata.is_dir() => {}
            Ok(_) => {
                batch.failures.push(format!(
                    "{name}：仅支持普通文件和文件夹，不支持符号链接或特殊文件"
                ));
                continue;
            }
            Err(_) => {
                batch.failures.push(format!(
                    "{name}：无法读取项目，请检查是否存在及访问权限"
                ));
                continue;
            }
        }
        let progress = on_progress.clone();
        match service
            .upload_selected_path(
                path,
                remote.clone(),
                conflict_policy,
                conflict_paths.as_deref().unwrap_or(&[]),
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
        assert!(dropped.validate("main", &paths).is_ok());
        assert!(dropped.validate("main", &paths).is_ok());
        assert!(dropped.validate("other", &paths).is_err());
        assert!(dropped
            .validate("main", &[PathBuf::from("/private/secret")])
            .is_err());
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
