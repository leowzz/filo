use storage_domain::*;
use uuid::Uuid;

const REMOTE_CREDENTIAL_MARKER: &str = "filo.remote.v1";
const REMOTE_CREDENTIAL_PREFIX: &str = "remote:";

/// Remote credentials use the existing credential-store contract without
/// putting their fields in the SQLite configuration.  The marker prevents a
/// stale S3 reference from ever being interpreted as a remote credential.
pub(super) fn remote_reference(id: Uuid) -> String {
    format!("{REMOTE_CREDENTIAL_PREFIX}{id}")
}

pub(super) fn is_remote_reference(reference: &str) -> bool {
    reference
        .strip_prefix(REMOTE_CREDENTIAL_PREFIX)
        .and_then(|id| Uuid::parse_str(id).ok())
        .is_some()
}

pub(super) fn pack_remote_credentials(
    credentials: &RemoteCredentials,
) -> StorageResult<S3Credentials> {
    let secret_access_key = serde_json::to_string(credentials).map_err(|_| {
        StorageError::new(
            StorageErrorCode::InvalidConfiguration,
            "远程凭据无法安全保存",
        )
    })?;
    Ok(S3Credentials {
        access_key_id: REMOTE_CREDENTIAL_MARKER.into(),
        secret_access_key,
        session_token: None,
    })
}

pub(super) fn unpack_remote_credentials(
    credentials: &S3Credentials,
) -> StorageResult<RemoteCredentials> {
    if credentials.access_key_id != REMOTE_CREDENTIAL_MARKER || credentials.session_token.is_some()
    {
        return Err(StorageError::new(
            StorageErrorCode::InvalidConfiguration,
            "远程凭据格式无效，请编辑连接重新保存",
        ));
    }
    serde_json::from_str(&credentials.secret_access_key).map_err(|_| {
        StorageError::new(
            StorageErrorCode::InvalidConfiguration,
            "远程凭据格式无效，请编辑连接重新保存",
        )
    })
}

mod file;
mod legacy;
pub use file::{CredentialMode, CredentialStatus, FileCredentialStore};

/// Injectable so ordinary tests never touch a user's saved credentials.
pub trait CredentialStore: Send + Sync {
    fn get(&self, reference: &str) -> StorageResult<S3Credentials>;
    fn set(&self, reference: &str, credentials: &S3Credentials) -> StorageResult<()>;
    fn delete(&self, reference: &str) -> StorageResult<()>;
}

/// Desktop startup supplies its application data path explicitly. This default
/// is retained for library callers; it never accesses the system keychain.
pub struct SystemCredentialStore;
fn system() -> &'static FileCredentialStore {
    static STORE: std::sync::OnceLock<FileCredentialStore> = std::sync::OnceLock::new();
    STORE.get_or_init(|| {
        let root = if cfg!(target_os = "macos") {
            std::env::var_os("HOME")
                .map(|p| std::path::PathBuf::from(p).join("Library/Application Support"))
        } else if cfg!(target_os = "windows") {
            std::env::var_os("APPDATA").map(std::path::PathBuf::from)
        } else {
            std::env::var_os("XDG_CONFIG_HOME")
                .map(std::path::PathBuf::from)
                .or_else(|| {
                    std::env::var_os("HOME").map(|p| std::path::PathBuf::from(p).join(".config"))
                })
        };
        FileCredentialStore::new(root.map(|p| p.join("dev.filo.desktop/credentials.json")))
    })
}
impl CredentialStore for SystemCredentialStore {
    fn get(&self, reference: &str) -> StorageResult<S3Credentials> {
        system().get(reference)
    }
    fn set(&self, reference: &str, credentials: &S3Credentials) -> StorageResult<()> {
        system().set(reference, credentials)
    }
    fn delete(&self, reference: &str) -> StorageResult<()> {
        system().delete(reference)
    }
}
