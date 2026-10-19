use std::sync::Arc;
use storage_application::{CredentialMode, CredentialStatus, FileCredentialStore, StorageService};
use storage_domain::*;
use tauri::State;

async fn run<T: Send + 'static>(
    store: Arc<FileCredentialStore>,
    operation: impl FnOnce(&FileCredentialStore) -> StorageResult<T> + Send + 'static,
) -> StorageResult<T> {
    tauri::async_runtime::spawn_blocking(move || operation(&store))
        .await
        .map_err(|_| StorageError::new(StorageErrorCode::Internal, "凭据操作失败，请重试"))?
}

crate::errors::commands! {
pub(crate) async fn get_credential_settings(store: State<'_, Arc<FileCredentialStore>>) -> StorageResult<CredentialStatus> {
    run(store.inner().clone(), |s| s.status()).await
}
pub(crate) async fn save_credential_settings(
    store: State<'_, Arc<FileCredentialStore>>,
    mode: CredentialMode,
    password: Option<String>,
    current_password: Option<String>,
) -> StorageResult<CredentialStatus> {
    let password = password.map(zeroize::Zeroizing::new);
    let current = current_password.map(zeroize::Zeroizing::new);
    run(store.inner().clone(), move |s| s.configure(mode, password.as_deref().map(|s| s.as_str()), current.as_deref().map(|s| s.as_str()))).await
}
pub(crate) async fn unlock_credentials(store: State<'_, Arc<FileCredentialStore>>, password: String) -> StorageResult<CredentialStatus> {
    let password = zeroize::Zeroizing::new(password);
    run(store.inner().clone(), move |s| s.unlock(&password)).await
}
pub(crate) async fn reset_credentials(store: State<'_, Arc<FileCredentialStore>>, confirmed: bool) -> StorageResult<CredentialStatus> {
    run(store.inner().clone(), move |s| s.reset(confirmed)).await
}
pub(crate) async fn import_legacy_credentials(store: State<'_, Arc<FileCredentialStore>>, service: State<'_, StorageService>) -> StorageResult<usize> {
    let references = service.list_connections().await?.into_iter().filter_map(|c| c.credential_ref).collect::<Vec<_>>();
    run(store.inner().clone(), move |s| s.import_legacy(&references)).await
}
pub(crate) async fn provide_connection_credentials(service: State<'_, StorageService>, reference: String, s3: Option<S3Credentials>, remote: Option<RemoteCredentials>) -> StorageResult<()> {
    service.provide_connection_credentials(reference, s3, remote).await
}
}
