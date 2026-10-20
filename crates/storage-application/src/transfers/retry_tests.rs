#[tokio::test]
async fn retry_failed_file_keeps_its_id_and_requires_explicit_overwrite() {
    let fixture = Fixture::new().await;
    std::fs::write(fixture.destination.path().join("target.bin"), b"existing").unwrap();
    let failed = fixture.run(fixture.job(TransferKind::Copy)).await;
    assert_eq!(failed.state, TransferState::Failed);
    let queued = fixture
        .service
        .retry_transfer(failed.id, ConflictPolicy::Reject, Arc::new(|_| {}))
        .await
        .unwrap();
    assert_eq!(queued.id, failed.id);
    assert_eq!(queued.state, TransferState::Queued);
    assert_eq!(queued.bytes_transferred, 0);
    assert!(queued.error_message.is_none());
    assert_eq!(fixture.result(failed.id).await.state, TransferState::Failed);
    assert_eq!(
        std::fs::read(fixture.destination.path().join("target.bin")).unwrap(),
        b"existing"
    );
    fixture
        .service
        .retry_transfer(failed.id, ConflictPolicy::Overwrite, Arc::new(|_| {}))
        .await
        .unwrap();
    let completed = fixture.result(failed.id).await;
    assert_eq!(
        completed.state,
        TransferState::Completed,
        "{:?}",
        completed.error_message
    );
    assert!(
        std::fs::read(fixture.destination.path().join("target.bin")).unwrap()
            == vec![42; BUFFER_SIZE * 3 + 17]
    );
    assert_eq!(fixture.service.list_transfers().await.unwrap().len(), 1);
    assert!(completed.error_code.is_none());
    assert!(fixture
        .service
        .retry_transfer(failed.id, ConflictPolicy::Reject, Arc::new(|_| {}))
        .await
        .is_err());
}

#[tokio::test]
async fn retry_interrupted_folder_verifies_existing_files_and_copies_the_rest() {
    let fixture = Fixture::new().await;
    fixture.seed_folder();
    std::fs::create_dir_all(fixture.destination.path().join("copied/nested")).unwrap();
    let saved = fixture.destination.path().join("copied/nested/file");
    std::fs::write(&saved, b"content").unwrap();
    let modified = std::fs::metadata(&saved).unwrap().modified().unwrap();
    std::fs::write(
        fixture.destination.path().join("copied/target-only"),
        b"keep",
    )
    .unwrap();
    let mut job = fixture.folder_job(TransferKind::Copy);
    job.state = TransferState::Interrupted;
    job.bytes_transferred = 999;
    fixture
        .service
        .repository
        .save_transfer(&job)
        .await
        .unwrap();
    fixture
        .service
        .retry_transfer(job.id, ConflictPolicy::Reject, Arc::new(|_| {}))
        .await
        .unwrap();
    let result = fixture.result(job.id).await;
    assert_eq!(
        result.state,
        TransferState::Completed,
        "{:?}",
        result.error_message
    );
    assert_eq!(result.bytes_transferred, 13);
    assert_eq!(result.bytes_total, Some(13));
    assert_eq!(
        std::fs::metadata(saved).unwrap().modified().unwrap(),
        modified
    );
    assert!(fixture
        .destination
        .path()
        .join("copied/nested/empty")
        .is_dir());
    assert!(fixture
        .destination
        .path()
        .join("copied/target-only")
        .exists());
    assert!(fixture.source.path().join("folder/.hidden").exists());
}

#[tokio::test]
async fn retry_move_preserves_sources_until_existing_targets_match() {
    let fixture = Fixture::new().await;
    fixture.seed_folder();
    std::fs::create_dir_all(fixture.destination.path().join("copied/nested")).unwrap();
    std::fs::write(
        fixture.destination.path().join("copied/nested/file"),
        b"changed",
    )
    .unwrap();
    let mut job = fixture.folder_job(TransferKind::Move);
    job.state = TransferState::Interrupted;
    fixture
        .service
        .repository
        .save_transfer(&job)
        .await
        .unwrap();
    fixture
        .service
        .retry_transfer(job.id, ConflictPolicy::Reject, Arc::new(|_| {}))
        .await
        .unwrap();
    assert_eq!(fixture.result(job.id).await.state, TransferState::Failed);
    assert!(fixture.source.path().join("folder/nested/file").exists());
    assert!(fixture.source.path().join("folder/.hidden").exists());
    fixture
        .service
        .retry_transfer(job.id, ConflictPolicy::Overwrite, Arc::new(|_| {}))
        .await
        .unwrap();
    let result = fixture.result(job.id).await;
    assert_eq!(
        result.state,
        TransferState::Completed,
        "{:?}",
        result.error_message
    );
    assert!(!fixture.source.path().join("folder").exists());
    assert_eq!(
        std::fs::read(fixture.destination.path().join("copied/nested/file")).unwrap(),
        b"content"
    );
}

