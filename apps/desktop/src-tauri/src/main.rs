#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use storage_application::{StorageService, VolumeView};
use storage_domain::*;
use storage_repository::Repository;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

mod dropped_files;
mod errors;

#[derive(serde::Serialize)]
struct FileTransferBatch {
    jobs: Vec<TransferJob>,
    failures: Vec<String>,
}

errors::commands! {
async fn get_transfer_settings(
    service: State<'_, StorageService>,
) -> StorageResult<TransferSettings> {
    service.transfer_settings().await
}

async fn save_transfer_settings(
    service: State<'_, StorageService>,
    settings: TransferSettings,
) -> StorageResult<TransferSettings> {
    service.save_transfer_settings(settings).await
}

async fn save_s3_storage(
    service: State<'_, StorageService>,
    volume_id: Option<uuid::Uuid>,
    input: S3StorageInput,
) -> StorageResult<StorageVolume> {
    service.save_s3_storage(volume_id, input).await
}
async fn test_s3_connection(
    service: State<'_, StorageService>,
    volume_id: Option<uuid::Uuid>,
    input: S3StorageInput,
) -> StorageResult<()> {
    service.test_s3_connection(volume_id, input).await
}
async fn transfer_local_file(
    app: tauri::AppHandle,
    service: State<'_, StorageService>,
    remote: StorageLocator,
    upload: bool,
    conflict_policy: Option<ConflictPolicy>,
    on_progress: tauri::ipc::Channel<TransferJob>,
) -> StorageResult<Option<FileTransferBatch>> {
    // Authorize the remote locator before opening any native picker.
    let entry = service.stat_entry(remote.clone()).await?;
    let name = entry.name;
    let selected = tauri::async_runtime::spawn_blocking(move || {
        if upload {
            app.dialog()
                .file()
                .set_title("选择上传文件")
                .blocking_pick_files()
        } else {
            app.dialog()
                .file()
                .set_title("保存下载文件")
                .set_file_name(name)
                .blocking_save_file()
                .map(|file| vec![file])
        }
    })
    .await
    .map_err(|_| StorageError::new(StorageErrorCode::Internal, "无法打开文件选择器"))?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let mut batch = FileTransferBatch {
        jobs: Vec::new(),
        failures: Vec::new(),
    };
    for selected in selected {
        let path = match selected.into_path() {
            Ok(path) => path,
            Err(_) => {
                batch.failures.push("无法读取所选文件路径".into());
                continue;
            }
        };
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let on_progress = on_progress.clone();
        match service
            .transfer_selected_file_with_policy(
                path,
                remote.clone(),
                upload,
                conflict_policy.unwrap_or_default(),
                std::sync::Arc::new(move |job| {
                    let _ = on_progress.send(job);
                }),
            )
            .await
        {
            Ok(job) => batch.jobs.push(job),
            Err(error) => batch.failures.push(format!("{name}：{}", error.message)),
        }
    }
    Ok(Some(batch))
}

async fn list_connections(
    service: State<'_, StorageService>,
) -> StorageResult<Vec<StorageConnection>> {
    service.list_connections().await
}
async fn list_volumes(service: State<'_, StorageService>) -> StorageResult<Vec<VolumeView>> {
    service.list_volumes().await
}
async fn create_local_storage(
    app: tauri::AppHandle,
    service: State<'_, StorageService>,
    read_only: bool,
) -> StorageResult<Option<StorageVolume>> {
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择已有目录作为存储空间")
            .blocking_pick_folder()
    })
    .await
    .map_err(|_| StorageError::new(StorageErrorCode::Internal, "无法打开目录选择器"))?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|_| StorageError::new(StorageErrorCode::InvalidPath, "请选择本地目录"))?;
    service
        .add_selected_directory(path, read_only)
        .await
        .map(Some)
}
async fn list_entries(
    service: State<'_, StorageService>,
    parent: StorageLocator,
) -> StorageResult<Vec<StorageEntry>> {
    service.list_entries(parent).await
}
async fn update_local_storage(
    app: tauri::AppHandle,
    service: State<'_, StorageService>,
    volume_id: uuid::Uuid,
    name: String,
    read_only: bool,
    change_directory: bool,
) -> StorageResult<Option<StorageVolume>> {
    let selected_root = if change_directory {
        let selected = tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
                .file()
                .set_title("选择新的本地目录")
                .blocking_pick_folder()
        })
        .await
        .map_err(|_| StorageError::new(StorageErrorCode::Internal, "无法打开目录选择器"))?;
        let Some(selected) = selected else {
            return Ok(None);
        };
        Some(
            selected
                .into_path()
                .map_err(|_| StorageError::new(StorageErrorCode::InvalidPath, "请选择本地目录"))?,
        )
    } else {
        None
    };
    service
        .update_local_storage(volume_id, name, read_only, selected_root)
        .await
        .map(Some)
}
async fn start_transfer(
    service: State<'_, StorageService>,
    kind: TransferKind,
    conflict_policy: Option<ConflictPolicy>,
    source: StorageLocator,
    destination: StorageLocator,
    on_progress: tauri::ipc::Channel<TransferJob>,
) -> StorageResult<TransferJob> {
    service
        .start_transfer_with_policy(
            kind,
            source,
            destination,
            conflict_policy.unwrap_or_default(),
            std::sync::Arc::new(move |job| {
                let _ = on_progress.send(job);
            }),
        )
        .await
}
async fn list_transfers(service: State<'_, StorageService>) -> StorageResult<Vec<TransferJob>> {
    service.list_transfers().await
}
async fn cancel_transfer(
    service: State<'_, StorageService>,
    job_id: uuid::Uuid,
) -> StorageResult<()> {
    service.cancel_transfer(job_id).await
}
async fn remove_local_storage(
    service: State<'_, StorageService>,
    volume_id: uuid::Uuid,
    confirmed: bool,
) -> StorageResult<()> {
    service.remove_local_storage(volume_id, confirmed).await
}
async fn list_entries_page(
    service: State<'_, StorageService>,
    parent: StorageLocator,
    options: ListOptions,
    cursor: Option<String>,
    limit: Option<usize>,
) -> StorageResult<EntryPage> {
    service
        .list_entries_page(parent, options, cursor, limit.unwrap_or(200))
        .await
}
async fn stat_entry(
    service: State<'_, StorageService>,
    locator: StorageLocator,
) -> StorageResult<StorageEntry> {
    service.stat_entry(locator).await
}
async fn create_directory(
    service: State<'_, StorageService>,
    parent: StorageLocator,
    name: String,
) -> StorageResult<()> {
    service.create_directory(parent, name).await
}
async fn rename_entry(
    service: State<'_, StorageService>,
    source: StorageLocator,
    name: String,
    conflict_policy: Option<ConflictPolicy>,
) -> StorageResult<TransferState> {
    service
        .rename_entry_with_policy(source, name, conflict_policy.unwrap_or_default())
        .await
}
async fn open_entry(
    service: State<'_, StorageService>,
    locator: StorageLocator,
) -> StorageResult<()> {
    service.open_entry(locator).await
}
async fn delete_entry(
    service: State<'_, StorageService>,
    locator: StorageLocator,
    mode: DeleteMode,
    confirmed: bool,
    recursive: Option<bool>,
) -> StorageResult<DeleteOutcome> {
    service
        .delete_entry_recursive(locator, mode, confirmed, recursive.unwrap_or(false))
        .await
}

