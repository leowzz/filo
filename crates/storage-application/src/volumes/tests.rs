use super::*;
use storage_repository::Repository;

#[tokio::test]
async fn removing_location_preserves_files_and_revokes_access() {
    let directory = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let database = tempfile::tempdir().unwrap();
    let database_path = database.path().join("test.sqlite");
    let repo = Repository::open(&database_path).await.unwrap();
    let service = StorageService::new(repo);
    std::fs::write(directory.path().join("keep.txt"), b"keep").unwrap();
    let volume = service
        .add_selected_directory(directory.path().to_path_buf(), true)
        .await
        .unwrap();
    let remaining = service
        .add_selected_directory(other.path().to_path_buf(), false)
        .await
        .unwrap();
    assert_eq!(
        service
            .remove_local_storage(volume.id, false)
            .await
            .unwrap_err()
            .code,
        StorageErrorCode::Conflict
    );
    assert_eq!(service.list_volumes().await.unwrap().len(), 2);
    service.remove_local_storage(volume.id, true).await.unwrap();
    assert_eq!(
        std::fs::read(directory.path().join("keep.txt")).unwrap(),
        b"keep"
    );
    assert_eq!(
        service
            .list_entries(StorageLocator {
                volume_id: volume.id,
                logical_path: String::new(),
                version_id: None
            })
            .await
            .unwrap_err()
            .code,
        StorageErrorCode::NotFound
    );
    let reopened = Repository::open(&database_path).await.unwrap();
    assert_eq!(reopened.list_volumes().await.unwrap()[0].id, remaining.id);
    assert_eq!(reopened.list_connections().await.unwrap().len(), 1);
    assert_eq!(
        service
            .remove_local_storage(volume.id, true)
            .await
            .unwrap_err()
            .code,
        StorageErrorCode::NotFound
    );
    let added = service
        .add_selected_directory(directory.path().to_path_buf(), true)
        .await
        .unwrap();
    assert_ne!(added.id, volume.id);
}

#[tokio::test]
async fn edited_read_only_is_enforced_by_subsequent_operations() {
    let directory = tempfile::tempdir().unwrap();
    let database = tempfile::tempdir().unwrap();
    let repo = Repository::open(&database.path().join("test.sqlite"))
        .await
        .unwrap();
    let service = StorageService::new(repo);
    let volume = service
        .add_selected_directory(directory.path().to_path_buf(), true)
        .await
        .unwrap();
    let parent = StorageLocator {
        volume_id: volume.id,
        logical_path: String::new(),
        version_id: None,
    };
    service
        .update_local_storage(volume.id, "可写目录".into(), false, None)
        .await
        .unwrap();
    service
        .create_directory(parent.clone(), "created".into())
        .await
        .unwrap();
    service
        .update_local_storage(volume.id, "只读目录".into(), true, None)
        .await
        .unwrap();
    assert_eq!(
        service
            .create_directory(parent.clone(), "blocked".into())
            .await
            .unwrap_err()
            .code,
        StorageErrorCode::AccessDenied
    );
    let folder = StorageLocator {
        logical_path: "created".into(),
        ..parent
    };
    assert_eq!(
        service
            .delete_entry(folder, DeleteMode::Default, true)
            .await
            .unwrap_err()
            .code,
        StorageErrorCode::AccessDenied
    );
    let view = service.list_volumes().await.unwrap().remove(0);
    assert_eq!(view.volume.name, "只读目录");
    assert!(!view.capabilities.create_directory && !view.capabilities.delete);
    assert!(service
        .update_local_storage(volume.id, "  ".into(), false, None)
        .await
        .is_err());
    assert!(service
        .update_local_storage(
            volume.id,
            "失败保存".into(),
            false,
            Some(directory.path().join("missing"))
        )
        .await
        .is_err());
    assert!(service.list_volumes().await.unwrap()[0].volume.read_only);
    assert_eq!(
        service
            .update_local_storage(Uuid::new_v4(), "未知".into(), false, None)
            .await
            .unwrap_err()
            .code,
        StorageErrorCode::NotFound
    );
}

#[tokio::test]
async fn changing_root_switches_listing_without_moving_files() {
    let original = tempfile::tempdir().unwrap();
    let replacement = tempfile::tempdir().unwrap();
    let database = tempfile::tempdir().unwrap();
    std::fs::write(original.path().join("old.txt"), b"old").unwrap();
    std::fs::write(replacement.path().join("new.txt"), b"new").unwrap();
    let repo = Repository::open(&database.path().join("test.sqlite"))
        .await
        .unwrap();
    let service = StorageService::new(repo);
    let volume = service
        .add_selected_directory(original.path().to_path_buf(), true)
        .await
        .unwrap();
    let updated = service
        .update_local_storage(
            volume.id,
            "新目录".into(),
            true,
            Some(replacement.path().to_path_buf()),
        )
        .await
        .unwrap();
    assert_eq!(updated.id, volume.id);
    assert_eq!(updated.connection_id, volume.connection_id);
    let entries = service
        .list_entries(StorageLocator {
            volume_id: volume.id,
            logical_path: String::new(),
            version_id: None,
        })
        .await
        .unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "new.txt");
    assert_eq!(
        std::fs::read(original.path().join("old.txt")).unwrap(),
        b"old"
    );
    assert!(!replacement.path().join("old.txt").exists());
}

#[tokio::test]
async fn service_requires_confirmation_and_registered_volume() {
    let directory = tempfile::tempdir().unwrap();
    let database = tempfile::tempdir().unwrap();
    let repository = Repository::open(&database.path().join("test.sqlite"))
        .await
        .unwrap();
    let service = StorageService::new(repository);
    std::fs::write(directory.path().join("existing.txt"), b"keep").unwrap();
    let volume = service
        .add_selected_directory(directory.path().to_path_buf(), false)
        .await
        .unwrap();
    let locator = StorageLocator {
        volume_id: volume.id,
        logical_path: "existing.txt".into(),
        version_id: None,
    };
    assert_eq!(
        service
            .delete_entry(locator.clone(), DeleteMode::Default, false)
            .await
            .unwrap_err()
            .code,
        StorageErrorCode::Conflict
    );
    assert!(directory.path().join("existing.txt").exists());
    assert!(service
        .rename_entry(locator.clone(), "../escape".into())
        .await
        .is_err());
    let unknown = StorageLocator {
        volume_id: Uuid::new_v4(),
        ..locator.clone()
    };
    assert_eq!(
        service.stat_entry(unknown).await.unwrap_err().code,
        StorageErrorCode::NotFound
    );
    service
        .delete_entry(locator, DeleteMode::Permanent, true)
        .await
        .unwrap();
    assert!(!directory.path().join("existing.txt").exists());
}