#[tokio::test]
async fn retry_same_volume_move_finishes_a_verified_existing_destination() {
    let fixture = Fixture::new().await;
    std::fs::write(
        fixture.source.path().join("target.bin"),
        vec![42; BUFFER_SIZE * 3 + 17],
    )
    .unwrap();
    let mut job = fixture.job(TransferKind::Move);
    job.destination.volume_id = fixture.source_id;
    job.state = TransferState::Interrupted;
    fixture
        .service
        .repository
        .save_transfer(&job)
        .await
        .unwrap();
    fixture
        .service
        .retry_transfer(job.id, ConflictPolicy::Reject, Arc::new(|_| {}))
        .await
        .unwrap();
    assert_eq!(fixture.result(job.id).await.state, TransferState::Completed);
    assert!(!fixture.source.path().join("source.bin").exists());
    assert!(fixture.source.path().join("target.bin").exists());
}

#[tokio::test]
async fn retry_is_atomic_and_rechecks_current_permissions() {
    let fixture = Fixture::new().await;
    let mut job = fixture.job(TransferKind::Copy);
    job.state = TransferState::Failed;
    fixture
        .service
        .repository
        .save_transfer(&job)
        .await
        .unwrap();
    let guard = fixture.service.mutation_lock.write().await;
    let (left, right) = tokio::join!(
        fixture
            .service
            .retry_transfer(job.id, ConflictPolicy::Reject, Arc::new(|_| {})),
        fixture
            .service
            .retry_transfer(job.id, ConflictPolicy::Reject, Arc::new(|_| {})),
    );
    assert_eq!(usize::from(left.is_ok()) + usize::from(right.is_ok()), 1);
    fixture.service.cancel_transfer(job.id).await.unwrap();
    assert_eq!(fixture.result(job.id).await.state, TransferState::Cancelled);
    drop(guard);
    assert!(fixture
        .service
        .retry_transfer(job.id, ConflictPolicy::Reject, Arc::new(|_| {}))
        .await
        .is_err());
    job.state = TransferState::Interrupted;
    fixture
        .service
        .repository
        .save_transfer(&job)
        .await
        .unwrap();
    fixture
        .service
        .update_local_storage(fixture.destination_id, "readonly".into(), true, None)
        .await
        .unwrap();
    fixture
        .service
        .retry_transfer(job.id, ConflictPolicy::Reject, Arc::new(|_| {}))
        .await
        .unwrap();
    let result = fixture.result(job.id).await;
    assert_eq!(result.state, TransferState::Failed);
    assert_eq!(result.error_code, Some(StorageErrorCode::AccessDenied));
    assert!(!fixture.destination.path().join("target.bin").exists());
}

#[tokio::test]
async fn retry_native_upload_and_download_restore_only_the_selected_path_after_reopening() {
    for upload in [true, false] {
        let fixture = Fixture::new().await;
        let remote = StorageLocator {
            volume_id: if upload {
                fixture.destination_id
            } else {
                fixture.source_id
            },
            logical_path: if upload {
                "".into()
            } else {
                "source.bin".into()
            },
            version_id: None,
        };
        let selected = if upload {
            fixture.source.path().join("source.bin")
        } else {
            fixture.destination.path().join("renamed.bin")
        };
        let target =
            fixture
                .destination
                .path()
                .join(if upload { "source.bin" } else { "renamed.bin" });
        std::fs::write(&target, b"existing").unwrap();
        let original = fixture
            .service
            .transfer_selected_file_with_policy(
                selected,
                remote,
                upload,
                ConflictPolicy::Reject,
                Arc::new(|_| {}),
            )
            .await
            .unwrap();
        assert_eq!(
            fixture.result(original.id).await.state,
            TransferState::Failed
        );
        let reopened = StorageService::new(
            Repository::open(&fixture._database.path().join("test.sqlite"))
                .await
                .unwrap(),
        );
        let local = if upload {
            &original.source
        } else {
            &original.destination
        };
        assert!(reopened.backend(local.volume_id).await.is_err());
        reopened
            .restore_transfer_local_backend(local)
            .await
            .unwrap();
        let backend = reopened.backend(local.volume_id).await.unwrap();
        assert!(backend
            .stat(&StorageLocator {
                logical_path: "sibling.bin".into(),
                ..local.clone()
            })
            .await
            .is_err());
        assert!(backend.delete(local).await.is_err());
        if !upload {
            assert!(reopened
                .retry_transfer(original.id, ConflictPolicy::Rename, Arc::new(|_| {}))
                .await
                .is_err());
        }
        reopened
            .retry_transfer(original.id, ConflictPolicy::Overwrite, Arc::new(|_| {}))
            .await
            .unwrap();
        let result = fixture.result(original.id).await;
        assert_eq!(
            result.state,
            TransferState::Completed,
            "{:?}",
            result.error_message
        );
        assert!(std::fs::read(target).unwrap() == vec![42; BUFFER_SIZE * 3 + 17]);
        assert!(reopened.backend(local.volume_id).await.is_err());
    }
}

