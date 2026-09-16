use super::execution::BUFFER_SIZE;
use super::*;
use std::time::Duration;
use storage_repository::Repository;

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
    let guard = fixture.service.mutation_lock.lock().await;
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
