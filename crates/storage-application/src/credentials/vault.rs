//! One macOS keychain item unlocks every storage connection. Secrets remain in
//! the keychain; the lock file contains only a revision used by other processes.
use super::{error, CredentialStore};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::Mutex,
};
use storage_domain::*;

const ACCOUNT: &str = "vault-v1";

fn check_reference(reference: &str) -> StorageResult<()> {
    if reference.is_empty() || reference == ACCOUNT {
        return Err(error());
    }
    Ok(())
}

// Missing data must be distinguished from locked/denied/corrupt data. Only a
// missing vault can be initialized; treating other failures as empty loses data.
trait VaultStorage: Send + Sync {
    fn read(&self) -> StorageResult<Option<String>>;
    fn write(&self, value: &str) -> StorageResult<()>;
}

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
struct Vault {
    credentials: BTreeMap<String, S3Credentials>,
}

struct Snapshot {
    revision: String,
    vault: Vault,
}

struct CredentialVault<B> {
    storage: B,
    lock_path: Option<PathBuf>,
    snapshot: Mutex<Option<Snapshot>>,
}

impl<B: VaultStorage> CredentialVault<B> {
    fn new(storage: B, lock_path: Option<PathBuf>) -> Self {
        Self {
            storage,
            lock_path,
            snapshot: Mutex::new(None),
        }
    }

    fn lock(&self) -> StorageResult<File> {
        let path = self.lock_path.as_ref().ok_or_else(error)?;
        std::fs::create_dir_all(path.parent().ok_or_else(error)?).map_err(|_| error())?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(path).map_err(|_| error())?;
        file.lock().map_err(|_| error())?;
        Ok(file)
    }

    fn load<'a>(
        &self,
        file: &mut File,
        cached: &'a mut Option<Snapshot>,
    ) -> StorageResult<&'a mut Snapshot> {
        let mut revision = String::new();
        file.read_to_string(&mut revision).map_err(|_| error())?;
        if cached.as_ref().is_none_or(|s| s.revision != revision) {
            let vault = match self.storage.read()? {
                Some(value) => serde_json::from_str(&value).map_err(|_| error())?,
                None => Vault::default(),
            };
            *cached = Some(Snapshot { revision, vault });
        }
        cached.as_mut().ok_or_else(error)
    }

    fn save(&self, file: &mut File, snapshot: &mut Snapshot, vault: Vault) -> StorageResult<()> {
        let value = serde_json::to_string(&vault).map_err(|_| error())?;
        let revision = uuid::Uuid::new_v4().to_string();
        // Invalidate other processes BEFORE changing the keychain so a crash
        // between the two writes cannot leave an apparently current old cache.
        file.seek(SeekFrom::Start(0)).map_err(|_| error())?;
        file.set_len(0).map_err(|_| error())?;
        file.write_all(revision.as_bytes()).map_err(|_| error())?;
        file.sync_all().map_err(|_| error())?;
        self.storage.write(&value)?;
        *snapshot = Snapshot { revision, vault };
        Ok(())
    }
}

impl<B: VaultStorage> CredentialStore for CredentialVault<B> {
    fn get(&self, reference: &str) -> StorageResult<S3Credentials> {
        check_reference(reference)?;
        let mut cached = self.snapshot.lock().map_err(|_| error())?;
        let mut file = self.lock()?;
        let snapshot = self.load(&mut file, &mut cached)?;
        snapshot
            .vault
            .credentials
            .get(reference)
            .cloned()
            .ok_or_else(error)
    }

    fn set(&self, reference: &str, credentials: &S3Credentials) -> StorageResult<()> {
        check_reference(reference)?;
        let mut cached = self.snapshot.lock().map_err(|_| error())?;
        let mut file = self.lock()?;
        let snapshot = self.load(&mut file, &mut cached)?;
        let mut vault = snapshot.vault.clone();
        vault
            .credentials
            .insert(reference.into(), credentials.clone());
        self.save(&mut file, snapshot, vault)
    }

    fn delete(&self, reference: &str) -> StorageResult<()> {
        check_reference(reference)?;
        let mut cached = self.snapshot.lock().map_err(|_| error())?;
        let mut file = self.lock()?;
        let snapshot = self.load(&mut file, &mut cached)?;
        let mut vault = snapshot.vault.clone();
        if vault.credentials.remove(reference).is_none() {
            return Ok(());
        }
        // Keep an empty vault so deleting the final connection preserves its ACL.
        self.save(&mut file, snapshot, vault)
    }
}

#[cfg(target_os = "macos")]
struct KeychainVault {
    service: String,
}

#[cfg(target_os = "macos")]
impl VaultStorage for KeychainVault {
    fn read(&self) -> StorageResult<Option<String>> {
        match keyring::Entry::new(&self.service, ACCOUNT)
            .map_err(|_| error())?
            .get_password()
        {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(error()),
        }
    }
    fn write(&self, value: &str) -> StorageResult<()> {
        keyring::Entry::new(&self.service, ACCOUNT)
            .map_err(|_| error())?
            .set_password(value)
            .map_err(|_| error())
    }
}

