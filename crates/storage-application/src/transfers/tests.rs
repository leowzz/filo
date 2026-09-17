use super::execution::BUFFER_SIZE;
use super::*;
use std::time::Duration;
use storage_repository::Repository;

#[tokio::test]
async fn saved_limits_update_existing_backend_budgets_and_restore_on_restart() {
    let fixture = Fixture::new().await;
    let settings = TransferSettings {
        upload_kib_per_second: 100,
        download_kib_per_second: 200,
    };
    let limits = fixture.service.transfer_limits().await.unwrap();
    assert_eq!(limits.upload.acquire(100_000).await, 100_000);
    fixture
        .service
        .save_transfer_settings(settings)
        .await
        .unwrap();
    assert_eq!(limits.upload.acquire(100_000).await, 10_240);
    assert_eq!(limits.download.acquire(100_000).await, 20_480);
    let restarted = StorageService::new(fixture.service.repository.clone());
    assert_eq!(restarted.transfer_settings().await.unwrap(), settings);
    assert_eq!(
        restarted
            .transfer_limits()
            .await
            .unwrap()
            .upload
            .acquire(100_000)
            .await,
        10_240
    );
    fixture
        .service
        .save_transfer_settings(TransferSettings::default())
        .await
        .unwrap();
    assert_eq!(limits.upload.acquire(100_000).await, 100_000);
}

fn sorted_paths(mut paths: Vec<std::path::PathBuf>) -> Vec<std::path::PathBuf> {
    paths.sort();
    paths
}

#[tokio::test]
async fn transfer_preflight_reads_actual_destination_metadata() {
    let fixture = Fixture::new().await;
    std::fs::write(fixture.destination.path().join("source.bin"), b"existing").unwrap();
    std::fs::create_dir(fixture.destination.path().join("folder")).unwrap();
    let parent = StorageLocator {
        volume_id: fixture.destination_id,
        logical_path: "".into(),
        version_id: None,
    };
    let source = |path: &str| StorageLocator {
        volume_id: fixture.source_id,
        logical_path: path.into(),
        version_id: None,
    };
    assert_eq!(
        fixture
            .service
            .preflight_transfer_conflicts(
                parent,
                vec![source("source.bin"), source("folder"), source("new.txt")],
            )
            .await
            .unwrap(),
        vec!["source.bin", "folder"]
    );
}

#[tokio::test]
async fn upload_preflight_recurses_into_folders_and_propagates_errors() {
    let fixture = Fixture::new().await;
    let remote = StorageLocator {
        volume_id: fixture.destination_id,
        logical_path: "".into(),
        version_id: None,
    };
    let local = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(local.path().join("firmware/nested")).unwrap();
    std::fs::create_dir_all(local.path().join("folder")).unwrap();
    std::fs::create_dir_all(local.path().join("blocked/inside")).unwrap();
    std::fs::create_dir(local.path().join("a")).unwrap();
    std::fs::create_dir(local.path().join("b")).unwrap();
    std::fs::write(local.path().join("unique.txt"), b"unique").unwrap();
    std::fs::write(local.path().join("exists"), b"upload").unwrap();
    std::fs::write(local.path().join("a/clean"), b"a").unwrap();
    std::fs::write(local.path().join("b/clean"), b"b").unwrap();
    std::fs::write(local.path().join("firmware/keep-local.hex"), b"local-only").unwrap();
    std::fs::write(local.path().join("firmware/conflict.hex"), b"new-conflict").unwrap();
    std::fs::write(
        local.path().join("firmware/nested/conflict.hex"),
        b"new-nested",
    )
    .unwrap();
    std::fs::write(local.path().join("firmware/nested/new.hex"), b"new-file").unwrap();
    std::fs::write(local.path().join("folder/only-local.txt"), b"folder-local").unwrap();
    std::fs::write(local.path().join("blocked/inside/file"), b"blocked-child").unwrap();
    std::fs::create_dir_all(fixture.destination.path().join("firmware/nested")).unwrap();
    std::fs::create_dir(fixture.destination.path().join("folder")).unwrap();
    std::fs::write(fixture.destination.path().join("exists"), b"keep").unwrap();
    std::fs::write(
        fixture.destination.path().join("firmware/conflict.hex"),
        b"old",
    )
    .unwrap();
    std::fs::write(
        fixture
            .destination
            .path()
            .join("firmware/nested/conflict.hex"),
        b"old-nested",
    )
    .unwrap();
    std::fs::write(
        fixture
            .destination
            .path()
            .join("firmware/nested/remote-only.hex"),
        b"keep-nested",
    )
    .unwrap();
    std::fs::write(
        fixture.destination.path().join("firmware/remote-only.hex"),
        b"keep-root",
    )
    .unwrap();
    std::fs::write(
        fixture.destination.path().join("blocked"),
        b"file-in-the-way",
    )
    .unwrap();
    let paths = [
        "unique.txt",
        "exists",
        "firmware",
        "a/clean",
        "b/clean",
        "folder",
        "blocked",
    ]
    .into_iter()
    .map(|path| local.path().join(path))
    .collect::<Vec<_>>();
    assert_eq!(
        sorted_paths(
            fixture
                .service
                .preflight_upload(&remote, &paths)
                .await
                .unwrap()
        ),
        sorted_paths(vec![
            local.path().join("exists"),
            local.path().join("firmware/conflict.hex"),
            local.path().join("firmware/nested/conflict.hex"),
            local.path().join("b/clean"),
            local.path().join("blocked"),
        ])
    );
    let invalid = StorageLocator {
        volume_id: Uuid::new_v4(),
        ..remote
    };
    assert!(fixture
        .service
        .preflight_upload(&invalid, &paths)
        .await
        .is_err());
}

