use provider_opendal::OpenDalS3Backend;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use storage_application::{CredentialStore, StorageService};
use storage_domain::*;
use storage_provider_api::StorageBackend;
use storage_repository::Repository;
use uuid::Uuid;

#[derive(Default)]
struct MemoryCredentials(Mutex<HashMap<String, S3Credentials>>);
impl CredentialStore for MemoryCredentials {
    fn get(&self, key: &str) -> StorageResult<S3Credentials> {
        self.0
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .ok_or_else(|| StorageError::new(StorageErrorCode::NotFound, "missing test credential"))
    }
    fn set(&self, key: &str, value: &S3Credentials) -> StorageResult<()> {
        self.0.lock().unwrap().insert(key.into(), value.clone());
        Ok(())
    }
    fn delete(&self, key: &str) -> StorageResult<()> {
        self.0.lock().unwrap().remove(key);
        Ok(())
    }
}
fn locator(volume: &StorageVolume, path: &str) -> StorageLocator {
    StorageLocator {
        volume_id: volume.id,
        logical_path: path.into(),
        version_id: None,
    }
}
async fn wait(service: &StorageService, job: TransferJob) -> TransferJob {
    tokio::time::timeout(std::time::Duration::from_secs(120), async {
        loop {
            let saved = service
                .list_transfers()
                .await
                .unwrap()
                .into_iter()
                .find(|v| v.id == job.id)
                .unwrap();
            if !saved.state.active() {
                return saved;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("transfer timeout")
}
async fn transfer(
    service: &StorageService,
    kind: TransferKind,
    source: StorageLocator,
    target: StorageLocator,
) -> TransferJob {
    wait(
        service,
        service
            .start_transfer(kind, source, target, Arc::new(|_| {}))
            .await
            .unwrap(),
    )
    .await
}

#[tokio::test]
#[ignore = "requires an explicitly configured disposable S3 test bucket; see docs/11-s3.md"]
async fn rustfs_roundtrip_and_safety() {
    let config_path =
        PathBuf::from(std::env::var("FILO_S3_TEST_CONFIG").expect("FILO_S3_TEST_CONFIG"));
    let config: serde_json::Value =
        serde_json::from_slice(&std::fs::read(config_path).unwrap()).unwrap();
    let credentials = S3Credentials {
        access_key_id: config["access_key_id"].as_str().unwrap().into(),
        secret_access_key: config["secret_access_key"].as_str().unwrap().into(),
        session_token: None,
    };
    let mut input = S3StorageInput {
        name: "RustFS test".into(),
        config: S3ConnectionConfig {
            provider: None,
            endpoint: Some(config["endpoint"].as_str().unwrap().into()),
            region: config["region"].as_str().unwrap().into(),
            force_path_style: true,
        },
        bucket: config["bucket"].as_str().unwrap().into(),
        prefix: format!("filo-tests/{}", Uuid::new_v4()),
        read_only: false,
        credentials: Some(credentials.clone()),
    };
    let database = tempfile::tempdir().unwrap();
    let db = database.path().join("filo.sqlite");
    let store = Arc::new(MemoryCredentials::default());
    let service =
        StorageService::with_credentials(Repository::open(&db).await.unwrap(), store.clone());
    service
        .test_s3_connection(None, input.clone())
        .await
        .unwrap();
    assert!(service.list_volumes().await.unwrap().is_empty());
    let remote = service.save_s3_storage(None, input.clone()).await.unwrap();
    let local_dir = tempfile::tempdir().unwrap();
    let bytes: Vec<u8> = (0..(9 * 1024 * 1024 + 17))
        .map(|i| (i % 251) as u8)
        .collect();
    std::fs::write(local_dir.path().join("sample.bin"), &bytes).unwrap();
    std::fs::write(local_dir.path().join("empty"), []).unwrap();
    let local = service
        .add_selected_directory(local_dir.path().into(), false)
        .await
        .unwrap();
    service
        .create_directory(locator(&remote, ""), "nested".into())
        .await
        .unwrap();
    assert!(service
        .list_entries(locator(&remote, ""))
        .await
        .unwrap()
        .iter()
        .any(|v| v.name == "nested"));
    let uploaded = transfer(
        &service,
        TransferKind::Copy,
        locator(&local, "sample.bin"),
        locator(&remote, "nested/object.bin"),
    )
    .await;
    assert_eq!(
        uploaded.state,
        TransferState::Completed,
        "{:?}",
        uploaded.error_message
    );
    assert_eq!(uploaded.bytes_transferred, bytes.len() as u64);
    assert_eq!(
        transfer(
            &service,
            TransferKind::Copy,
            locator(&remote, "nested/object.bin"),
            locator(&local, "roundtrip.bin")
        )
        .await
        .state,
        TransferState::Completed
    );
    assert_eq!(
        std::fs::read(local_dir.path().join("roundtrip.bin")).unwrap(),
        bytes
    );
    assert_eq!(
        transfer(
            &service,
            TransferKind::Copy,
            locator(&local, "empty"),
            locator(&remote, "empty")
        )
        .await
        .state,
        TransferState::Completed
    );
    service
        .rename_entry(locator(&remote, "nested/object.bin"), "renamed.bin".into())
        .await
        .unwrap();
    assert!(service
        .stat_entry(locator(&remote, "nested/object.bin"))
        .await
        .is_err());
    assert_eq!(
        service
            .stat_entry(locator(&remote, "nested/renamed.bin"))
            .await
            .unwrap()
            .size,
        Some(bytes.len() as u64)
    );
    let duplicate = transfer(
        &service,
        TransferKind::Copy,
        locator(&local, "empty"),
        locator(&remote, "nested/renamed.bin"),
    )
    .await;
    assert_eq!(duplicate.state, TransferState::Failed);
    assert_eq!(
        service
            .stat_entry(locator(&remote, "nested/renamed.bin"))
            .await
            .unwrap()
            .size,
        Some(bytes.len() as u64)
    );

    // Race a newly created target against commit: CopyObject MUST enforce If-None-Match.
    let backend = OpenDalS3Backend::new(&remote, &input.config, &credentials).unwrap();
    let mut first = backend
        .stage_write(&locator(&remote, "race"))
        .await
        .unwrap();
    first.write(b"first").await.unwrap();
    drop(first.reader().await.unwrap());
    let mut second = backend
        .stage_write(&locator(&remote, "race"))
        .await
        .unwrap();
    second.write(b"second").await.unwrap();
    drop(second.reader().await.unwrap());
    second.commit().await.unwrap();
    assert!(
        first.commit().await.is_err(),
        "conditional copy must not overwrite"
    );
    assert_eq!(
        backend.stat(&locator(&remote, "race")).await.unwrap().size,
        Some(6)
    );

    // Conditional server-side replacement must verify provider hashes without
    // streaming the staged object back through this machine.
    let replace_target = locator(&remote, "replace.bin");
    let mut original = backend.stage_write(&replace_target).await.unwrap();
    original.write(b"original").await.unwrap();
    original.commit().await.unwrap();
    let expected = backend.stat(&replace_target).await.unwrap();
    let mut stale = backend.stage_replace(&expected).await.unwrap();
    stale.write(b"stale replacement").await.unwrap();
    let mut winner = backend.stage_replace(&expected).await.unwrap();
    for chunk in bytes.chunks(256 * 1024) { winner.write(chunk).await.unwrap(); }
    winner.commit().await.unwrap();
    assert!(stale.commit().await.is_err(), "stale conditional replacement must fail");
    let mut replaced = backend.open_read(&replace_target).await.unwrap();
    let mut content = Vec::new();
    tokio::io::AsyncReadExt::read_to_end(&mut replaced, &mut content).await.unwrap();
    assert_eq!(content, bytes);
    backend.delete(&replace_target).await.unwrap();

    // Cross-volume S3 copies/moves, including identical bucket names on independent connections.
    let mut other_input = input.clone();
    other_input.prefix.push_str("-other");
    let other = service.save_s3_storage(None, other_input).await.unwrap();
    assert_eq!(
        transfer(
            &service,
            TransferKind::Move,
            locator(&remote, "empty"),
            locator(&other, "moved")
        )
        .await
        .state,
        TransferState::Completed
    );
    assert!(service.stat_entry(locator(&remote, "empty")).await.is_err());
    let selected_download = local_dir.path().join("selected.bin");
    let job = service
        .transfer_selected_file(
            selected_download.clone(),
            locator(&remote, "nested/renamed.bin"),
            false,
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    assert_eq!(wait(&service, job).await.state, TransferState::Completed);
    assert_eq!(std::fs::read(selected_download).unwrap(), bytes);
    let job = service
        .transfer_selected_file(
            local_dir.path().join("empty"),
            locator(&remote, ""),
            true,
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    assert_eq!(wait(&service, job).await.state, TransferState::Completed);

    // Recursive folders preserve hidden files and empty prefixes in both directions.
    std::fs::create_dir_all(local_dir.path().join("tree/sub/empty")).unwrap();
    std::fs::write(local_dir.path().join("tree/.hidden"), b"hidden").unwrap();
    std::fs::write(local_dir.path().join("tree/sub/file"), b"nested").unwrap();
    let copied = transfer(
        &service,
        TransferKind::Copy,
        locator(&local, "tree"),
        locator(&remote, "tree"),
    )
    .await;
    assert_eq!(
        copied.state,
        TransferState::Completed,
        "{:?}",
        copied.error_message
    );
    assert!(service
        .stat_entry(locator(&remote, "tree/sub/empty"))
        .await
        .is_ok());
    service
        .rename_entry(locator(&remote, "tree"), "renamed-tree".into())
        .await
        .unwrap();
    assert!(service
        .list_entries(locator(&remote, "tree"))
        .await
        .unwrap()
        .is_empty());
    let mut nested_input = input.clone();
    nested_input.prefix.push_str("/renamed-tree/sub");
    let nested = service.save_s3_storage(None, nested_input).await.unwrap();
    assert!(service
        .start_transfer(
            TransferKind::Copy,
            locator(&remote, "renamed-tree"),
            locator(&nested, "inside"),
            Arc::new(|_| {})
        )
        .await
        .is_err());
    service.remove_local_storage(nested.id, true).await.unwrap();
    let moved = transfer(
        &service,
        TransferKind::Move,
        locator(&remote, "renamed-tree"),
        locator(&other, "tree"),
    )
    .await;
    assert_eq!(
        moved.state,
        TransferState::Completed,
        "{:?}",
        moved.error_message
    );
    let download = transfer(
        &service,
        TransferKind::Copy,
        locator(&other, "tree"),
        locator(&local, "downloaded-tree"),
    )
    .await;
    assert_eq!(
        download.state,
        TransferState::Completed,
        "{:?}",
        download.error_message
    );
    assert_eq!(
        std::fs::read(local_dir.path().join("downloaded-tree/sub/file")).unwrap(),
        b"nested"
    );
    assert!(local_dir.path().join("downloaded-tree/sub/empty").is_dir());
    service
        .delete_entry_recursive(locator(&other, "tree"), DeleteMode::Permanent, true, true)
        .await
        .unwrap();
    assert!(service
        .list_entries(locator(&other, "tree"))
        .await
        .unwrap()
        .is_empty());

    // Conflict policies publish verified content without pre-deleting the old target.
    let overwrite = service
        .start_transfer_with_policy(
            TransferKind::Copy,
            locator(&local, "sample.bin"),
            locator(&remote, "race"),
            ConflictPolicy::Overwrite,
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    let overwrite = wait(&service, overwrite).await;
    assert_eq!(
        overwrite.state,
        TransferState::Completed,
        "{:?}",
        overwrite.error_message
    );
    assert_eq!(
        backend.stat(&locator(&remote, "race")).await.unwrap().size,
        Some(bytes.len() as u64)
    );
    let skip = service
        .start_transfer_with_policy(
            TransferKind::Move,
            locator(&local, "sample.bin"),
            locator(&remote, "race"),
            ConflictPolicy::Skip,
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    assert_eq!(wait(&service, skip).await.state, TransferState::Skipped);
    assert!(local_dir.path().join("sample.bin").exists());
    let rename = service
        .start_transfer_with_policy(
            TransferKind::Copy,
            locator(&local, "empty"),
            locator(&remote, "race"),
            ConflictPolicy::Rename,
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    let rename = wait(&service, rename).await;
    assert_eq!(rename.state, TransferState::Completed);
    assert_eq!(rename.destination.logical_path, "race (1)");
    service
        .delete_entry(rename.destination, DeleteMode::Permanent, true)
        .await
        .unwrap();
    let expected = backend.stat(&locator(&remote, "race")).await.unwrap();
    let mut stale = backend.stage_replace(&expected).await.unwrap();
    stale.write(b"stale replacement").await.unwrap();
    drop(stale.reader().await.unwrap());
    let mut newer = backend.stage_replace(&expected).await.unwrap();
    newer.write(b"concurrent edit").await.unwrap();
    newer.commit().await.unwrap();
    assert!(
        stale.commit().await.is_err(),
        "conditional overwrite must retain concurrent target edits"
    );
    assert_eq!(
        backend.stat(&locator(&remote, "race")).await.unwrap().size,
        Some(15)
    );
    // Small pages exercise the actual S3 lister and snapshot without loading an entire layer into IPC.
    let mut page = service
        .list_entries_page(
            locator(&remote, ""),
            ListOptions {
                show_hidden: true,
                ..Default::default()
            },
            None,
            1,
        )
        .await
        .unwrap();
    let total = page.total;
    let mut names = std::collections::HashSet::new();
    loop {
        for entry in page.entries {
            assert!(names.insert(entry.name));
        }
        let Some(cursor) = page.next_cursor else {
            break;
        };
        page = service
            .list_entries_page(
                locator(&remote, ""),
                ListOptions {
                    show_hidden: true,
                    ..Default::default()
                },
                Some(cursor),
                1,
            )
            .await
            .unwrap();
    }
    assert_eq!(names.len() as u64, total);

    // Root protection, path traversal, read-only enforcement, and keychain reference rotation.
    assert!(service
        .delete_entry(locator(&remote, ""), DeleteMode::Permanent, true)
        .await
        .is_err());
    assert!(service
        .list_entries(locator(&remote, "../outside"))
        .await
        .is_err());
    assert!(service
        .delete_entry(locator(&remote, "nested"), DeleteMode::Permanent, true)
        .await
        .is_err());
    input.credentials = None;
    input.read_only = true;
    service
        .save_s3_storage(Some(remote.id), input.clone())
        .await
        .unwrap();
    assert!(service
        .create_directory(locator(&remote, ""), "blocked".into())
        .await
        .is_err());
    assert!(service
        .rename_entry(locator(&remote, "race"), "blocked".into())
        .await
        .is_err());
    assert!(service
        .delete_entry(locator(&remote, "race"), DeleteMode::Permanent, true)
        .await
        .is_err());
    let reopened =
        StorageService::with_credentials(Repository::open(&db).await.unwrap(), store.clone());
    assert_eq!(
        reopened
            .list_entries(locator(&remote, "nested"))
            .await
            .unwrap()
            .len(),
        1
    );
    let saved = serde_json::to_string(&reopened.list_connections().await.unwrap()).unwrap();
    assert!(!saved.contains(&credentials.secret_access_key));
    for name in ["filo.sqlite", "filo.sqlite-wal"] {
        if let Ok(bytes) = std::fs::read(database.path().join(name)) {
            assert!(!bytes
                .windows(credentials.secret_access_key.len())
                .any(|w| w == credentials.secret_access_key.as_bytes()));
        }
    }
    input.read_only = false;
    service
        .save_s3_storage(Some(remote.id), input)
        .await
        .unwrap();
    for path in ["nested/renamed.bin", "nested", "race", "empty"] {
        service
            .delete_entry(locator(&remote, path), DeleteMode::Permanent, true)
            .await
            .unwrap();
    }
    service
        .delete_entry(locator(&other, "moved"), DeleteMode::Permanent, true)
        .await
        .unwrap();
    // Drop cleanup is asynchronous; ensure all staged objects disappear before asserting.
    for _ in 0..100 {
        if service
            .list_entries(locator(&remote, ""))
            .await
            .unwrap()
            .is_empty()
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert!(service
        .list_entries(locator(&remote, ""))
        .await
        .unwrap()
        .is_empty());
    service.remove_local_storage(remote.id, true).await.unwrap();
    service.remove_local_storage(other.id, true).await.unwrap();
    assert!(store.0.lock().unwrap().is_empty());
}