async fn preview_entry(
    service: State<'_, StorageService>,
    locator: StorageLocator,
    thumbnail: bool,
) -> StorageResult<Preview> {
    service.preview_entry(locator, thumbnail).await
}
async fn directory_stamp(
    service: State<'_, StorageService>,
    parent: StorageLocator,
) -> StorageResult<String> {
    service.directory_stamp(parent).await
}
async fn start_content_search(
    service: State<'_, StorageService>,
    parent: StorageLocator,
    query: String,
    show_hidden: bool,
) -> StorageResult<uuid::Uuid> {
    service
        .start_content_search(parent, query, show_hidden)
        .await
}
async fn content_search_status(
    service: State<'_, StorageService>,
    id: uuid::Uuid,
    cancel: bool,
) -> StorageResult<ContentSearch> {
    service.content_search_status(id, cancel).await
}
async fn manage_s3(
    service: State<'_, StorageService>,
    locator: StorageLocator,
    action: S3Action,
) -> StorageResult<serde_json::Value> {
    service.manage_s3(locator, action).await
}

async fn recent_backend_errors(reports: State<'_, errors::ErrorReports>) -> StorageResult<Vec<errors::BackendError>> {
    Ok(reports.recent())
}
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let result = tauri::Builder::default()
        .manage(dropped_files::DroppedFiles::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                window
                    .state::<dropped_files::DroppedFiles>()
                    .record(window.label(), paths);
            }
        })
        .on_webview_event(|webview, event| {
            if let tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                webview
                    .state::<dropped_files::DroppedFiles>()
                    .record(webview.window().label(), paths);
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            errors::install(app.handle().clone());
            let data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data)?;
            let repository =
                tauri::async_runtime::block_on(Repository::open(&data.join("filo.sqlite")))?;
            app.manage(StorageService::new(repository));
            tracing::info!("Filo storage is ready");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            recent_backend_errors,
            preview_entry,
            directory_stamp,
            start_content_search,
            content_search_status,
            manage_s3,
            get_transfer_settings,
            save_transfer_settings,
            save_s3_storage,
            test_s3_connection,
            transfer_local_file,
            dropped_files::upload_dropped_files,
            list_connections,
            list_volumes,
            create_local_storage,
            update_local_storage,
            remove_local_storage,
            start_transfer,
            list_transfers,
            cancel_transfer,
            list_entries,
            list_entries_page,
            stat_entry,
            create_directory,
            rename_entry,
            delete_entry,
            open_entry
        ])
        .run(tauri::generate_context!());
    if let Err(error) = result {
        tracing::error!(%error, "Application failed");
        std::process::exit(1);
    }
}