#[tokio::test]
async fn folder_upload_overwrite_applies_only_to_preflight_conflicts() {
    let fixture = Fixture::new().await;
    let remote = StorageLocator {
        volume_id: fixture.destination_id,
        logical_path: "".into(),
        version_id: None,
    };
    let local = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(local.path().join("firmware/nested")).unwrap();
    std::fs::write(local.path().join("firmware/keep-local.hex"), b"local-only").unwrap();
    std::fs::write(local.path().join("firmware/conflict.hex"), b"new-conflict").unwrap();
    std::fs::write(
        local.path().join("firmware/nested/conflict.hex"),
        b"new-nested",
    )
    .unwrap();
    std::fs::write(local.path().join("firmware/nested/new.hex"), b"new-file").unwrap();
    std::fs::create_dir_all(fixture.destination.path().join("firmware/nested")).unwrap();
    std::fs::write(
        fixture.destination.path().join("firmware/conflict.hex"),
        b"old",
    )
    .unwrap();
    std::fs::write(
        fixture
            .destination
            .path()
            .join("firmware/nested/conflict.hex"),
        b"old-nested",
    )
    .unwrap();
    std::fs::write(
        fixture
            .destination
            .path()
            .join("firmware/nested/remote-only.hex"),
        b"keep-nested",
    )
    .unwrap();
    std::fs::write(
        fixture.destination.path().join("firmware/remote-only.hex"),
        b"keep-root",
    )
    .unwrap();
    let firmware = local.path().join("firmware");
    let conflicts = fixture
        .service
        .preflight_upload(&remote, std::slice::from_ref(&firmware))
        .await
        .unwrap();
    assert_eq!(
        sorted_paths(conflicts.clone()),
        sorted_paths(vec![
            local.path().join("firmware/conflict.hex"),
            local.path().join("firmware/nested/conflict.hex"),
        ])
    );
    let job = fixture
        .service
        .upload_selected_path(
            firmware,
            remote,
            ConflictPolicy::Overwrite,
            &conflicts,
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    let result = fixture.result(job.id).await;
    assert_eq!(
        result.state,
        TransferState::Completed,
        "{:?}",
        result.error_message
    );
    let uploaded = fixture.destination.path().join("firmware");
    assert_eq!(
        std::fs::read(uploaded.join("conflict.hex")).unwrap(),
        b"new-conflict"
    );
    assert_eq!(
        std::fs::read(uploaded.join("nested/conflict.hex")).unwrap(),
        b"new-nested"
    );
    assert_eq!(
        std::fs::read(uploaded.join("keep-local.hex")).unwrap(),
        b"local-only"
    );
    assert_eq!(
        std::fs::read(uploaded.join("nested/new.hex")).unwrap(),
        b"new-file"
    );
    assert_eq!(
        std::fs::read(uploaded.join("remote-only.hex")).unwrap(),
        b"keep-root"
    );
    assert_eq!(
        std::fs::read(uploaded.join("nested/remote-only.hex")).unwrap(),
        b"keep-nested"
    );
}

#[tokio::test]
async fn upload_rejects_conflicts_after_preflight_and_after_streaming() {
    for late_commit in [false, true] {
        let fixture = Fixture::new().await;
        let external = tempfile::tempdir().unwrap();
        let source = external.path().join("file");
        std::fs::write(&source, b"uploaded data").unwrap();
        let target = fixture.destination.path().join("file");
        let remote = StorageLocator {
            volume_id: fixture.destination_id,
            logical_path: "".into(),
            version_id: None,
        };
        assert!(fixture
            .service
            .preflight_upload(&remote, std::slice::from_ref(&source))
            .await
            .unwrap()
            .is_empty());
        if !late_commit {
            std::fs::write(&target, b"external data").unwrap();
        }
        let target_at_commit = target.clone();
        let job = fixture
            .service
            .transfer_selected_file(
                source.clone(),
                remote,
                true,
                Arc::new(move |job| {
                    if late_commit && job.state == TransferState::Verifying {
                        std::fs::write(&target_at_commit, b"external data").unwrap();
                    }
                }),
            )
            .await
            .unwrap();
        let result = fixture.result(job.id).await;
        assert_eq!(result.state, TransferState::Failed);
        assert_eq!(result.error_code, Some(StorageErrorCode::AlreadyExists));
        assert_eq!(std::fs::read(&target).unwrap(), b"external data");
        assert_eq!(std::fs::read(&source).unwrap(), b"uploaded data");
        assert_eq!(
            std::fs::read_dir(fixture.destination.path())
                .unwrap()
                .count(),
            1
        );
    }
}

struct GatedSource {
    inner: Arc<dyn StorageBackend>,
    gate: Arc<tokio::sync::Semaphore>,
}

#[tokio::test]
async fn selected_folder_upload_preserves_tree_and_applies_conflict_policies() {
    let fixture = Fixture::new().await;
    let external = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(external.path().join("folder/nested/empty")).unwrap();
    std::fs::write(external.path().join("folder/nested/file"), b"content").unwrap();
    std::fs::write(external.path().join("folder/.hidden"), b"hidden").unwrap();
    std::fs::write(external.path().join("private"), b"private").unwrap();
    std::fs::create_dir(fixture.destination.path().join("uploads")).unwrap();
    let remote = StorageLocator {
        volume_id: fixture.destination_id,
        logical_path: "uploads".into(),
        version_id: None,
    };
    let target = fixture.destination.path().join("uploads/folder");
    for (policy, state) in [
        (ConflictPolicy::Reject, TransferState::Completed),
        (ConflictPolicy::Reject, TransferState::Failed),
        (ConflictPolicy::Skip, TransferState::Skipped),
        (ConflictPolicy::Rename, TransferState::Completed),
        (ConflictPolicy::Overwrite, TransferState::Completed),
    ] {
        let job = fixture
            .service
            .transfer_selected_file_with_policy(
                external.path().join("folder"),
                remote.clone(),
                true,
                policy,
                Arc::new(|_| {}),
            )
            .await
            .unwrap();
        let result = fixture.result(job.id).await;
        assert_eq!(result.state, state, "{:?}", result.error_message);
        assert!(!fixture
            .service
            .temporary_backends
            .lock()
            .await
            .contains_key(&job.source.volume_id));
        // Retain only the location for completed-record actions; general file
        // access must remain revoked after the temporary transfer ends.
        assert!(fixture
            .service
            .repository
            .transfer_local_volume(job.source.volume_id)
            .await
            .unwrap()
            .is_some());
        assert!(fixture
            .service
            .stat_entry(job.source.clone())
            .await
            .is_err());
        if state != TransferState::Completed {
            assert!(fixture
                .service
                .open_transfer_file(job.id, false)
                .await
                .is_err());
            assert!(fixture
                .service
                .open_transfer_file(job.id, true)
                .await
                .is_err());
        }
        if state == TransferState::Completed {
            assert_eq!(result.bytes_total, Some(13));
            assert_eq!(result.bytes_transferred, 13);
            let uploaded = fixture
                .destination
                .path()
                .join(&result.destination.logical_path);
            assert!(uploaded.join("nested/empty").is_dir());
            assert_eq!(
                std::fs::read(uploaded.join("nested/file")).unwrap(),
                b"content"
            );
            assert_eq!(std::fs::read(uploaded.join(".hidden")).unwrap(), b"hidden");
        }
        if policy == ConflictPolicy::Rename {
            assert_eq!(result.destination.logical_path, "uploads/folder (1)");
        }
        if policy == ConflictPolicy::Overwrite {
            assert_eq!(std::fs::read(target.join("only-target")).unwrap(), b"keep");
        } else {
            std::fs::write(target.join("nested/file"), b"old").unwrap();
            std::fs::write(target.join("only-target"), b"keep").unwrap();
        }
    }
    assert!(!fixture.destination.path().join("uploads/private").exists());
    assert_eq!(
        std::fs::read(external.path().join("folder/nested/file")).unwrap(),
        b"content"
    );
    assert_eq!(
        fixture
            .service
            .repository
            .list_volumes()
            .await
            .unwrap()
            .len(),
        2
    );
}

#[cfg(unix)]
#[tokio::test]
async fn selected_folder_upload_rejects_symlinks_before_writing() {
    let fixture = Fixture::new().await;
    let external = tempfile::tempdir().unwrap();
    std::fs::create_dir(external.path().join("folder")).unwrap();
    std::fs::write(external.path().join("private"), b"private").unwrap();
    std::os::unix::fs::symlink("../private", external.path().join("folder/link")).unwrap();
    let remote = StorageLocator {
        volume_id: fixture.destination_id,
        logical_path: "".into(),
        version_id: None,
    };
    let job = fixture
        .service
        .transfer_selected_file_with_policy(
            external.path().join("folder"),
            remote.clone(),
            true,
            ConflictPolicy::Reject,
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    let result = fixture.result(job.id).await;
    assert_eq!(result.state, TransferState::Failed);
    assert_eq!(result.error_code, Some(StorageErrorCode::Unsupported));
    assert!(!fixture.destination.path().join("folder").exists());
    std::os::unix::fs::symlink("folder", external.path().join("linked-folder")).unwrap();
    assert!(fixture
        .service
        .transfer_selected_file_with_policy(
            external.path().join("linked-folder"),
            remote,
            true,
            ConflictPolicy::Reject,
            Arc::new(|_| {}),
        )
        .await
        .is_err());
    assert!(fixture.service.temporary_backends.lock().await.is_empty());
}

#[async_trait::async_trait]
impl StorageBackend for GatedSource {
    fn volume_id(&self) -> Uuid {
        self.inner.volume_id()
    }
    fn capabilities(&self) -> StorageCapabilities {
        self.inner.capabilities()
    }
    fn storage_path(&self, locator: &StorageLocator) -> Option<(String, String)> {
        self.inner.storage_path(locator)
    }
    async fn stat(&self, locator: &StorageLocator) -> StorageResult<StorageEntry> {
        self.inner.stat(locator).await
    }
    async fn list(&self, locator: &StorageLocator) -> StorageResult<Vec<StorageEntry>> {
        self.inner.list(locator).await
    }
    async fn open_read(
        &self,
        locator: &StorageLocator,
    ) -> StorageResult<storage_provider_api::StorageReader> {
        self.gate.acquire().await.unwrap().forget();
        self.inner.open_read(locator).await
    }
    async fn create_dir(&self, locator: &StorageLocator) -> StorageResult<()> {
        self.inner.create_dir(locator).await
    }
    async fn rename(
        &self,
        source: &StorageLocator,
        destination: &StorageLocator,
    ) -> StorageResult<()> {
        self.inner.rename(source, destination).await
    }
    async fn delete(&self, locator: &StorageLocator) -> StorageResult<()> {
        self.inner.delete(locator).await
    }
    async fn stage_write(
        &self,
        locator: &StorageLocator,
    ) -> StorageResult<Box<dyn storage_provider_api::StagedWrite>> {
        self.inner.stage_write(locator).await
    }
}

#[tokio::test]
async fn panicking_transfer_fails_and_releases_active_state() {
    let fixture = Fixture::new().await;
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    gate.close(); // GatedSource panics when attempting to read through this closed gate.
    let inner = fixture.service.backend(fixture.source_id).await.unwrap();
    fixture
        .service
        .temporary_backends
        .lock()
        .await
        .insert(fixture.source_id, Arc::new(GatedSource { inner, gate }));
    let request = fixture.job(TransferKind::Copy);
    let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
    let job = fixture
        .service
        .start_transfer(
            request.kind,
            request.source.clone(),
            request.destination.clone(),
            Arc::new(move |job| {
                let _ = sender.send(job);
            }),
        )
        .await
        .unwrap();
    let result = fixture.result(job.id).await;
    assert_eq!(result.state, TransferState::Failed);
    assert_eq!(result.error_code, Some(StorageErrorCode::Internal));
    assert!(!fixture.service.transfers.lock().await.contains_key(&job.id));
    assert!(!fixture
        .service
        .temporary_backends
        .lock()
        .await
        .contains_key(&fixture.source_id));
    tokio::time::timeout(Duration::from_secs(2), async {
        while let Some(event) = events.recv().await {
            if event.state == TransferState::Failed {
                return;
            }
        }
        panic!("missing terminal progress event");
    })
    .await
    .unwrap();
    // The same destination can be used again after cleanup.
    let retried = fixture
        .service
        .start_transfer(
            request.kind,
            request.source,
            request.destination,
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    assert_eq!(
        fixture.result(retried.id).await.state,
        TransferState::Completed
    );
}

#[tokio::test]
async fn independent_transfers_run_together_and_queued_cancellation_is_isolated() {
    let fixture = Fixture::new().await;
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let inner = fixture.service.backend(fixture.source_id).await.unwrap();
    fixture.service.temporary_backends.lock().await.insert(
        fixture.source_id,
        Arc::new(GatedSource {
            inner,
            gate: gate.clone(),
        }),
    );
    let (sender, mut started) = tokio::sync::mpsc::unbounded_channel();
    let mut jobs = Vec::new();
    for i in 0..4 {
        let mut request = fixture.job(TransferKind::Copy);
        request.destination.logical_path = format!("parallel-{i}.bin");
        let sender = sender.clone();
        jobs.push(
            fixture
                .service
                .start_transfer(
                    request.kind,
                    request.source,
                    request.destination,
                    Arc::new(move |job| {
                        if job.state == TransferState::Running {
                            sender.send(job.id).unwrap();
                        }
                    }),
                )
                .await
                .unwrap(),
        );
    }
    // All three must reach Running before any is allowed to finish. A global
    // exclusive lock would time out waiting for the second start.
    let mut running = Vec::new();
    for _ in 0..3 {
        running.push(
            tokio::time::timeout(Duration::from_secs(2), started.recv())
                .await
                .unwrap()
                .unwrap(),
        );
    }
    let queued = jobs.iter().find(|job| !running.contains(&job.id)).unwrap();
    assert_eq!(
        fixture
            .service
            .list_transfers()
            .await
            .unwrap()
            .iter()
            .find(|job| job.id == queued.id)
            .unwrap()
            .state,
        TransferState::Queued
    );
    fixture.service.cancel_transfer(queued.id).await.unwrap();
    assert_eq!(
        fixture.result(queued.id).await.state,
        TransferState::Cancelled
    );
    assert!(!fixture
        .destination
        .path()
        .join(&queued.destination.logical_path)
        .exists());
    gate.add_permits(3);
    for job in jobs.iter().filter(|job| running.contains(&job.id)) {
        let result = fixture.result(job.id).await;
        assert_eq!(
            result.state,
            TransferState::Completed,
            "{:?}",
            result.error_message
        );
        assert_eq!(result.bytes_total, Some(result.bytes_transferred));
        assert_eq!(
            std::fs::read(
                fixture
                    .destination
                    .path()
                    .join(&job.destination.logical_path)
            )
            .unwrap(),
            std::fs::read(fixture.source.path().join("source.bin")).unwrap()
        );
    }
}

#[tokio::test]
async fn reservations_recognize_physical_aliases() {
    let fixture = Fixture::new().await;
    fixture.seed_folder();
    let alias = fixture
        .service
        .add_selected_directory(fixture.source.path().join("folder"), false)
        .await
        .unwrap();
    let source_backend = fixture.service.backend(fixture.source_id).await.unwrap();
    let alias_backend = fixture.service.backend(alias.id).await.unwrap();
    let root = StorageLocator {
        volume_id: fixture.source_id,
        logical_path: "folder".into(),
        version_id: None,
    };
    let child = StorageLocator {
        volume_id: alias.id,
        logical_path: "nested/file".into(),
        version_id: None,
    };
    let permit = fixture
        .service
        .transfer_scheduler
        .acquire(vec![scheduler::Access::new(
            source_backend.as_ref(),
            &root,
            true,
        )])
        .await;
    assert!(tokio::time::timeout(
        Duration::from_millis(30),
        fixture
            .service
            .transfer_scheduler
            .acquire(vec![scheduler::Access::new(
                alias_backend.as_ref(),
                &child,
                false
            )])
    )
    .await
    .is_err());
    drop(permit);
    let _permit = fixture
        .service
        .transfer_scheduler
        .acquire(vec![scheduler::Access::new(
            alias_backend.as_ref(),
            &child,
            false,
        )])
        .await;
}

struct Fixture {
    service: StorageService,
    source: tempfile::TempDir,
    destination: tempfile::TempDir,
    _database: tempfile::TempDir,
    source_id: Uuid,
    destination_id: Uuid,
}
impl Fixture {
    async fn new() -> Self {
        let source = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let database = tempfile::tempdir().unwrap();
        let service = StorageService::new(
            Repository::open(&database.path().join("test.sqlite"))
                .await
                .unwrap(),
        );
        let source_id = service
            .add_selected_directory(source.path().to_path_buf(), false)
            .await
            .unwrap()
            .id;
        let destination_id = service
            .add_selected_directory(destination.path().to_path_buf(), false)
            .await
            .unwrap()
            .id;
        std::fs::write(
            source.path().join("source.bin"),
            vec![42; BUFFER_SIZE * 3 + 17],
        )
        .unwrap();
        Self {
            service,
            source,
            destination,
            _database: database,
            source_id,
            destination_id,
        }
    }
    fn job(&self, kind: TransferKind) -> TransferJob {
        let now = chrono::Utc::now().to_rfc3339();
        TransferJob {
            id: Uuid::new_v4(),
            kind,
            source: StorageLocator {
                volume_id: self.source_id,
                logical_path: "source.bin".into(),
                version_id: None,
            },
            destination: StorageLocator {
                volume_id: self.destination_id,
                logical_path: "target.bin".into(),
                version_id: None,
            },
            state: TransferState::Queued,
            bytes_total: None,
            bytes_transferred: 0,
            error_code: None,
            error_message: None,
            created_at: now.clone(),
            updated_at: now,
        }
    }
    async fn result(&self, id: Uuid) -> TransferJob {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(job) = self
                    .service
                    .list_transfers()
                    .await
                    .unwrap()
                    .into_iter()
                    .find(|job| job.id == id && !job.state.active())
                {
                    return job;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap()
    }
}

#[tokio::test]
async fn copies_verified_content_then_moves_without_overwriting() {
    let fixture = Fixture::new().await;
    let request = fixture.job(TransferKind::Copy);
    let job = fixture
        .service
        .start_transfer(
            request.kind,
            request.source.clone(),
            request.destination.clone(),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    let result = fixture.result(job.id).await;
    assert_eq!(result.state, TransferState::Completed);
    assert_eq!(result.bytes_total, Some(result.bytes_transferred));
    assert_eq!(
        std::fs::read(fixture.source.path().join("source.bin")).unwrap(),
        std::fs::read(fixture.destination.path().join("target.bin")).unwrap()
    );
    // Moving onto the existing target must fail and retain both files.
    let job = fixture
        .service
        .start_transfer(
            TransferKind::Move,
            request.source.clone(),
            request.destination.clone(),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    assert_eq!(
        fixture.result(job.id).await.error_code,
        Some(StorageErrorCode::AlreadyExists)
    );
    assert!(fixture.source.path().join("source.bin").exists());
    let mut target = request.destination;
    target.logical_path = "moved.bin".into();
    let job = fixture
        .service
        .start_transfer(TransferKind::Move, request.source, target, Arc::new(|_| {}))
        .await
        .unwrap();
    assert_eq!(fixture.result(job.id).await.state, TransferState::Completed);
    assert!(!fixture.source.path().join("source.bin").exists());
    assert_eq!(
        std::fs::read(fixture.destination.path().join("moved.bin")).unwrap(),
        std::fs::read(fixture.destination.path().join("target.bin")).unwrap()
    );
    assert_eq!(
        std::fs::read_dir(fixture.destination.path())
            .unwrap()
            .count(),
        2
    );
}

#[tokio::test]
async fn cancel_during_verification_discards_staging_and_keeps_source() {
    let fixture = Fixture::new().await;
    let job = fixture.job(TransferKind::Move);
    let id = job.id;
    let token = CancellationToken::new();
    let cancel = token.clone();
    fixture
        .service
        .run_transfer(
            job,
            token,
            Arc::new(move |job| {
                if job.state == TransferState::Verifying {
                    cancel.cancel();
                }
            }),
        )
        .await;
    assert_eq!(fixture.result(id).await.state, TransferState::Cancelled);
    assert!(fixture.source.path().join("source.bin").exists());
    assert_eq!(
        std::fs::read_dir(fixture.destination.path())
            .unwrap()
            .count(),
        0
    );
}

#[tokio::test]
async fn source_changed_during_verification_is_never_removed() {
    let fixture = Fixture::new().await;
    let job = fixture.job(TransferKind::Move);
    let id = job.id;
    let source_path = fixture.source.path().join("source.bin");
    fixture
        .service
        .run_transfer(
            job,
            CancellationToken::new(),
            Arc::new(move |job| {
                if job.state == TransferState::Verifying {
                    std::fs::write(&source_path, b"external change").unwrap();
                }
            }),
        )
        .await;
    assert_eq!(fixture.result(id).await.state, TransferState::Failed);
    assert_eq!(
        std::fs::read(fixture.source.path().join("source.bin")).unwrap(),
        b"external change"
    );
    assert_eq!(
        std::fs::read_dir(fixture.destination.path())
            .unwrap()
            .count(),
        0
    );
}

#[tokio::test]
async fn queued_cancel_and_permission_recheck() {
    let fixture = Fixture::new().await;
    let request = fixture.job(TransferKind::Copy);
    let guard = fixture.service.mutation_lock.write().await;
    let job = fixture
        .service
        .start_transfer(
            request.kind,
            request.source.clone(),
            request.destination.clone(),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    assert_eq!(
        fixture
            .service
            .update_local_storage(fixture.source_id, "changed".into(), true, None)
            .await
            .unwrap_err()
            .code,
        StorageErrorCode::Conflict
    );
    assert_eq!(
        fixture
            .service
            .remove_local_storage(fixture.destination_id, true)
            .await
            .unwrap_err()
            .code,
        StorageErrorCode::Conflict
    );
    fixture.service.cancel_transfer(job.id).await.unwrap();
    assert_eq!(fixture.result(job.id).await.state, TransferState::Cancelled);
    drop(guard);
    fixture
        .service
        .update_local_storage(fixture.destination_id, "只读目标".into(), true, None)
        .await
        .unwrap();
    assert_eq!(
        fixture
            .service
            .start_transfer(
                request.kind,
                request.source.clone(),
                request.destination.clone(),
                Arc::new(|_| {})
            )
            .await
            .unwrap_err()
            .code,
        StorageErrorCode::AccessDenied
    );
    assert_eq!(
        std::fs::read_dir(fixture.destination.path())
            .unwrap()
            .count(),
        0
    );
}

#[tokio::test]
async fn same_volume_move_uses_native_rename_and_empty_copy_succeeds() {
    let fixture = Fixture::new().await;
    std::fs::write(fixture.source.path().join("source.bin"), []).unwrap();
    let mut request = fixture.job(TransferKind::Move);
    request.destination.volume_id = fixture.source_id;
    let job = fixture
        .service
        .start_transfer(
            request.kind,
            request.source,
            request.destination,
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    assert_eq!(fixture.result(job.id).await.state, TransferState::Completed);
    assert!(!fixture.source.path().join("source.bin").exists());
    assert!(fixture.source.path().join("target.bin").exists());
    let mut request = fixture.job(TransferKind::Copy);
    request.source.logical_path = "target.bin".into();
    let job = fixture
        .service
        .start_transfer(
            request.kind,
            request.source,
            request.destination,
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    assert_eq!(fixture.result(job.id).await.state, TransferState::Completed);
    assert_eq!(
        std::fs::metadata(fixture.destination.path().join("target.bin"))
            .unwrap()
            .len(),
        0
    );
}

impl Fixture {
    fn folder_job(&self, kind: TransferKind) -> TransferJob {
        let mut job = self.job(kind);
        job.source.logical_path = "folder".into();
        job.destination.logical_path = "copied".into();
        job
    }
    fn seed_folder(&self) {
        std::fs::create_dir_all(self.source.path().join("folder/nested/empty")).unwrap();
        std::fs::write(self.source.path().join("folder/.hidden"), b"hidden").unwrap();
        std::fs::write(self.source.path().join("folder/nested/file"), b"content").unwrap();
    }
    async fn run(&self, job: TransferJob) -> TransferJob {
        let id = job.id;
        self.service
            .run_transfer(job, CancellationToken::new(), Arc::new(|_| {}))
            .await;
        self.result(id).await
    }
}

#[tokio::test]
async fn folders_copy_move_and_conflicts_preserve_contents() {
    let fixture = Fixture::new().await;
    fixture.seed_folder();
    let result = fixture.run(fixture.folder_job(TransferKind::Copy)).await;
    assert_eq!(
        result.state,
        TransferState::Completed,
        "{:?}",
        result.error_message
    );
    assert_eq!(result.bytes_total, Some(13));
    assert_eq!(result.bytes_transferred, 13);
    assert!(fixture
        .destination
        .path()
        .join("copied/nested/empty")
        .is_dir());
    assert_eq!(
        std::fs::read(fixture.destination.path().join("copied/.hidden")).unwrap(),
        b"hidden"
    );
    assert!(fixture.source.path().join("folder/nested/file").is_file());
    let duplicate = fixture.run(fixture.folder_job(TransferKind::Move)).await;
    assert_eq!(duplicate.error_code, Some(StorageErrorCode::AlreadyExists));
    assert!(fixture.source.path().join("folder/nested/file").is_file());
    let mut job = fixture.folder_job(TransferKind::Move);
    job.destination.logical_path = "moved".into();
    let result = fixture.run(job).await;
    assert_eq!(
        result.state,
        TransferState::Completed,
        "{:?}",
        result.error_message
    );
    assert!(!fixture.source.path().join("folder").exists());
    assert_eq!(
        std::fs::read(fixture.destination.path().join("moved/nested/file")).unwrap(),
        b"content"
    );
}

#[tokio::test]
async fn empty_folder_and_native_folder_rename() {
    let fixture = Fixture::new().await;
    std::fs::create_dir(fixture.source.path().join("folder")).unwrap();
    let mut job = fixture.folder_job(TransferKind::Move);
    job.destination.volume_id = fixture.source_id;
    assert_eq!(fixture.run(job).await.state, TransferState::Completed);
    let mut locator = fixture.folder_job(TransferKind::Copy).source;
    locator.logical_path = "copied".into();
    fixture
        .service
        .rename_entry(locator, "renamed".into())
        .await
        .unwrap();
    assert!(fixture.source.path().join("renamed").is_dir());
    assert!(!fixture.source.path().join("folder").exists());
}

#[tokio::test]
async fn recursive_delete_requires_opt_in_confirmation_and_writable_nonroot() {
    let fixture = Fixture::new().await;
    fixture.seed_folder();
    let source = fixture.folder_job(TransferKind::Copy).source;
    assert!(fixture
        .service
        .delete_entry(source.clone(), DeleteMode::Permanent, true)
        .await
        .is_err());
    assert!(fixture
        .service
        .delete_entry_recursive(source.clone(), DeleteMode::Permanent, false, true)
        .await
        .is_err());
    let mut root = source.clone();
    root.logical_path.clear();
    assert!(fixture
        .service
        .delete_entry_recursive(root, DeleteMode::Permanent, true, true)
        .await
        .is_err());
    fixture
        .service
        .update_local_storage(fixture.source_id, "readonly".into(), true, None)
        .await
        .unwrap();
    assert!(fixture
        .service
        .delete_entry_recursive(source.clone(), DeleteMode::Permanent, true, true)
        .await
        .is_err());
    assert!(fixture.source.path().join("folder/nested/file").is_file());
    fixture
        .service
        .update_local_storage(fixture.source_id, "writable".into(), false, None)
        .await
        .unwrap();
    assert_eq!(
        fixture
            .service
            .delete_entry_recursive(source, DeleteMode::Permanent, true, true)
            .await
            .unwrap(),
        DeleteOutcome::PermanentlyDeleted
    );
    assert!(!fixture.source.path().join("folder").exists());
    assert!(fixture.source.path().join("source.bin").exists());
}

#[tokio::test]
async fn folder_destinations_cannot_overlap_even_through_other_connections() {
    let fixture = Fixture::new().await;
    fixture.seed_folder();
    let mut job = fixture.folder_job(TransferKind::Copy);
    job.destination.volume_id = fixture.source_id;
    job.destination.logical_path = "folder/inside".into();
    assert!(fixture
        .service
        .start_transfer(
            job.kind,
            job.source.clone(),
            job.destination,
            Arc::new(|_| {})
        )
        .await
        .is_err());
    let nested = fixture
        .service
        .add_selected_directory(fixture.source.path().join("folder/nested"), false)
        .await
        .unwrap();
    job.destination = StorageLocator {
        volume_id: nested.id,
        logical_path: "inside".into(),
        version_id: None,
    };
    assert!(fixture
        .service
        .start_transfer(job.kind, job.source, job.destination, Arc::new(|_| {}))
        .await
        .is_err());
    assert!(!fixture.source.path().join("folder/nested/inside").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn unsupported_children_fail_before_copying_or_deleting_anything() {
    let fixture = Fixture::new().await;
    fixture.seed_folder();
    std::os::unix::fs::symlink(
        fixture.source.path().join("source.bin"),
        fixture.source.path().join("folder/link"),
    )
    .unwrap();
    let job = fixture.folder_job(TransferKind::Move);
    let source = job.source.clone();
    assert_eq!(
        fixture.run(job).await.error_code,
        Some(StorageErrorCode::Unsupported)
    );
    assert!(!fixture.destination.path().join("copied").exists());
    assert!(fixture
        .service
        .delete_entry_recursive(source, DeleteMode::Permanent, true, true)
        .await
        .is_err());
    assert!(fixture.source.path().join("folder/nested/file").exists());
}

#[tokio::test]
async fn cancelled_folder_move_keeps_every_source_and_reports_partial_destination() {
    let fixture = Fixture::new().await;
    fixture.seed_folder();
    let job = fixture.folder_job(TransferKind::Move);
    let id = job.id;
    let token = CancellationToken::new();
    let cancel = token.clone();
    fixture
        .service
        .run_transfer(
            job,
            token,
            Arc::new(move |job| {
                if job.state == TransferState::Verifying {
                    cancel.cancel();
                }
            }),
        )
        .await;
    let result = fixture.result(id).await;
    assert_eq!(result.state, TransferState::Cancelled);
    assert!(result.error_message.unwrap().contains("目标中已完成"));
    assert!(fixture.source.path().join("folder/nested/file").exists());
    assert!(fixture.source.path().join("folder/.hidden").exists());
}

#[tokio::test]
async fn folder_move_rechecks_source_membership_and_published_target_before_cleanup() {
    for change in ["source", "target_file", "target_directory"] {
        let fixture = Fixture::new().await;
        fixture.seed_folder();
        let job = fixture.folder_job(TransferKind::Move);
        let id = job.id;
        let target = fixture.destination.path().join("copied/nested/file");
        let hidden = fixture.destination.path().join("copied/.hidden");
        let empty = fixture.destination.path().join("copied/nested/empty");
        let added = fixture.source.path().join("folder/new");
        fixture
            .service
            .run_transfer(
                job,
                CancellationToken::new(),
                Arc::new(move |job| {
                    if job.state == TransferState::Verifying && target.exists() && hidden.exists() {
                        if change == "source" {
                            std::fs::write(&added, b"new").unwrap();
                        } else if change == "target_directory" {
                            std::fs::remove_dir(&empty).unwrap();
                        } else {
                            std::fs::write(&hidden, b"changed").unwrap();
                        }
                    }
                }),
            )
            .await;
        let result = fixture.result(id).await;
        assert_eq!(
            result.state,
            TransferState::Failed,
            "{:?}",
            result.error_message
        );
        assert!(fixture.source.path().join("folder/nested/file").exists());
        assert!(fixture.source.path().join("folder/.hidden").exists());
    }
}

#[tokio::test]
async fn recursive_cleanup_never_deletes_a_file_that_replaced_a_directory() {
    let fixture = Fixture::new().await;
    fixture.seed_folder();
    let locator = fixture.folder_job(TransferKind::Copy).source;
    let backend = fixture.service.backend(fixture.source_id).await.unwrap();
    let entries = crate::tree::inventory(backend.as_ref(), &locator, &CancellationToken::new())
        .await
        .unwrap();
    let path = fixture.source.path().join("folder/nested/empty");
    std::fs::remove_dir(&path).unwrap();
    std::fs::write(&path, b"new unrelated file").unwrap();
    assert_eq!(
        crate::tree::remove_inventory(backend.as_ref(), &entries)
            .await
            .unwrap_err()
            .code,
        StorageErrorCode::Conflict
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"new unrelated file");
}

#[tokio::test]
async fn conflict_policies_preserve_skipped_sources_and_persist_renamed_destinations() {
    let fixture = Fixture::new().await;
    std::fs::write(fixture.destination.path().join("target.bin"), b"old target").unwrap();
    let request = fixture.job(TransferKind::Move);
    let skipped = fixture
        .service
        .start_transfer_with_policy(
            request.kind,
            request.source.clone(),
            request.destination.clone(),
            ConflictPolicy::Skip,
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    assert_eq!(
        fixture.result(skipped.id).await.state,
        TransferState::Skipped
    );
    assert!(fixture.source.path().join("source.bin").exists());
    assert_eq!(
        std::fs::read(fixture.destination.path().join("target.bin")).unwrap(),
        b"old target"
    );
    let copied = fixture
        .service
        .start_transfer_with_policy(
            TransferKind::Copy,
            request.source.clone(),
            request.destination.clone(),
            ConflictPolicy::Rename,
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    let copied = fixture.result(copied.id).await;
    assert_eq!(copied.state, TransferState::Completed);
    assert_eq!(copied.destination.logical_path, "target (1).bin");
    let moved = fixture
        .service
        .start_transfer_with_policy(
            TransferKind::Move,
            request.source,
            request.destination,
            ConflictPolicy::Overwrite,
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    assert_eq!(
        fixture.result(moved.id).await.state,
        TransferState::Completed
    );
    assert!(!fixture.source.path().join("source.bin").exists());
    assert_eq!(
        std::fs::read(fixture.destination.path().join("target.bin")).unwrap(),
        std::fs::read(fixture.destination.path().join("target (1).bin")).unwrap()
    );
}

#[tokio::test]
async fn cancelled_or_changed_overwrite_retains_the_old_target_and_source() {
    for cancel in [false, true] {
        let fixture = Fixture::new().await;
        let target = fixture.destination.path().join("target.bin");
        std::fs::write(&target, b"old target").unwrap();
        let token = CancellationToken::new();
        let cancel_token = token.clone();
        let callback_target = target.clone();
        let job = fixture.job(TransferKind::Move);
        let id = job.id;
        fixture
            .service
            .run_transfer_with_policy(
                job,
                token,
                Arc::new(move |job| {
                    if job.state == TransferState::Verifying {
                        if cancel {
                            cancel_token.cancel();
                        } else {
                            std::fs::write(&callback_target, b"external edit").unwrap();
                        }
                    }
                }),
                ConflictPolicy::Overwrite,
            )
            .await;
        let result = fixture.result(id).await;
        assert_eq!(
            result.state,
            if cancel {
                TransferState::Cancelled
            } else {
                TransferState::Failed
            }
        );
        assert_eq!(
            std::fs::read(target).unwrap(),
            if cancel {
                b"old target".as_slice()
            } else {
                b"external edit".as_slice()
            }
        );
        assert!(fixture.source.path().join("source.bin").exists());
    }
}

#[tokio::test]
async fn folder_overwrite_merges_without_removing_destination_only_files() {
    let fixture = Fixture::new().await;
    fixture.seed_folder();
    std::fs::create_dir(fixture.destination.path().join("copied")).unwrap();
    std::fs::write(fixture.destination.path().join("copied/.hidden"), b"old").unwrap();
    std::fs::write(
        fixture.destination.path().join("copied/only-target"),
        b"keep",
    )
    .unwrap();
    let job = fixture.folder_job(TransferKind::Move);
    let id = job.id;
    fixture
        .service
        .run_transfer_with_policy(
            job,
            CancellationToken::new(),
            Arc::new(|_| {}),
            ConflictPolicy::Overwrite,
        )
        .await;
    let result = fixture.result(id).await;
    assert_eq!(
        result.state,
        TransferState::Completed,
        "{:?}",
        result.error_message
    );
    assert_eq!(
        std::fs::read(fixture.destination.path().join("copied/only-target")).unwrap(),
        b"keep"
    );
    assert_eq!(
        std::fs::read(fixture.destination.path().join("copied/.hidden")).unwrap(),
        b"hidden"
    );
    assert!(!fixture.source.path().join("folder").exists());
}

#[tokio::test]
async fn automatic_copy_to_same_path_uses_unique_names_even_with_parallel_jobs() {
    let fixture = Fixture::new().await;
    let request = fixture.job(TransferKind::Copy);
    let mut jobs = Vec::new();
    for _ in 0..3 {
        jobs.push(
            fixture
                .service
                .start_transfer_with_policy(
                    TransferKind::Copy,
                    request.source.clone(),
                    request.source.clone(),
                    ConflictPolicy::Rename,
                    Arc::new(|_| {}),
                )
                .await
                .unwrap(),
        );
    }
    let mut names = std::collections::HashSet::new();
    for job in jobs {
        let result = fixture.result(job.id).await;
        assert_eq!(
            result.state,
            TransferState::Completed,
            "{:?}",
            result.error_message
        );
        assert!(names.insert(result.destination.logical_path));
    }
    assert!(fixture.source.path().join("source.bin").exists());
}

#[tokio::test]
async fn overwrite_rejects_mixed_kinds_and_skipping_a_folder_keeps_all_sources() {
    let fixture = Fixture::new().await;
    fixture.seed_folder();
    std::fs::create_dir(fixture.destination.path().join("target.bin")).unwrap();
    std::fs::write(fixture.destination.path().join("copied"), b"keep file").unwrap();
    for job in [
        fixture.job(TransferKind::Move),
        fixture.folder_job(TransferKind::Move),
    ] {
        let id = job.id;
        fixture
            .service
            .run_transfer_with_policy(
                job,
                CancellationToken::new(),
                Arc::new(|_| {}),
                ConflictPolicy::Overwrite,
            )
            .await;
        let result = fixture.result(id).await;
        assert_eq!(result.state, TransferState::Failed);
        assert_eq!(result.error_code, Some(StorageErrorCode::Conflict));
    }
    let job = fixture.folder_job(TransferKind::Move);
    let id = job.id;
    fixture
        .service
        .run_transfer_with_policy(
            job,
            CancellationToken::new(),
            Arc::new(|_| {}),
            ConflictPolicy::Skip,
        )
        .await;
    assert_eq!(fixture.result(id).await.state, TransferState::Skipped);
    assert!(fixture.source.path().join("source.bin").exists());
    assert_eq!(
        std::fs::read(fixture.source.path().join("folder/.hidden")).unwrap(),
        b"hidden"
    );
    assert_eq!(
        std::fs::read(fixture.destination.path().join("copied")).unwrap(),
        b"keep file"
    );
    assert!(fixture.destination.path().join("target.bin").is_dir());
}

#[tokio::test]
async fn downloaded_file_location_survives_reopening_without_restoring_general_access() {
    let fixture = Fixture::new().await;
    let downloads = tempfile::tempdir().unwrap();
    std::fs::write(fixture.source.path().join("original.txt"), b"downloaded").unwrap();
    let job = fixture
        .service
        .transfer_selected_file_with_policy(
            downloads.path().join("renamed.txt"),
            StorageLocator {
                volume_id: fixture.source_id,
                logical_path: "original.txt".into(),
                version_id: None,
            },
            false,
            ConflictPolicy::Reject,
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    assert_eq!(fixture.result(job.id).await.state, TransferState::Completed);
    let restarted = StorageService::new(
        Repository::open(&fixture._database.path().join("test.sqlite"))
            .await
            .unwrap(),
    );
    let (volume, locator) = restarted.transfer_file_location(job.id).await.unwrap();
    assert_eq!(locator.logical_path, "renamed.txt");
    let VolumeRoot::Local { root_path } = volume.root else {
        panic!("expected local volume")
    };
    assert_eq!(
        std::fs::read(root_path.join(&locator.logical_path)).unwrap(),
        b"downloaded"
    );
    assert!(restarted.stat_entry(locator.clone()).await.is_err());
    assert!(!restarted
        .list_volumes()
        .await
        .unwrap()
        .iter()
        .any(|v| v.volume.id == locator.volume_id));
    restarted
        .repository
        .remove_transfer_local_volume(locator.volume_id)
        .await
        .unwrap();
    let mut legacy = fixture.result(job.id).await;
    legacy.id = Uuid::new_v4();
    legacy.source.volume_id = Uuid::new_v4();
    restarted.repository.save_transfer(&legacy).await.unwrap();
    let error = restarted
        .transfer_file_location(legacy.id)
        .await
        .err()
        .unwrap();
    assert!(error.message.contains("未保存本地目录"));
}
