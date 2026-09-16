use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::Deserialize;
use storage_application::{CredentialStore, StorageService, TransferObserver};
use storage_domain::*;
use storage_repository::Repository;
use uuid::Uuid;

#[derive(Deserialize)]
struct Fixture {
    host: String,
    ftp_port: u16,
    ftps_port: u16,
    sftp_port: u16,
    smb_port: u16,
    username: String,
    password: String,
    share: String,
    known_hosts: String,
    tls_ca: PathBuf,
}

#[derive(Default)]
struct MemoryCredentials(Mutex<HashMap<String, S3Credentials>>);

impl CredentialStore for MemoryCredentials {
    fn get(&self, reference: &str) -> StorageResult<S3Credentials> {
        self.0
            .lock()
            .unwrap()
            .get(reference)
            .cloned()
            .ok_or_else(|| StorageError::new(StorageErrorCode::NotFound, "test credential missing"))
    }

    fn set(&self, reference: &str, credentials: &S3Credentials) -> StorageResult<()> {
        self.0
            .lock()
            .unwrap()
            .insert(reference.to_owned(), credentials.clone());
        Ok(())
    }

    fn delete(&self, reference: &str) -> StorageResult<()> {
        self.0.lock().unwrap().remove(reference);
        Ok(())
    }
}

#[derive(Default)]
struct FailingCredentials(Mutex<HashMap<String, S3Credentials>>);

impl CredentialStore for FailingCredentials {
    fn get(&self, reference: &str) -> StorageResult<S3Credentials> {
        self.0
            .lock()
            .unwrap()
            .get(reference)
            .cloned()
            .ok_or_else(|| StorageError::new(StorageErrorCode::NotFound, "test credential missing"))
    }

    fn set(&self, reference: &str, credentials: &S3Credentials) -> StorageResult<()> {
        self.0
            .lock()
            .unwrap()
            .insert(reference.to_owned(), credentials.clone());
        Err(StorageError::new(
            StorageErrorCode::Internal,
            "test credential store rejected the write",
        ))
    }

    fn delete(&self, reference: &str) -> StorageResult<()> {
        self.0.lock().unwrap().remove(reference);
        Ok(())
    }
}

#[derive(Clone)]
struct RemoteCase {
    protocol: RemoteProtocol,
    input: RemoteStorageInput,
    volume: StorageVolume,
}

/// Keep a failed integration run from leaving saved credentials or locations
/// behind in the disposable fixture. The guard only ever tracks IDs created by
/// this test; remote directory contents are removed explicitly once the
/// service has been reopened.
struct CleanupGuard {
    service: StorageService,
    volume_ids: Vec<Uuid>,
    armed: bool,
}

impl CleanupGuard {
    fn new(service: StorageService) -> Self {
        Self {
            service,
            volume_ids: Vec::new(),
            armed: true,
        }
    }

    fn track(&mut self, volume_id: Uuid) {
        self.volume_ids.push(volume_id);
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CleanupGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let service = self.service.clone();
        let volume_ids = self.volume_ids.clone();
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        handle.spawn(async move {
            for volume_id in volume_ids {
                let _ = service.remove_local_storage(volume_id, true).await;
            }
        });
    }
}

fn fixture() -> Option<Fixture> {
    let path = std::env::var_os("FILO_TEST_REMOTE_FIXTURE")?;
    let bytes = std::fs::read(path).expect("FILO_TEST_REMOTE_FIXTURE must be readable");
    Some(serde_json::from_slice(&bytes).expect("FILO_TEST_REMOTE_FIXTURE must be valid JSON"))
}

fn protocol_name(protocol: RemoteProtocol) -> &'static str {
    match protocol {
        RemoteProtocol::Ftp => "ftp",
        RemoteProtocol::Ftps => "ftps",
        RemoteProtocol::Sftp => "sftp",
        RemoteProtocol::Smb => "smb",
    }
}

fn port(fixture: &Fixture, protocol: RemoteProtocol) -> u16 {
    match protocol {
        RemoteProtocol::Ftp => fixture.ftp_port,
        RemoteProtocol::Ftps => fixture.ftps_port,
        RemoteProtocol::Sftp => fixture.sftp_port,
        RemoteProtocol::Smb => fixture.smb_port,
    }
}

