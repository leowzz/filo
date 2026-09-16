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

#[cfg(any(target_os = "macos", test))]
mod vault;

/// Injectable so ordinary tests never touch a user's keychain.
pub trait CredentialStore: Send + Sync {
    fn get(&self, reference: &str) -> StorageResult<S3Credentials>;
    fn set(&self, reference: &str, credentials: &S3Credentials) -> StorageResult<()>;
    fn delete(&self, reference: &str) -> StorageResult<()>;
}

pub struct SystemCredentialStore;
fn error() -> StorageError {
    StorageError::new(
        StorageErrorCode::AccessDenied,
        "无法访问系统凭据库，请解锁钥匙串或重新输入连接凭据",
    )
}
#[cfg(target_os = "macos")]
impl CredentialStore for SystemCredentialStore {
    fn get(&self, reference: &str) -> StorageResult<S3Credentials> {
        vault::system().get(reference)
    }
    fn set(&self, reference: &str, credentials: &S3Credentials) -> StorageResult<()> {
        vault::system().set(reference, credentials)
    }
    fn delete(&self, reference: &str) -> StorageResult<()> {
        vault::system().delete(reference)
    }
}

#[cfg(not(target_os = "macos"))]
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

/// Keep unlocked credentials only in this process. Serializing access also
/// coalesces concurrent directory/transfer requests into one keychain read.
pub(super) struct CachedCredentialStore {
    inner: std::sync::Arc<dyn CredentialStore>,
    values: std::sync::Mutex<std::collections::HashMap<String, S3Credentials>>,
}
impl CachedCredentialStore {
    pub(super) fn new(inner: std::sync::Arc<dyn CredentialStore>) -> Self {
        Self {
            inner,
            values: Default::default(),
        }
    }
}
impl CredentialStore for CachedCredentialStore {
    fn get(&self, reference: &str) -> StorageResult<S3Credentials> {
        let mut values = self.values.lock().map_err(|_| error())?;
        if let Some(value) = values.get(reference) {
            return Ok(value.clone());
        }
        let value = self.inner.get(reference)?;
        values.insert(reference.into(), value.clone());
        Ok(value)
    }
    fn set(&self, reference: &str, credentials: &S3Credentials) -> StorageResult<()> {
        let mut values = self.values.lock().map_err(|_| error())?;
        self.inner.set(reference, credentials)?;
        values.insert(reference.into(), credentials.clone());
        Ok(())
    }
    fn delete(&self, reference: &str) -> StorageResult<()> {
        let mut values = self.values.lock().map_err(|_| error())?;
        self.inner.delete(reference)?;
        values.remove(reference);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };
    #[derive(Default)]
    struct CountingStore {
        reads: AtomicUsize,
        value: Mutex<Option<S3Credentials>>,
    }
    impl CredentialStore for CountingStore {
        fn get(&self, _: &str) -> StorageResult<S3Credentials> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            self.value.lock().unwrap().clone().ok_or_else(error)
        }
        fn set(&self, _: &str, value: &S3Credentials) -> StorageResult<()> {
            *self.value.lock().unwrap() = Some(value.clone());
            Ok(())
        }
        fn delete(&self, _: &str) -> StorageResult<()> {
            *self.value.lock().unwrap() = None;
            Ok(())
        }
    }
    fn credential(key: &str) -> S3Credentials {
        S3Credentials {
            access_key_id: key.into(),
            secret_access_key: "test".into(),
            session_token: None,
        }
    }
    #[test]
    fn parallel_reads_unlock_once_and_updates_and_deletes_invalidate() {
        let store = Arc::new(CountingStore::default());
        store.set("ref", &credential("first")).unwrap();
        let cached = Arc::new(CachedCredentialStore::new(store.clone()));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let cached = cached.clone();
                std::thread::spawn(move || {
                    assert_eq!(cached.get("ref").unwrap().access_key_id, "first")
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(store.reads.load(Ordering::SeqCst), 1);
        cached.set("ref", &credential("updated")).unwrap();
        assert_eq!(cached.get("ref").unwrap().access_key_id, "updated");
        assert_eq!(store.reads.load(Ordering::SeqCst), 1);
        cached.delete("ref").unwrap();
        assert!(cached.get("ref").is_err());
        // A denied/failed read is not cached: a later explicit retry can succeed.
        store.set("ref", &credential("retry")).unwrap();
        assert_eq!(cached.get("ref").unwrap().access_key_id, "retry");
        assert_eq!(store.reads.load(Ordering::SeqCst), 3);
    }
}
