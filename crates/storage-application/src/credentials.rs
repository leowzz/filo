use storage_domain::*;

/// Injectable so integration tests never touch a user's keychain.
pub trait CredentialStore: Send + Sync {
    fn get(&self, reference: &str) -> StorageResult<S3Credentials>;
    fn set(&self, reference: &str, credentials: &S3Credentials) -> StorageResult<()>;
    fn delete(&self, reference: &str) -> StorageResult<()>;
}

pub struct SystemCredentialStore;
fn error() -> StorageError {
    StorageError::new(
        StorageErrorCode::AccessDenied,
        "无法访问系统凭据库，请解锁钥匙串或重新输入 S3 凭据",
    )
}
impl CredentialStore for SystemCredentialStore {
    fn get(&self, reference: &str) -> StorageResult<S3Credentials> {
        let value = keyring::Entry::new("dev.filo.desktop.s3", reference)
            .map_err(|_| error())?
            .get_password()
            .map_err(|_| error())?;
        serde_json::from_str(&value).map_err(|_| error())
    }
    fn set(&self, reference: &str, credentials: &S3Credentials) -> StorageResult<()> {
        let value = serde_json::to_string(credentials).map_err(|_| error())?;
        keyring::Entry::new("dev.filo.desktop.s3", reference)
            .map_err(|_| error())?
            .set_password(&value)
            .map_err(|_| error())
    }
    fn delete(&self, reference: &str) -> StorageResult<()> {
        match keyring::Entry::new("dev.filo.desktop.s3", reference)
            .map_err(|_| error())?
            .delete_credential()
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(error()),
        }
    }
}