fn credentials(fixture: &Fixture) -> RemoteCredentials {
    RemoteCredentials {
        username: fixture.username.clone(),
        password: fixture.password.clone(),
        private_key: String::new(),
        passphrase: String::new(),
        domain: String::new(),
    }
}

fn input(
    fixture: &Fixture,
    protocol: RemoteProtocol,
    path: impl Into<String>,
    read_only: bool,
) -> RemoteStorageInput {
    RemoteStorageInput {
        name: format!("Filo {protocol:?} application test"),
        protocol,
        host: fixture.host.clone(),
        port: port(fixture, protocol),
        path: path.into(),
        share: if protocol == RemoteProtocol::Smb {
            fixture.share.clone()
        } else {
            String::new()
        },
        known_hosts: if protocol == RemoteProtocol::Sftp {
            fixture.known_hosts.clone()
        } else {
            String::new()
        },
        read_only,
        credentials: Some(credentials(fixture)),
    }
}

fn locator(volume: &StorageVolume, path: impl Into<String>) -> StorageLocator {
    StorageLocator {
        volume_id: volume.id,
        logical_path: path.into(),
        version_id: None,
    }
}

fn observer() -> TransferObserver {
    Arc::new(|_| {})
}

async fn wait_for_job(service: &StorageService, job: TransferJob) -> StorageResult<TransferJob> {
    tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            let saved = service
                .list_transfers()
                .await?
                .into_iter()
                .find(|candidate| candidate.id == job.id)
                .ok_or_else(|| StorageError::new(StorageErrorCode::NotFound, "transfer missing"))?;
            if !saved.state.active() {
                return Ok(saved);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| StorageError::new(StorageErrorCode::Timeout, "transfer timeout"))?
}

async fn transfer(
    service: &StorageService,
    kind: TransferKind,
    source: StorageLocator,
    destination: StorageLocator,
) -> StorageResult<TransferJob> {
    let job = service
        .start_transfer(kind, source, destination, observer())
        .await?;
    wait_for_job(service, job).await
}

fn assert_completed(job: &TransferJob) {
    assert_eq!(job.state, TransferState::Completed);
    assert!(job.error_code.is_none());
}

fn assert_fixture_secret_not_persisted(database: &tempfile::TempDir, secret: &str) {
    let connections = std::fs::read(database.path().join("filo.sqlite")).unwrap_or_default();
    assert!(!connections
        .windows(secret.len())
        .any(|window| window == secret.as_bytes()));
    for suffix in ["-wal", "-shm"] {
        if let Ok(bytes) = std::fs::read(database.path().join(format!("filo.sqlite{suffix}"))) {
            assert!(!bytes
                .windows(secret.len())
                .any(|window| window == secret.as_bytes()));
        }
    }
}

