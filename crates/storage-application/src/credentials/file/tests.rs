use super::*;

fn store(dir: &tempfile::TempDir) -> FileCredentialStore {
    FileCredentialStore::new(Some(dir.path().join("credentials.json")))
}
fn value(name: &str) -> S3Credentials {
    S3Credentials {
        access_key_id: name.into(),
        secret_access_key: format!("secret-{name}"),
        session_token: Some("token".into()),
    }
}
fn bytes(dir: &tempfile::TempDir) -> Vec<u8> {
    std::fs::read(dir.path().join("credentials.json")).unwrap()
}

#[test]
fn default_plain_survives_restart_and_preserves_separate_connections() {
    let dir = tempfile::tempdir().unwrap();
    let first = store(&dir);
    assert!(first.status().unwrap().mode == CredentialMode::Plain);
    first.set("a", &value("a")).unwrap();
    first.set("b", &value("b")).unwrap();
    let reopened = store(&dir);
    assert_eq!(reopened.get("a").unwrap().secret_access_key, "secret-a");
    assert_eq!(
        reopened.get("b").unwrap().session_token.as_deref(),
        Some("token")
    );
    reopened.delete("a").unwrap();
    assert_eq!(
        first.get("a").err().unwrap().code,
        StorageErrorCode::CredentialsRequired
    );
    assert_eq!(first.get("b").unwrap().access_key_id, "b");
    let document: Document = serde_json::from_slice(&bytes(&dir)).unwrap();
    let Contents::Plain { data } = document.contents else {
        panic!("ordinary mode");
    };
    assert!(String::from_utf8(decode(&data).unwrap())
        .unwrap()
        .contains("secret-b"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(dir.path().join("credentials.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn master_encrypts_all_fields_and_requires_one_unlock_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let first = store(&dir);
    first.set("a", &value("a")).unwrap();
    first
        .configure(CredentialMode::Master, Some("correct password"), None)
        .unwrap();
    first.set("b", &value("b")).unwrap();
    let encrypted = bytes(&dir);
    assert!(!String::from_utf8_lossy(&encrypted).contains("secret-a"));
    let reopened = store(&dir);
    assert!(reopened.status().unwrap().locked);
    assert_eq!(
        reopened.get("a").err().unwrap().code,
        StorageErrorCode::CredentialsLocked
    );
    assert!(reopened.unlock("wrong password").is_err());
    assert_eq!(bytes(&dir), encrypted);
    assert!(reopened.status().unwrap().locked);
    reopened.unlock("correct password").unwrap();
    for reference in ["a", "b"] {
        assert_eq!(reopened.get(reference).unwrap().access_key_id, reference);
    }
    assert!(!reopened.status().unwrap().locked);
    // Every write gets a fresh nonce, even when the plaintext is unchanged.
    reopened.set("b", &value("b")).unwrap();
    assert_ne!(bytes(&dir), encrypted);
}

#[test]
fn memory_mode_removes_saved_secrets_but_retains_this_process() {
    let dir = tempfile::tempdir().unwrap();
    let first = store(&dir);
    first.set("a", &value("a")).unwrap();
    first.configure(CredentialMode::Memory, None, None).unwrap();
    first.set("b", &value("b")).unwrap();
    assert_eq!(first.get("a").unwrap().secret_access_key, "secret-a");
    let document: Document = serde_json::from_slice(&bytes(&dir)).unwrap();
    assert!(matches!(document.contents, Contents::Memory));
    let missing = store(&dir).get("a").err().unwrap();
    assert_eq!(missing.code, StorageErrorCode::CredentialsRequired);
    assert_eq!(missing.credential_ref.as_deref(), Some("a"));
    first.configure(CredentialMode::Plain, None, None).unwrap();
    assert_eq!(store(&dir).get("b").unwrap().secret_access_key, "secret-b");
}

#[test]
fn removing_or_rotating_master_verifies_current_password_even_when_unlocked() {
    let dir = tempfile::tempdir().unwrap();
    let first = store(&dir);
    first.set("a", &value("a")).unwrap();
    first
        .configure(CredentialMode::Master, Some("old password"), None)
        .unwrap();
    let original = bytes(&dir);
    assert!(first.configure(CredentialMode::Plain, None, None).is_err());
    assert!(first
        .configure(CredentialMode::Plain, None, Some("wrong password"))
        .is_err());
    assert!(first
        .configure(CredentialMode::Master, Some("short"), Some("old password"))
        .is_err());
    assert_eq!(bytes(&dir), original);
    first
        .configure(
            CredentialMode::Master,
            Some("new password"),
            Some("old password"),
        )
        .unwrap();
    assert!(store(&dir).unlock("old password").is_err());
    let reopened = store(&dir);
    reopened.unlock("new password").unwrap();
    reopened
        .configure(CredentialMode::Plain, None, Some("new password"))
        .unwrap();
    assert_eq!(store(&dir).get("a").unwrap().secret_access_key, "secret-a");
}

#[test]
fn changed_mode_or_password_invalidates_other_processes() {
    let dir = tempfile::tempdir().unwrap();
    let first = store(&dir);
    let other = store(&dir);
    first.set("a", &value("a")).unwrap();
    other.get("a").unwrap();
    first
        .configure(CredentialMode::Master, Some("old password"), None)
        .unwrap();
    assert_eq!(
        other.get("a").err().unwrap().code,
        StorageErrorCode::CredentialsLocked
    );
    other.unlock("old password").unwrap();
    first
        .configure(
            CredentialMode::Master,
            Some("new password"),
            Some("old password"),
        )
        .unwrap();
    assert_eq!(
        other.set("b", &value("b")).err().unwrap().code,
        StorageErrorCode::CredentialsLocked
    );
    other.unlock("new password").unwrap();
    assert_eq!(other.get("a").unwrap().access_key_id, "a");
    first
        .configure(CredentialMode::Memory, None, Some("new password"))
        .unwrap();
    assert_eq!(
        other.get("a").err().unwrap().code,
        StorageErrorCode::CredentialsRequired
    );
}

#[test]
fn corrupt_and_tampered_files_are_not_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let first = store(&dir);
    first.set("a", &value("a")).unwrap();
    first
        .configure(CredentialMode::Master, Some("correct password"), None)
        .unwrap();
    let mut document: Document = serde_json::from_slice(&bytes(&dir)).unwrap();
    if let Contents::Master { data, .. } = &mut document.contents {
        *data = STANDARD.encode(b"tampered");
    }
    std::fs::write(
        dir.path().join("credentials.json"),
        serde_json::to_vec(&document).unwrap(),
    )
    .unwrap();
    let tampered = bytes(&dir);
    assert!(first.set("b", &value("b")).is_err());
    assert!(store(&dir).unlock("correct password").is_err());
    assert_eq!(bytes(&dir), tampered);
    for corrupt_bytes in [b"not json".as_slice(), b"{}", br#"{"version":2}"#] {
        std::fs::write(dir.path().join("credentials.json"), corrupt_bytes).unwrap();
        assert!(first.set("b", &value("b")).is_err());
        assert!(first.delete("a").is_err());
        assert_eq!(bytes(&dir), corrupt_bytes);
    }
    assert!(first.reset(false).is_err());
    first.reset(true).unwrap();
    assert_eq!(
        first.get("a").err().unwrap().code,
        StorageErrorCode::CredentialsRequired
    );
    first.set("b", &value("b")).unwrap();
}

#[test]
fn independent_parallel_writers_merge_changes() {
    let dir = tempfile::tempdir().unwrap();
    let writers: Vec<_> = (0..12)
        .map(|i| {
            let writer = store(&dir);
            std::thread::spawn(move || writer.set(&i.to_string(), &value(&i.to_string())).unwrap())
        })
        .collect();
    for writer in writers {
        writer.join().unwrap();
    }
    let reopened = store(&dir);
    for i in 0..12 {
        assert_eq!(
            reopened.get(&i.to_string()).unwrap().access_key_id,
            i.to_string()
        );
    }
}

#[test]
fn migration_preserves_local_changes_and_never_overwrites_on_denied_reads() {
    let dir = tempfile::tempdir().unwrap();
    let first = store(&dir);
    first.set("a", &value("updated")).unwrap();
    let original = bytes(&dir);
    assert!(first
        .import_from(|| Err(StorageError::new(StorageErrorCode::AccessDenied, "denied")))
        .is_err());
    assert_eq!(bytes(&dir), original);
    assert!(first.status().unwrap().legacy_import_available);
    let imported = BTreeMap::from([("a".into(), value("old")), ("b".into(), value("b"))]);
    assert_eq!(first.import_from(|| Ok(imported)).unwrap(), 1);
    assert_eq!(first.get("a").unwrap().access_key_id, "updated");
    assert_eq!(store(&dir).get("b").unwrap().access_key_id, "b");
    assert!(!first.status().unwrap().legacy_import_available);
}

#[test]
fn migration_obeys_memory_mode_and_locked_master_cannot_import() {
    let dir = tempfile::tempdir().unwrap();
    let first = store(&dir);
    first.configure(CredentialMode::Memory, None, None).unwrap();
    first
        .import_from(|| Ok(BTreeMap::from([("a".into(), value("a"))])))
        .unwrap();
    assert_eq!(first.get("a").unwrap().access_key_id, "a");
    assert!(store(&dir).get("a").is_err());
    assert!(store(&dir).status().unwrap().legacy_import_available);
    first
        .configure(CredentialMode::Master, Some("correct password"), None)
        .unwrap();
    assert!(store(&dir)
        .import_from(|| panic!("must unlock before accessing legacy storage"))
        .is_err());
    let reopened = store(&dir);
    reopened.unlock("correct password").unwrap();
    assert_eq!(reopened.get("a").unwrap().access_key_id, "a");
}

async fn saved_connection(
    dir: &tempfile::TempDir,
    remote: bool,
) -> (storage_repository::Repository, StorageVolume, String) {
    let repository = storage_repository::Repository::open(&dir.path().join("test.sqlite"))
        .await
        .unwrap();
    let reference = if remote {
        super::super::remote_reference(uuid::Uuid::new_v4())
    } else {
        uuid::Uuid::new_v4().to_string()
    };
    let connection = StorageConnection {
        id: uuid::Uuid::new_v4(),
        name: "test".into(),
        provider: if remote {
            ProviderKind::Remote
        } else {
            ProviderKind::S3
        },
        config: serde_json::json!({}),
        credential_ref: Some(reference.clone()),
        enabled: true,
    };
    let volume = StorageVolume {
        id: uuid::Uuid::new_v4(),
        connection_id: connection.id,
        name: "test".into(),
        read_only: false,
        root: if remote {
            VolumeRoot::Remote {
                path: String::new(),
            }
        } else {
            VolumeRoot::S3 {
                bucket: "test".into(),
                prefix: String::new(),
            }
        },
    };
    if remote {
        repository.save_remote(&connection, &volume).await.unwrap();
    } else {
        repository.save_s3(&connection, &volume).await.unwrap();
    }
    (repository, volume, reference)
}

#[tokio::test]
async fn reentry_only_accepts_existing_refs_and_matching_credential_types() {
    let dir = tempfile::tempdir().unwrap();
    let (repository, _, reference) = saved_connection(&dir, false).await;
    let credentials = std::sync::Arc::new(store(&dir));
    let service = crate::StorageService::with_credentials(repository.clone(), credentials.clone());
    assert_eq!(
        service
            .provide_connection_credentials("unrelated".into(), Some(value("a")), None)
            .await
            .err()
            .unwrap()
            .code,
        StorageErrorCode::NotFound
    );
    assert_eq!(
        service
            .provide_connection_credentials(reference.clone(), None, None)
            .await
            .err()
            .unwrap()
            .code,
        StorageErrorCode::InvalidConfiguration
    );
    assert!(credentials.get(&reference).is_err());
    service
        .provide_connection_credentials(reference.clone(), Some(value("a")), None)
        .await
        .unwrap();
    assert_eq!(
        credentials.get(&reference).unwrap().secret_access_key,
        "secret-a"
    );
    assert!(
        !serde_json::to_string(&repository.list_connections().await.unwrap())
            .unwrap()
            .contains("secret-a")
    );
}

#[tokio::test]
async fn remote_reentry_uses_the_same_store_without_putting_secrets_in_configuration() {
    let dir = tempfile::tempdir().unwrap();
    let (repository, _, reference) = saved_connection(&dir, true).await;
    let credentials = std::sync::Arc::new(store(&dir));
    credentials
        .configure(CredentialMode::Memory, None, None)
        .unwrap();
    let service = crate::StorageService::with_credentials(repository.clone(), credentials.clone());
    assert!(service
        .provide_connection_credentials(reference.clone(), Some(value("a")), None)
        .await
        .is_err());
    let remote = RemoteCredentials {
        username: "user".into(),
        password: "remote-secret".into(),
        private_key: String::new(),
        passphrase: String::new(),
        domain: String::new(),
    };
    service
        .provide_connection_credentials(reference.clone(), None, Some(remote))
        .await
        .unwrap();
    let packed = credentials.get(&reference).unwrap();
    assert_eq!(
        super::super::unpack_remote_credentials(&packed)
            .unwrap()
            .password,
        "remote-secret"
    );
    assert!(store(&dir).get(&reference).is_err());
    assert!(!String::from_utf8_lossy(&bytes(&dir)).contains("remote-secret"));
    assert!(
        !serde_json::to_string(&repository.list_connections().await.unwrap())
            .unwrap()
            .contains("remote-secret")
    );
}

#[tokio::test]
async fn forgetting_session_credentials_does_not_prevent_removing_a_connection() {
    let dir = tempfile::tempdir().unwrap();
    let (repository, volume, _) = saved_connection(&dir, false).await;
    store(&dir)
        .configure(CredentialMode::Memory, None, None)
        .unwrap();
    let service = crate::StorageService::with_credentials(
        repository.clone(),
        std::sync::Arc::new(store(&dir)),
    );
    service.remove_local_storage(volume.id, true).await.unwrap();
    assert!(repository.list_connections().await.unwrap().is_empty());
    assert!(repository.list_volumes().await.unwrap().is_empty());
}

#[test]
fn reset_can_initialize_a_fresh_store_without_a_prior_read() {
    let dir = tempfile::tempdir().unwrap();
    let first = FileCredentialStore::new(Some(dir.path().join("nested/credentials.json")));
    assert!(first.reset(true).unwrap().mode == CredentialMode::Plain);
    first.set("a", &value("a")).unwrap();
    assert_eq!(first.get("a").unwrap().access_key_id, "a");
}