#[cfg(target_os = "macos")]
pub(super) fn system() -> &'static impl CredentialStore {
    static STORE: std::sync::OnceLock<CredentialVault<KeychainVault>> = std::sync::OnceLock::new();
    STORE.get_or_init(|| {
        CredentialVault::new(
            KeychainVault {
                service: "dev.filo.desktop.s3".into(),
            },
            std::env::var_os("HOME").map(|home| {
                PathBuf::from(home)
                    .join("Library/Application Support/dev.filo.desktop/credentials.lock")
            }),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[derive(Default)]
    struct State {
        value: Option<String>,
        reads: usize,
        writes: usize,
        deny_reads: bool,
        fail_writes: bool,
    }
    #[derive(Clone, Default)]
    struct MemoryVault(Arc<Mutex<State>>);
    impl VaultStorage for MemoryVault {
        fn read(&self) -> StorageResult<Option<String>> {
            let mut state = self.0.lock().unwrap();
            state.reads += 1;
            if state.deny_reads {
                return Err(error());
            }
            Ok(state.value.clone())
        }
        fn write(&self, value: &str) -> StorageResult<()> {
            let mut state = self.0.lock().unwrap();
            state.writes += 1;
            if state.fail_writes {
                return Err(error());
            }
            state.value = Some(value.into());
            Ok(())
        }
    }
    fn credential(key: &str) -> S3Credentials {
        S3Credentials {
            access_key_id: key.into(),
            secret_access_key: format!("secret-{key}"),
            session_token: Some(format!("token-{key}")),
        }
    }
    fn store(storage: &MemoryVault, dir: &tempfile::TempDir) -> CredentialVault<MemoryVault> {
        CredentialVault::new(storage.clone(), Some(dir.path().join("credentials.lock")))
    }
    #[test]
    fn different_connections_and_parallel_reads_share_one_unlock_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let storage = MemoryVault::default();
        let initial = store(&storage, &dir);
        for reference in ["a", "b", "c"] {
            initial.set(reference, &credential(reference)).unwrap();
        }
        storage.0.lock().unwrap().reads = 0;
        let reopened = Arc::new(store(&storage, &dir));
        let threads: Vec<_> = (0..12)
            .map(|index| {
                let reopened = reopened.clone();
                std::thread::spawn(move || {
                    let reference = ["a", "b", "c"][index % 3];
                    let value = reopened.get(reference).unwrap();
                    assert_eq!(value.access_key_id, reference);
                    assert_eq!(value.secret_access_key, format!("secret-{reference}"));
                    assert_eq!(value.session_token, Some(format!("token-{reference}")));
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(storage.0.lock().unwrap().reads, 1);
        assert!(storage.0.lock().unwrap().value.is_some());
        let writes = storage.0.lock().unwrap().writes;
        assert!(reopened.get("missing").is_err());
        assert_eq!(storage.0.lock().unwrap().reads, 1);
        assert_eq!(storage.0.lock().unwrap().writes, writes);
        // No credentials, references or tokens are written to the coordination file.
        let revision = std::fs::read_to_string(dir.path().join("credentials.lock")).unwrap();
        assert!(uuid::Uuid::parse_str(&revision).is_ok());
    }

    #[test]
    fn denied_or_corrupt_vault_is_never_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let storage = MemoryVault::default();
        store(&storage, &dir).set("a", &credential("a")).unwrap();
        let original = storage.0.lock().unwrap().value.clone();
        storage.0.lock().unwrap().deny_reads = true;
        storage.0.lock().unwrap().reads = 0;
        let current = store(&storage, &dir);
        assert!(current.get("a").is_err());
        assert!(current.set("b", &credential("b")).is_err());
        assert!(current.delete("a").is_err());
        assert_eq!(storage.0.lock().unwrap().reads, 3);
        assert_eq!(storage.0.lock().unwrap().value, original);
        storage.0.lock().unwrap().deny_reads = false;
        assert_eq!(current.get("a").unwrap().access_key_id, "a");
        for corrupt in ["invalid json", "{}", r#"{"credentials":null}"#] {
            storage.0.lock().unwrap().value = Some(corrupt.into());
            let reopened = store(&storage, &dir);
            assert!(reopened.get("a").is_err());
            assert!(reopened.set("b", &credential("b")).is_err());
            assert_eq!(storage.0.lock().unwrap().value.as_deref(), Some(corrupt));
        }
    }

    #[test]
    fn mutations_preserve_other_connections_and_failures_keep_old_values() {
        let dir = tempfile::tempdir().unwrap();
        let storage = MemoryVault::default();
        let current = store(&storage, &dir);
        current.set("a", &credential("a")).unwrap();
        current.set("b", &credential("b")).unwrap();
        storage.0.lock().unwrap().fail_writes = true;
        assert!(current.set("a", &credential("changed")).is_err());
        assert_eq!(current.get("a").unwrap().access_key_id, "a");
        assert!(current.delete("b").is_err());
        assert_eq!(current.get("b").unwrap().access_key_id, "b");
        storage.0.lock().unwrap().fail_writes = false;
        current.set("a", &credential("changed")).unwrap();
        current.delete("b").unwrap();
        let reopened = store(&storage, &dir);
        assert_eq!(reopened.get("a").unwrap().access_key_id, "changed");
        assert!(reopened.get("b").is_err());
        reopened.delete("a").unwrap();
        let vault: Vault =
            serde_json::from_str(storage.0.lock().unwrap().value.as_deref().unwrap()).unwrap();
        assert!(vault.credentials.is_empty());
    }

    #[test]
    fn independent_instances_merge_changes_instead_of_overwriting_stale_snapshots() {
        let dir = tempfile::tempdir().unwrap();
        let storage = MemoryVault::default();
        let first = store(&storage, &dir);
        let second = store(&storage, &dir);
        first.set("a", &credential("a")).unwrap();
        second.get("a").unwrap(); // Cache the old revision in another instance.
        first.set("b", &credential("b")).unwrap();
        second.set("c", &credential("c")).unwrap();
        first.delete("a").unwrap();
        second.set("d", &credential("d")).unwrap();
        let reopened = store(&storage, &dir);
        assert!(reopened.get("a").is_err());
        for reference in ["b", "c", "d"] {
            assert_eq!(reopened.get(reference).unwrap().access_key_id, reference);
        }
        let reads = storage.0.lock().unwrap().reads;
        reopened.get("c").unwrap();
        assert_eq!(storage.0.lock().unwrap().reads, reads);
    }

    #[test]
    fn parallel_writers_with_separate_locks_preserve_all_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let storage = MemoryVault::default();
        let threads: Vec<_> = (0..8)
            .map(|index| {
                let writer = store(&storage, &dir);
                std::thread::spawn(move || {
                    writer
                        .set(&index.to_string(), &credential(&index.to_string()))
                        .unwrap()
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let reopened = store(&storage, &dir);
        for index in 0..8 {
            assert_eq!(
                reopened.get(&index.to_string()).unwrap().access_key_id,
                index.to_string()
            );
        }
    }

    #[test]
    fn reserved_reference_cannot_delete_the_shared_vault() {
        let dir = tempfile::tempdir().unwrap();
        let storage = MemoryVault::default();
        let current = store(&storage, &dir);
        current.set("a", &credential("a")).unwrap();
        for reference in [ACCOUNT, ""] {
            assert!(current.get(reference).is_err());
            assert!(current.set(reference, &credential("bad")).is_err());
            assert!(current.delete(reference).is_err());
        }
        assert_eq!(current.get("a").unwrap().access_key_id, "a");
    }

    // Explicit opt-in: this creates only synthetic credentials under a unique
    // service name, disables system dialogs, and removes the test item on exit.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires an unlocked macOS keychain; creates an isolated temporary test item"]
    fn native_keychain_roundtrip_uses_one_shared_item() {
        #[link(name = "Security", kind = "framework")]
        unsafe extern "C" {
            fn SecKeychainGetUserInteractionAllowed(allowed: *mut u8) -> i32;
            fn SecKeychainSetUserInteractionAllowed(allowed: u8) -> i32;
        }
        struct Cleanup {
            service: String,
            interaction: u8,
        }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                if let Ok(entry) = keyring::Entry::new(&self.service, ACCOUNT) {
                    let _ = entry.delete_credential();
                }
                // SAFETY: Security.framework accepts a Boolean (unsigned byte).
                unsafe {
                    SecKeychainSetUserInteractionAllowed(self.interaction);
                }
            }
        }
        let mut interaction = 0;
        // SAFETY: the out-pointer is valid; these calls change only this process.
        unsafe {
            assert_eq!(SecKeychainGetUserInteractionAllowed(&mut interaction), 0);
            assert_eq!(SecKeychainSetUserInteractionAllowed(0), 0);
        }
        let cleanup = Cleanup {
            service: format!("dev.filo.test.vault.{}", uuid::Uuid::new_v4()),
            interaction,
        };
        let dir = tempfile::tempdir().unwrap();
        let open = || {
            CredentialVault::new(
                KeychainVault {
                    service: cleanup.service.clone(),
                },
                Some(dir.path().join("credentials.lock")),
            )
        };
        let original = open();
        original.set("a", &credential("a")).unwrap();
        original.set("b", &credential("b")).unwrap();
        let saved: Vault =
            serde_json::from_str(&original.storage.read().unwrap().unwrap()).unwrap();
        assert_eq!(saved.credentials.len(), 2);
        let reopened = open();
        for reference in ["a", "b"] {
            let value = reopened.get(reference).unwrap();
            assert_eq!(value.secret_access_key, format!("secret-{reference}"));
            assert_eq!(value.session_token, Some(format!("token-{reference}")));
        }
        reopened.delete("a").unwrap();
        assert!(open().get("a").is_err());
        assert_eq!(open().get("b").unwrap().access_key_id, "b");
        keyring::Entry::new(&cleanup.service, ACCOUNT)
            .unwrap()
            .delete_credential()
            .unwrap();
        assert!(reopened.storage.read().unwrap().is_none());
    }
}