async fn assert_active_edit_is_blocked(
    service: &StorageService,
    local: &StorageVolume,
    remote: &RemoteCase,
    local_dir: &tempfile::TempDir,
) -> StorageResult<()> {
    let source_name = format!("active-{}.bin", Uuid::new_v4());
    let target_name = format!("active-{}.bin", Uuid::new_v4());
    // A large source keeps the scheduler in its active state long enough for
    // the edit request to observe the transfer lock on the remote volume.
    std::fs::write(
        local_dir.path().join(&source_name),
        vec![0x5a; 128 * 1024 * 1024],
    )
    .map_err(|_| StorageError::new(StorageErrorCode::Io, "cannot create active source"))?;
    let job = service
        .start_transfer(
            TransferKind::Copy,
            locator(local, &source_name),
            locator(&remote.volume, &target_name),
            observer(),
        )
        .await?;
    let mut active = false;
    for _ in 0..100 {
        if service
            .list_transfers()
            .await?
            .into_iter()
            .find(|candidate| candidate.id == job.id)
            .is_some_and(|candidate| candidate.state.active())
        {
            active = true;
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(
        active,
        "the remote transfer should be active before editing"
    );

    let mut edit = remote.input.clone();
    edit.credentials = None;
    let error = service
        .save_remote_storage(Some(remote.volume.id), edit)
        .await
        .expect_err("editing an active remote location must be rejected");
    assert_eq!(error.code, StorageErrorCode::Conflict);

    service.cancel_transfer(job.id).await?;
    let cancelled = wait_for_job(service, job).await?;
    assert_eq!(cancelled.state, TransferState::Cancelled);
    Ok(())
}

async fn remove_remote_children(
    service: &StorageService,
    volume: &StorageVolume,
) -> StorageResult<()> {
    let root = locator(volume, "");
    let entries = service.list_entries(root).await?;
    for entry in entries {
        service
            .delete_entry_recursive(entry.locator, DeleteMode::Permanent, true, true)
            .await?;
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires FILO_TEST_REMOTE_FIXTURE and disposable FTP/FTPS/SFTP/SMB services"]
async fn remote_application_lifecycle_and_cross_storage_transfers() -> StorageResult<()> {
    let Some(fixture) = fixture() else {
        return Ok(());
    };
    // The disposable FTPS server uses a per-run CA. rustls-native-certs
    // intentionally honors this standard test-only trust override.
    std::env::set_var("SSL_CERT_FILE", &fixture.tls_ca);

    let database = tempfile::tempdir().map_err(|_| {
        StorageError::new(
            StorageErrorCode::Io,
            "cannot create application test database",
        )
    })?;
    let db_path = database.path().join("filo.sqlite");
    let store = Arc::new(MemoryCredentials::default());
    let service =
        StorageService::with_credentials(Repository::open(&db_path).await?, store.clone());
    let mut cleanup = CleanupGuard::new(service.clone());
    let local_dir = tempfile::tempdir().map_err(|_| {
        StorageError::new(
            StorageErrorCode::Io,
            "cannot create local application fixture",
        )
    })?;
    let payload = b"Filo remote application payload\nwith stable bytes\n".to_vec();
    std::fs::write(local_dir.path().join("source.bin"), &payload)
        .map_err(|_| StorageError::new(StorageErrorCode::Io, "cannot create source file"))?;
    let local = service
        .add_selected_directory(local_dir.path().to_path_buf(), false)
        .await?;
    cleanup.track(local.id);

    let mut cases = Vec::new();
    for protocol in [
        RemoteProtocol::Ftp,
        RemoteProtocol::Ftps,
        RemoteProtocol::Sftp,
        RemoteProtocol::Smb,
    ] {
        let base = input(&fixture, protocol, "", false);
        service.test_remote_connection(None, base.clone()).await?;
        let mut volume = service.save_remote_storage(None, base.clone()).await?;
        cleanup.track(volume.id);
        let mut configured = base;
        if matches!(protocol, RemoteProtocol::Sftp | RemoteProtocol::Smb) {
            let directory = format!("filo-app-{}-{}", protocol_name(protocol), Uuid::new_v4());
            service
                .create_directory(locator(&volume, ""), directory.clone())
                .await?;
            configured.path = directory;
            configured.credentials = None;
            volume = service
                .save_remote_storage(Some(volume.id), configured.clone())
                .await?;
            service
                .test_remote_connection(Some(volume.id), configured.clone())
                .await?;
        }
        cases.push(RemoteCase {
            protocol,
            input: configured,
            volume,
        });
    }

    let views = service.list_volumes().await?;
    assert_eq!(views.len(), 5);
    for case in &cases {
        let view = views
            .iter()
            .find(|view| view.volume.id == case.volume.id)
            .expect("saved remote volume should be listed");
        match case.protocol {
            RemoteProtocol::Ftp | RemoteProtocol::Ftps => {
                assert!(!view.capabilities.write);
                assert!(matches!(
                    view.capabilities.rename,
                    RenameSemantics::Unsupported
                ));
            }
            RemoteProtocol::Sftp | RemoteProtocol::Smb => {
                assert!(view.capabilities.write);
                assert!(view.capabilities.delete);
            }
        }
    }

    // FTP and FTPS deliberately expose safe directory deletion while refusing
    // file publication. Verify both the read path and the declared boundary.
    for case in cases
        .iter()
        .filter(|case| matches!(case.protocol, RemoteProtocol::Ftp | RemoteProtocol::Ftps))
    {
        let scratch = format!("filo-app-delete-{}", Uuid::new_v4());
        service
            .create_directory(locator(&case.volume, ""), scratch.clone())
            .await?;
        service
            .delete_entry(locator(&case.volume, scratch), DeleteMode::Permanent, true)
            .await?;
        let destination_name = format!("{}-seed.bin", protocol_name(case.protocol));
        let downloaded = transfer(
            &service,
            TransferKind::Copy,
            locator(&case.volume, "seed.txt"),
            locator(&local, &destination_name),
        )
        .await?;
        assert_completed(&downloaded);
        assert_eq!(
            std::fs::read(local_dir.path().join(destination_name)).unwrap(),
            b"Filo remote fixture\n"
        );
        let error = service
            .start_transfer(
                TransferKind::Copy,
                locator(&local, "source.bin"),
                locator(&case.volume, "new-file.bin"),
                observer(),
            )
            .await
            .expect_err("FTP file publication must be disabled");
        assert_eq!(error.code, StorageErrorCode::AccessDenied);
    }

    for case in cases
        .iter()
        .filter(|case| matches!(case.protocol, RemoteProtocol::Sftp | RemoteProtocol::Smb))
    {
        let copy_name = format!("copy-{}.bin", Uuid::new_v4());
        let download_name = format!("download-{}.bin", Uuid::new_v4());
        let move_name = format!("move-{}.bin", Uuid::new_v4());
        let move_back_name = format!("move-back-{}.bin", Uuid::new_v4());
        let local_move_name = format!("local-move-{}.bin", Uuid::new_v4());
        std::fs::write(local_dir.path().join(&local_move_name), &payload).unwrap();

        let copied = transfer(
            &service,
            TransferKind::Copy,
            locator(&local, "source.bin"),
            locator(&case.volume, &copy_name),
        )
        .await?;
        assert_completed(&copied);
        let downloaded = transfer(
            &service,
            TransferKind::Copy,
            locator(&case.volume, &copy_name),
            locator(&local, &download_name),
        )
        .await?;
        assert_completed(&downloaded);
        assert_eq!(
            std::fs::read(local_dir.path().join(&download_name)).unwrap(),
            payload
        );

        let moved_to_remote = transfer(
            &service,
            TransferKind::Move,
            locator(&local, &local_move_name),
            locator(&case.volume, &move_name),
        )
        .await?;
        assert_completed(&moved_to_remote);
        assert!(!local_dir.path().join(&local_move_name).exists());

        let moved_back = transfer(
            &service,
            TransferKind::Move,
            locator(&case.volume, &move_name),
            locator(&local, &move_back_name),
        )
        .await?;
        assert_completed(&moved_back);
        assert!(service
            .stat_entry(locator(&case.volume, &move_name))
            .await
            .is_err());
        assert_eq!(
            std::fs::read(local_dir.path().join(&move_back_name)).unwrap(),
            payload
        );

        let mut read_only = case.input.clone();
        read_only.read_only = true;
        read_only.credentials = None;
        service
            .save_remote_storage(Some(case.volume.id), read_only)
            .await?;
        let read_only_view = service
            .list_volumes()
            .await?
            .into_iter()
            .find(|view| view.volume.id == case.volume.id)
            .expect("read-only remote volume should be listed");
        assert!(!read_only_view.capabilities.write);
        assert!(!read_only_view.capabilities.delete);
        let error = service
            .create_directory(
                locator(&case.volume, ""),
                format!("blocked-{}", Uuid::new_v4()),
            )
            .await
            .expect_err("read-only remote directory creation must be rejected");
        assert_eq!(error.code, StorageErrorCode::AccessDenied);
        let error = service
            .start_transfer(
                TransferKind::Copy,
                locator(&local, "source.bin"),
                locator(&case.volume, "blocked.bin"),
                observer(),
            )
            .await
            .expect_err("read-only remote writes must be rejected");
        assert_eq!(error.code, StorageErrorCode::AccessDenied);
        service
            .save_remote_storage(Some(case.volume.id), case.input.clone())
            .await?;
    }

    let writable_case = cases
        .iter()
        .find(|case| case.protocol == RemoteProtocol::Sftp)
        .expect("SFTP case should exist");
    assert_active_edit_is_blocked(&service, &local, writable_case, &local_dir).await?;

    // Invalid roots are rejected before a network request, and bad credentials
    // fail without returning the supplied secret in the user-facing message.
    for protocol in [
        RemoteProtocol::Ftp,
        RemoteProtocol::Ftps,
        RemoteProtocol::Sftp,
        RemoteProtocol::Smb,
    ] {
        let mut escaped = input(&fixture, protocol, "../outside", false);
        let error = service
            .test_remote_connection(None, escaped.clone())
            .await
            .expect_err("remote path traversal must be rejected");
        assert_eq!(error.code, StorageErrorCode::InvalidPath);
        escaped.credentials = Some(RemoteCredentials {
            username: fixture.username.clone(),
            password: "wrong-password-that-must-not-leak".into(),
            private_key: String::new(),
            passphrase: String::new(),
            domain: String::new(),
        });
        escaped.path.clear();
        let error = service
            .test_remote_connection(None, escaped)
            .await
            .expect_err("invalid remote credentials must fail");
        assert_ne!(error.code, StorageErrorCode::InvalidPath);
        assert!(!error.message.contains("wrong-password-that-must-not-leak"));
    }

    let saved = service.list_connections().await?;
    assert_eq!(saved.len(), 5);
    let saved_json = serde_json::to_string(&saved).unwrap();
    assert!(!saved_json.contains(&fixture.password));
    assert_fixture_secret_not_persisted(&database, &fixture.password);

    drop(service);
    let service =
        StorageService::with_credentials(Repository::open(&db_path).await?, store.clone());
    assert_eq!(service.list_connections().await?.len(), 5);
    for case in &cases {
        let entries = service.list_entries(locator(&case.volume, "")).await?;
        if let Some(symlink) = entries
            .iter()
            .find(|entry| entry.kind == StorageEntryKind::Symlink)
        {
            let error = service
                .start_transfer(
                    TransferKind::Copy,
                    symlink.locator.clone(),
                    locator(&local, format!("blocked-{}.bin", Uuid::new_v4())),
                    observer(),
                )
                .await
                .expect_err("remote symlinks must not be transferred");
            assert_eq!(error.code, StorageErrorCode::Unsupported);
        }
        if matches!(case.protocol, RemoteProtocol::Sftp | RemoteProtocol::Smb) {
            remove_remote_children(&service, &case.volume).await?;
        }
    }

    for case in cases {
        service.remove_local_storage(case.volume.id, true).await?;
    }
    service.remove_local_storage(local.id, true).await?;
    assert!(store.0.lock().unwrap().is_empty());
    cleanup.disarm();
    Ok(())
}

#[tokio::test]
#[ignore = "requires FILO_TEST_REMOTE_FIXTURE and a disposable FTP service"]
async fn remote_save_rolls_back_when_credential_store_rejects_write() -> StorageResult<()> {
    let Some(fixture) = fixture() else {
        return Ok(());
    };
    std::env::set_var("SSL_CERT_FILE", &fixture.tls_ca);
    let database = tempfile::tempdir().map_err(|_| {
        StorageError::new(
            StorageErrorCode::Io,
            "cannot create application test database",
        )
    })?;
    let db_path = database.path().join("filo.sqlite");
    let store = Arc::new(FailingCredentials::default());
    let service =
        StorageService::with_credentials(Repository::open(&db_path).await?, store.clone());
    let result = service
        .save_remote_storage(None, input(&fixture, RemoteProtocol::Ftp, "", false))
        .await;
    let error = result.expect_err("credential store failure must abort remote save");
    assert_eq!(error.code, StorageErrorCode::Internal);
    assert!(store.0.lock().unwrap().is_empty());
    assert!(service.list_connections().await?.is_empty());
    assert!(service.list_volumes().await?.is_empty());
    Ok(())
}
