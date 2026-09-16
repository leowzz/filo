#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use storage_application::{StorageService, VolumeView};
use storage_domain::*;
use storage_repository::Repository;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
async fn list_connections(
    service: State<'_, StorageService>,
) -> StorageResult<Vec<StorageConnection>> {
    service.list_connections().await
}
#[tauri::command]
async fn list_volumes(service: State<'_, StorageService>) -> StorageResult<Vec<VolumeView>> {
    service.list_volumes().await
}
#[tauri::command]
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
#[tauri::command]
async fn list_entries(
    service: State<'_, StorageService>,
    parent: StorageLocator,
) -> StorageResult<Vec<StorageEntry>> {
    service.list_entries(parent).await
}
#[tauri::command]
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
#[tauri::command]
async fn start_transfer(
    service: State<'_, StorageService>,
    kind: TransferKind,
    source: StorageLocator,
    destination: StorageLocator,
    on_progress: tauri::ipc::Channel<TransferJob>,
) -> StorageResult<TransferJob> {
    service
        .start_transfer(
            kind,
            source,
            destination,
            std::sync::Arc::new(move |job| {
                let _ = on_progress.send(job);
            }),
        )
        .await
}
#[tauri::command]
async fn list_transfers(service: State<'_, StorageService>) -> StorageResult<Vec<TransferJob>> {
    service.list_transfers().await
}
#[tauri::command]
async fn cancel_transfer(
    service: State<'_, StorageService>,
    job_id: uuid::Uuid,
) -> StorageResult<()> {
    service.cancel_transfer(job_id).await
}
#[tauri::command]
async fn remove_local_storage(
    service: State<'_, StorageService>,
    volume_id: uuid::Uuid,
    confirmed: bool,
) -> StorageResult<()> {
    service.remove_local_storage(volume_id, confirmed).await
}
#[tauri::command]
async fn stat_entry(
    service: State<'_, StorageService>,
    locator: StorageLocator,
) -> StorageResult<StorageEntry> {
    service.stat_entry(locator).await
}
#[tauri::command]
async fn create_directory(
    service: State<'_, StorageService>,
    parent: StorageLocator,
    name: String,
) -> StorageResult<()> {
    service.create_directory(parent, name).await
}
#[tauri::command]
async fn rename_entry(
    service: State<'_, StorageService>,
    source: StorageLocator,
    name: String,
) -> StorageResult<()> {
    service.rename_entry(source, name).await
}
#[tauri::command]
async fn delete_entry(
    service: State<'_, StorageService>,
    locator: StorageLocator,
    confirmed: bool,
) -> StorageResult<()> {
    service.delete_entry(locator, confirmed).await
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data)?;
            let repository =
                tauri::async_runtime::block_on(Repository::open(&data.join("filo.sqlite")))?;
            app.manage(StorageService::new(repository));
            tracing::info!("Filo LocalFS is ready");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_connections,
            list_volumes,
            create_local_storage,
            update_local_storage,
            remove_local_storage,
            start_transfer,
            list_transfers,
            cancel_transfer,
            list_entries,
            stat_entry,
            create_directory,
            rename_entry,
            delete_entry
        ])
        .run(tauri::generate_context!());
    if let Err(error) = result {
        tracing::error!(%error, "Application failed");
        std::process::exit(1);
    }
}