#[tokio::test]
async fn retry_can_preserve_conflicting_files_under_a_new_name() {
    let fixture = Fixture::new().await;
    std::fs::write(fixture.destination.path().join("target.bin"), b"keep").unwrap();
    let failed = fixture.run(fixture.job(TransferKind::Copy)).await;
    fixture
        .service
        .retry_transfer(failed.id, ConflictPolicy::Rename, Arc::new(|_| {}))
        .await
        .unwrap();
    let result = fixture.result(failed.id).await;
    assert_eq!(
        result.state,
        TransferState::Completed,
        "{:?}",
        result.error_message
    );
    assert_eq!(result.destination.logical_path, "target (1).bin");
    assert_eq!(
        std::fs::read(fixture.destination.path().join("target.bin")).unwrap(),
        b"keep"
    );
    assert!(
        std::fs::read(fixture.destination.path().join("target (1).bin")).unwrap()
            == vec![42; BUFFER_SIZE * 3 + 17]
    );
}

#[tokio::test]
async fn retry_missing_connection_does_not_replace_the_failed_state() {
    let fixture = Fixture::new().await;
    let mut job = fixture.job(TransferKind::Copy);
    job.state = TransferState::Failed;
    job.error_message = Some("原连接失败".into());
    fixture
        .service
        .repository
        .save_transfer(&job)
        .await
        .unwrap();
    fixture
        .service
        .repository
        .remove_local(fixture.destination_id)
        .await
        .unwrap();
    let error = fixture
        .service
        .retry_transfer(job.id, ConflictPolicy::Reject, Arc::new(|_| {}))
        .await
        .unwrap_err();
    assert_eq!(error.code, StorageErrorCode::NotFound);
    let saved = fixture.result(job.id).await;
    assert_eq!(saved.state, TransferState::Failed);
    assert_eq!(saved.error_message, job.error_message);
}

#[tokio::test]
async fn retry_native_folder_upload_continues_after_reopening() {
    let fixture = Fixture::new().await;
    fixture.seed_folder();
    std::fs::create_dir_all(fixture.destination.path().join("folder/nested")).unwrap();
    std::fs::write(
        fixture.destination.path().join("folder/nested/file"),
        b"content",
    )
    .unwrap();
    let original = fixture
        .service
        .transfer_selected_file_with_policy(
            fixture.source.path().join("folder"),
            StorageLocator {
                volume_id: fixture.destination_id,
                logical_path: "".into(),
                version_id: None,
            },
            true,
            ConflictPolicy::Reject,
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    assert_eq!(
        fixture.result(original.id).await.state,
        TransferState::Failed
    );
    let reopened = StorageService::new(
        Repository::open(&fixture._database.path().join("test.sqlite"))
            .await
            .unwrap(),
    );
    reopened
        .retry_transfer(original.id, ConflictPolicy::Reject, Arc::new(|_| {}))
        .await
        .unwrap();
    let result = fixture.result(original.id).await;
    assert_eq!(
        result.state,
        TransferState::Completed,
        "{:?}",
        result.error_message
    );
    assert!(fixture.destination.path().join("folder/.hidden").exists());
    assert!(fixture
        .destination
        .path()
        .join("folder/nested/empty")
        .is_dir());
    assert!(reopened.backend(original.source.volume_id).await.is_err());
}
