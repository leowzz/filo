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

// Missing items must be distinguished from locked/denied/corrupt items. Only a
// missing vault can be initialized; treating other failures as empty loses data.
trait Items: Send + Sync {
    fn read(&self, account: &str) -> StorageResult<Option<String>>;
    fn write(&self, account: &str, value: &str) -> StorageResult<()>;
    fn delete(&self, account: &str) -> StorageResult<()>;
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
    items: B,
    lock_path: Option<PathBuf>,
    snapshot: Mutex<Option<Snapshot>>,
}

impl<B: Items> CredentialVault<B> {
    fn new(items: B, lock_path: Option<PathBuf>) -> Self {
        Self {
            items,
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
            let vault = match self.items.read(ACCOUNT)? {
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
        self.items.write(ACCOUNT, &value)?;
        *snapshot = Snapshot { revision, vault };
        Ok(())
    }
}

impl<B: Items> CredentialStore for CredentialVault<B> {
    fn get(&self, reference: &str) -> StorageResult<S3Credentials> {
        check_reference(reference)?;
        let mut cached = self.snapshot.lock().map_err(|_| error())?;
        let mut file = self.lock()?;
        let snapshot = self.load(&mut file, &mut cached)?;
        if let Some(credentials) = snapshot.vault.credentials.get(reference) {
            return Ok(credentials.clone());
        }
        // Old per-connection ACLs still require the user's authorization once.
        // Never remove the source until the merged vault is safely persisted.
        let value = self.items.read(reference)?.ok_or_else(error)?;
        let credentials: S3Credentials = serde_json::from_str(&value).map_err(|_| error())?;
        let mut vault = snapshot.vault.clone();
        vault
            .credentials
            .insert(reference.into(), credentials.clone());
        self.save(&mut file, snapshot, vault)?;
        // A cleanup failure must not make an already migrated connection fail.
        // Explicit deletion retries cleanup before removing the vault entry.
        let _ = self.items.delete(reference);
        Ok(credentials)
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
        // Also remove any surviving legacy copy, otherwise a later lookup could
        // resurrect deleted credentials through the migration fallback.
        self.items.delete(reference)?;
        let mut vault = snapshot.vault.clone();
        if vault.credentials.remove(reference).is_none() {
            return Ok(());
        }
        // Keep an empty vault so deleting the final connection preserves its ACL.
        self.save(&mut file, snapshot, vault)
    }
}

#[cfg(target_os = "macos")]
struct KeychainItems {
    service: String,
}

#[cfg(target_os = "macos")]
impl Items for KeychainItems {
    fn read(&self, account: &str) -> StorageResult<Option<String>> {
        match keyring::Entry::new(&self.service, account)
            .map_err(|_| error())?
            .get_password()
        {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(error()),
        }
    }
    fn write(&self, account: &str, value: &str) -> StorageResult<()> {
        keyring::Entry::new(&self.service, account)
            .map_err(|_| error())?
            .set_password(value)
            .map_err(|_| error())
    }
    fn delete(&self, account: &str) -> StorageResult<()> {
        match keyring::Entry::new(&self.service, account)
            .map_err(|_| error())?
            .delete_credential()
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(error()),
        }
    }
}

#[cfg(target_os = "macos")]
pub(super) fn system() -> &'static impl CredentialStore {
    static STORE: std::sync::OnceLock<CredentialVault<KeychainItems>> = std::sync::OnceLock::new();
    STORE.get_or_init(|| {
        CredentialVault::new(
            KeychainItems {
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
        values: BTreeMap<String, String>,
        reads: Vec<String>,
        writes: usize,
        deny_reads: bool,
        fail_writes: bool,
        fail_deletes: bool,
    }
    #[derive(Clone, Default)]
    struct MemoryItems(Arc<Mutex<State>>);
    impl Items for MemoryItems {
        fn read(&self, account: &str) -> StorageResult<Option<String>> {
            let mut state = self.0.lock().unwrap();
            state.reads.push(account.into());
            if state.deny_reads {
                return Err(error());
            }
            Ok(state.values.get(account).cloned())
        }
        fn write(&self, account: &str, value: &str) -> StorageResult<()> {
            let mut state = self.0.lock().unwrap();
            state.writes += 1;
            if state.fail_writes {
                return Err(error());
            }
            state.values.insert(account.into(), value.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> StorageResult<()> {
            let mut state = self.0.lock().unwrap();
            if state.fail_deletes {
                return Err(error());
            }
            state.values.remove(account);
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
    fn store(items: &MemoryItems, dir: &tempfile::TempDir) -> CredentialVault<MemoryItems> {
        CredentialVault::new(items.clone(), Some(dir.path().join("credentials.lock")))
    }
    fn legacy(items: &MemoryItems, reference: &str) {
        items.0.lock().unwrap().values.insert(
            reference.into(),
            serde_json::to_string(&credential(reference)).unwrap(),
        );
    }
    fn vault_read_count(items: &MemoryItems) -> usize {
        items
            .0
            .lock()
            .unwrap()
            .reads
            .iter()
            .filter(|r| *r == ACCOUNT)
            .count()
    }

    #[test]
    fn different_connections_and_parallel_reads_share_one_unlock_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let items = MemoryItems::default();
        let initial = store(&items, &dir);
        for reference in ["a", "b", "c"] {
            initial.set(reference, &credential(reference)).unwrap();
        }
        items.0.lock().unwrap().reads.clear();
        let reopened = Arc::new(store(&items, &dir));
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
        assert_eq!(items.0.lock().unwrap().reads, [ACCOUNT]);
        assert_eq!(items.0.lock().unwrap().values.len(), 1);
        // No credentials, references or tokens are written to the coordination file.
        let revision = std::fs::read_to_string(dir.path().join("credentials.lock")).unwrap();
        assert!(uuid::Uuid::parse_str(&revision).is_ok());
    }

    #[test]
    fn legacy_items_migrate_once_and_then_share_the_vault() {
        let dir = tempfile::tempdir().unwrap();
        let items = MemoryItems::default();
        legacy(&items, "a");
        legacy(&items, "b");
        let current = store(&items, &dir);
        assert_eq!(current.get("a").unwrap().access_key_id, "a");
        assert_eq!(current.get("b").unwrap().access_key_id, "b");
        assert_eq!(items.0.lock().unwrap().reads, [ACCOUNT, "a", "b"]);
        assert_eq!(items.0.lock().unwrap().values.len(), 1);
        items.0.lock().unwrap().reads.clear();
        let reopened = store(&items, &dir);
        reopened.get("a").unwrap();
        reopened.get("b").unwrap();
        assert_eq!(items.0.lock().unwrap().reads, [ACCOUNT]);
    }

    #[test]
    fn failed_migration_preserves_source_and_does_not_cache_unpersisted_value() {
        let dir = tempfile::tempdir().unwrap();
        let items = MemoryItems::default();
        legacy(&items, "a");
        items.0.lock().unwrap().fail_writes = true;
        let current = store(&items, &dir);
        assert!(current.get("a").is_err());
        assert!(items.0.lock().unwrap().values.contains_key("a"));
        assert!(!items.0.lock().unwrap().values.contains_key(ACCOUNT));
        items.0.lock().unwrap().fail_writes = false;
        assert_eq!(current.get("a").unwrap().access_key_id, "a");
        assert!(!items.0.lock().unwrap().values.contains_key("a"));
    }

    #[test]
    fn denied_or_corrupt_vault_is_never_replaced_or_bypassed_by_legacy_read() {
        let dir = tempfile::tempdir().unwrap();
        let items = MemoryItems::default();
        store(&items, &dir).set("a", &credential("a")).unwrap();
        let original = items.0.lock().unwrap().values[ACCOUNT].clone();
        items.0.lock().unwrap().deny_reads = true;
        items.0.lock().unwrap().reads.clear();
        let current = store(&items, &dir);
        assert!(current.get("a").is_err());
        assert!(current.set("b", &credential("b")).is_err());
        assert!(current.delete("a").is_err());
        assert!(items.0.lock().unwrap().reads.iter().all(|r| r == ACCOUNT));
        assert_eq!(items.0.lock().unwrap().values[ACCOUNT], original);
        items.0.lock().unwrap().deny_reads = false;
        assert_eq!(current.get("a").unwrap().access_key_id, "a");
        for corrupt in ["invalid json", "{}", r#"{"credentials":null}"#] {
            items
                .0
                .lock()
                .unwrap()
                .values
                .insert(ACCOUNT.into(), corrupt.into());
            let reopened = store(&items, &dir);
            assert!(reopened.get("a").is_err());
            assert!(reopened.set("b", &credential("b")).is_err());
            assert_eq!(items.0.lock().unwrap().values[ACCOUNT], corrupt);
        }
    }

    #[test]
    fn mutations_preserve_other_connections_and_failures_keep_old_values() {
        let dir = tempfile::tempdir().unwrap();
        let items = MemoryItems::default();
        let current = store(&items, &dir);
        current.set("a", &credential("a")).unwrap();
        current.set("b", &credential("b")).unwrap();
        items.0.lock().unwrap().fail_writes = true;
        assert!(current.set("a", &credential("changed")).is_err());
        assert_eq!(current.get("a").unwrap().access_key_id, "a");
        assert!(current.delete("b").is_err());
        assert_eq!(current.get("b").unwrap().access_key_id, "b");
        items.0.lock().unwrap().fail_writes = false;
        current.set("a", &credential("changed")).unwrap();
        current.delete("b").unwrap();
        let reopened = store(&items, &dir);
        assert_eq!(reopened.get("a").unwrap().access_key_id, "changed");
        assert!(reopened.get("b").is_err());
        reopened.delete("a").unwrap();
        let vault: Vault = serde_json::from_str(&items.0.lock().unwrap().values[ACCOUNT]).unwrap();
        assert!(vault.credentials.is_empty());
    }

    #[test]
    fn cleanup_failure_preserves_migrated_value_and_delete_cannot_resurrect_it() {
        let dir = tempfile::tempdir().unwrap();
        let items = MemoryItems::default();
        legacy(&items, "a");
        items.0.lock().unwrap().fail_deletes = true;
        let current = store(&items, &dir);
        assert_eq!(current.get("a").unwrap().access_key_id, "a");
        assert!(current.delete("a").is_err());
        assert_eq!(current.get("a").unwrap().access_key_id, "a");
        items.0.lock().unwrap().fail_deletes = false;
        current.delete("a").unwrap();
        assert!(store(&items, &dir).get("a").is_err());
        assert!(!items.0.lock().unwrap().values.contains_key("a"));
    }

    #[test]
    fn independent_instances_merge_changes_instead_of_overwriting_stale_snapshots() {
        let dir = tempfile::tempdir().unwrap();
        let items = MemoryItems::default();
        let first = store(&items, &dir);
        let second = store(&items, &dir);
        first.set("a", &credential("a")).unwrap();
        second.get("a").unwrap(); // Cache the old revision in another instance.
        first.set("b", &credential("b")).unwrap();
        second.set("c", &credential("c")).unwrap();
        first.delete("a").unwrap();
        second.set("d", &credential("d")).unwrap();
        let reopened = store(&items, &dir);
        assert!(reopened.get("a").is_err());
        for reference in ["b", "c", "d"] {
            assert_eq!(reopened.get(reference).unwrap().access_key_id, reference);
        }
        let reads = vault_read_count(&items);
        reopened.get("c").unwrap();
        assert_eq!(vault_read_count(&items), reads);
    }

    #[test]
    fn parallel_writers_with_separate_locks_preserve_all_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let items = MemoryItems::default();
        let threads: Vec<_> = (0..8)
            .map(|index| {
                let writer = store(&items, &dir);
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
        let reopened = store(&items, &dir);
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
        let items = MemoryItems::default();
        let current = store(&items, &dir);
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
                let items = KeychainItems {
                    service: self.service.clone(),
                };
                for account in [ACCOUNT, "legacy", "a", "b"] {
                    let _ = items.delete(account);
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
                KeychainItems {
                    service: cleanup.service.clone(),
                },
                Some(dir.path().join("credentials.lock")),
            )
        };
        let original = open();
        original
            .items
            .write(
                "legacy",
                &serde_json::to_string(&credential("legacy")).unwrap(),
            )
            .unwrap();
        original.get("legacy").unwrap();
        original.set("a", &credential("a")).unwrap();
        original.set("b", &credential("b")).unwrap();
        assert!(original.items.read("legacy").unwrap().is_none());
        assert!(original.items.read("a").unwrap().is_none());
        assert!(original.items.read("b").unwrap().is_none());
        let reopened = open();
        for reference in ["legacy", "a", "b"] {
            let value = reopened.get(reference).unwrap();
            assert_eq!(value.secret_access_key, format!("secret-{reference}"));
            assert_eq!(value.session_token, Some(format!("token-{reference}")));
        }
        reopened.delete("a").unwrap();
        assert!(open().get("a").is_err());
        assert_eq!(open().get("b").unwrap().access_key_id, "b");
        reopened.items.delete(ACCOUNT).unwrap();
        assert!(reopened.items.read(ACCOUNT).unwrap().is_none());
    }
}
