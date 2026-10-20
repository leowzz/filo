use storage_application::{photography::*, StorageService};
use storage_domain::*;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

#[derive(serde::Serialize)]
pub struct PhotoDirectory {
    locator: StorageLocator,
    path: String,
}

crate::errors::commands! {
pub async fn review_catalog(service: State<'_, StorageService>) -> StorageResult<PhotoCatalog> { service.photo_review_workspace().photo_catalog().await }
pub async fn review_open(service: State<'_, StorageService>, name: String, jpg: StorageLocator, raw: Option<StorageLocator>) -> StorageResult<PhotoSession> { service.photo_review_workspace().photo_open_review(name, jpg, raw).await }
pub async fn review_open_directory(service: State<'_, StorageService>, root: StorageLocator) -> StorageResult<PhotoSession> { service.photo_review_workspace().photo_open_directory_review(root).await }
pub async fn review_scan(service: State<'_, StorageService>, request_id: Uuid, input: PhotoReviewInput, on_progress: tauri::ipc::Channel<PhotoReviewProgress>) -> StorageResult<PhotoSession> {
    service.photo_review_workspace().photo_scan_review(request_id, input, std::sync::Arc::new(move |progress| { let _ = on_progress.send(progress); })).await
}
pub async fn review_cancel_scan(service: State<'_, StorageService>, request_id: Uuid) -> StorageResult<()> { service.photo_cancel_review_scan(request_id).await }
pub async fn review_load_capture_times(service: State<'_, StorageService>, request_id: Uuid, session_id: Uuid, on_progress: tauri::ipc::Channel<PhotoReviewProgress>) -> StorageResult<Vec<PhotoCaptureTime>> {
    service.photo_review_workspace().photo_load_capture_times(request_id, session_id, std::sync::Arc::new(move |progress| { let _ = on_progress.send(progress); })).await
}
pub async fn review_sync(service: State<'_, StorageService>, session_id: Uuid) -> StorageResult<()> { service.photo_review_workspace().photo_sync(session_id).await }
pub async fn review_restore(service: State<'_, StorageService>, jpg: StorageLocator, raw: StorageLocator) -> StorageResult<usize> { service.photo_review_workspace().photo_restore(jpg, raw).await }
pub async fn photo_catalog(service: State<'_, StorageService>) -> StorageResult<PhotoCatalog> { service.photo_catalog().await }
pub async fn photo_paths(service: State<'_, StorageService>, session_id: Uuid) -> StorageResult<serde_json::Value> { service.photo_paths(session_id).await }
pub async fn photo_has_active_imports(service: State<'_, StorageService>) -> StorageResult<bool> { Ok(service.photo_has_active_imports().await) }
pub async fn photo_pick_directory(app: tauri::AppHandle, service: State<'_, StorageService>, read_only: bool, title: Option<String>) -> StorageResult<Option<PhotoDirectory>> {
    let title = title.unwrap_or_else(|| if read_only { "选择存储卡或照片来源".into() } else { "选择照片目录".into() });
    let selected = tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_title(title).blocking_pick_folder()).await.map_err(|_| StorageError::new(StorageErrorCode::Internal, "无法打开目录选择器"))?;
    let Some(selected) = selected else { return Ok(None); };
    let path = selected.into_path().map_err(|_| StorageError::new(StorageErrorCode::InvalidPath, "请选择系统挂载目录"))?;
    let volume = service.add_selected_directory(path, read_only).await?;
    let VolumeRoot::Local { root_path } = volume.root else { unreachable!() };
    Ok(Some(PhotoDirectory { locator: StorageLocator { volume_id: volume.id, logical_path: String::new(), version_id: None }, path: root_path.to_string_lossy().into_owned() }))
}
pub async fn photo_plan(service: State<'_, StorageService>, input: PhotoPlanInput) -> StorageResult<PhotoSession> { service.photo_plan(input).await }
pub async fn photo_import(service: State<'_, StorageService>, session_id: Uuid, on_progress: tauri::ipc::Channel<PhotoProgress>) -> StorageResult<PhotoSession> {
    service.photo_import(session_id, std::sync::Arc::new(move |progress| { let _ = on_progress.send(progress); })).await
}
pub async fn photo_cancel_import(service: State<'_, StorageService>, session_id: Uuid) -> StorageResult<()> { service.photo_cancel_import(session_id).await }
pub async fn photo_rebind_source(service: State<'_, StorageService>, session_id: Uuid, source: StorageLocator) -> StorageResult<()> { service.photo_rebind_source(session_id, source).await }
pub async fn photo_exclude(service: State<'_, StorageService>, session_id: Uuid, photo_id: Uuid, excluded: bool) -> StorageResult<()> { service.photo_exclude(session_id, photo_id, excluded).await }
pub async fn photo_resolve_date(service: State<'_, StorageService>, session_id: Uuid, date: String) -> StorageResult<()> { service.photo_resolve_date(session_id, date).await }
pub async fn review_mark(app: tauri::AppHandle, service: State<'_, StorageService>, session_id: Uuid, photo_id: Uuid, rating: u8, flag: PhotoFlag) -> StorageResult<Photo> {
    let review = service.photo_review_workspace();
    let result = storage_application::catch_panic(review.photo_mark(session_id, photo_id, rating, flag)).await;
    match result {
        Ok(photo) => Ok(photo),
        Err(mut error) => {
            let path = review.photo_catalog().await.ok().and_then(|catalog| {
                catalog.photos.into_iter().find(|photo| photo.id == photo_id).map(|photo| photo.original_path)
            });
            let mark = serde_json::json!({
                "session_id": session_id, "photo_id": photo_id,
                "original_path": path, "rating": rating, "flag": flag,
            });
            let failure = error.clone();
            let recorded = tauri::async_runtime::spawn_blocking(move || {
                let data = app.path().app_data_dir().map_err(std::io::Error::other)?;
                crate::diagnostics::write_review_save_failure(&data, &mark, &failure)
            }).await;
            error.message.push_str(if matches!(recorded, Ok(Ok(_))) {
                "；未保存的标记已记录到本机应用数据，可重试保存"
            } else {
                tracing::error!(%session_id, %photo_id, "Failed to record unsaved photo mark");
                "；未能记录到本机应用数据，请保留当前窗口并重试"
            });
            Err(error)
        }
    }
}
pub async fn review_undo(service: State<'_, StorageService>, session_id: Uuid) -> StorageResult<Option<Photo>> { service.photo_review_workspace().photo_undo(session_id).await }
pub async fn review_save_position(service: State<'_, StorageService>, session_id: Uuid, position: PhotoReviewPosition) -> StorageResult<()> { service.photo_review_workspace().photo_save_position(session_id, position).await }
pub async fn review_preview(service: State<'_, StorageService>, photo_id: Uuid, original: bool, thumbnail: bool, raw_only: Option<bool>) -> StorageResult<PhotoPreview> { service.photo_review_workspace().photo_preview(photo_id, original, thumbnail, raw_only.unwrap_or(false)).await }
pub async fn photo_sync(service: State<'_, StorageService>, session_id: Uuid) -> StorageResult<()> { service.photo_sync(session_id).await }
pub async fn photo_restore(service: State<'_, StorageService>, jpg: StorageLocator, raw: StorageLocator) -> StorageResult<usize> { service.photo_restore(jpg, raw).await }
pub async fn review_export(service: State<'_, StorageService>, session_id: Uuid, destination: StorageLocator, filter: Option<PhotoExportFilter>, on_progress: tauri::ipc::Channel<PhotoProgress>) -> StorageResult<PhotoExport> {
    service.photo_review_workspace().photo_export(session_id, destination, filter.unwrap_or_default(), std::sync::Arc::new(move |progress| { let _ = on_progress.send(progress); })).await
}
pub async fn review_prepare_lrc(service: State<'_, StorageService>, session_id: Uuid) -> StorageResult<PhotoHandoff> { service.photo_review_workspace().photo_prepare_lrc(session_id).await }
pub async fn review_open_raw_directory(service: State<'_, StorageService>, session_id: Uuid, directory: String) -> StorageResult<()> { service.photo_review_workspace().photo_open_raw_directory(session_id, directory).await }
pub async fn review_launch_lrc(app: tauri::AppHandle) -> StorageResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            let _ = app;
            let status = std::process::Command::new("open").args(["-a", "Adobe Lightroom Classic"]).status();
            if status.is_ok_and(|status| status.success()) { return Ok(()); }
        }
        #[cfg(target_os = "windows")]
        {
            let default = std::env::var_os("ProgramFiles").map(std::path::PathBuf::from).map(|p| p.join("Adobe/Adobe Lightroom Classic/Lightroom.exe"));
            let path = default.filter(|p| p.is_file()).or_else(|| app.dialog().file().set_title("选择 Lightroom Classic 程序").add_filter("Lightroom", &["exe"]).blocking_pick_file().and_then(|p| p.into_path().ok()));
            if let Some(path) = path { if std::process::Command::new(path).spawn().is_ok() { return Ok(()); } }
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let _ = app;
        Err(StorageError::new(StorageErrorCode::Unsupported, "未能启动 Lightroom Classic，请在系统中手动打开"))
    }).await.map_err(|_| StorageError::new(StorageErrorCode::Internal, "启动 Lightroom 任务中断"))?
}
}
