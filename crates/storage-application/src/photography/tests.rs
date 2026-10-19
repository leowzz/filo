use super::*;
use std::path::Path;

#[tokio::test]
async fn opening_an_existing_review_preserves_xmp_scores_until_an_explicit_mark() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    let (service, input) = setup(path).await;
    std::fs::write(path.join("raw/photo.NEF"), b"raw").unwrap();
    let original=br#"<r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><r:Description xmlns:q="http://ns.adobe.com/xap/1.0/" xmlns:d="http://ns.adobe.com/xmp/1.0/DynamicMedia/" q:Rating="4" d:pick="1"/></r:RDF>"#;
    std::fs::write(path.join("raw/photo.xmp"), original).unwrap();
    let review = service.photo_review_workspace();
    let session = review
        .photo_open_review("existing".into(), input.raw, None)
        .await
        .unwrap();
    let photo = review.photo_catalog().await.unwrap().photos.remove(0);
    assert_eq!(photo.rating, 4);
    assert_eq!(photo.flag, PhotoFlag::Pick);
    assert!(!photo.reviewed);
    assert!(review
        .photo_prepare_lrc(session.id)
        .await
        .unwrap()
        .failures
        .is_empty());
    assert_eq!(std::fs::read(path.join("raw/photo.xmp")).unwrap(), original);
    review
        .photo_mark(session.id, photo.id, 0, PhotoFlag::None)
        .await
        .unwrap();
    assert!(review
        .photo_prepare_lrc(session.id)
        .await
        .unwrap()
        .failures
        .is_empty());
    let bytes = std::fs::read(path.join("raw/photo.xmp")).unwrap();
    let mark = super::xmp::read_mark(&bytes).unwrap();
    assert_eq!(mark.rating, 0);
    assert_eq!(mark.flag, PhotoFlag::None);
}

fn dated_tiff(date: &str) -> Vec<u8> {
    let mut bytes = vec![0u8; 96];
    bytes[..8].copy_from_slice(b"II\x2a\0\x08\0\0\0");
    bytes[8..10].copy_from_slice(&1u16.to_le_bytes());
    bytes[10..12].copy_from_slice(&0x9003u16.to_le_bytes());
    bytes[12..14].copy_from_slice(&2u16.to_le_bytes());
    bytes[14..18].copy_from_slice(&20u32.to_le_bytes());
    bytes[18..22].copy_from_slice(&32u32.to_le_bytes());
    bytes[32..52].copy_from_slice(format!("{} 12:00:00\0", date.replace('-', ":")).as_bytes());
    bytes
}

#[tokio::test]
async fn presets_keep_real_camera_dates_and_do_not_apply_fallback_to_valid_dates() {
    for (layout, keep, expected) in [
        (PhotoLayout::Date, false, "2026/2026-10-18/photo.NEF"),
        (
            PhotoLayout::Date,
            true,
            "2026/2026-10-18/107NZ5_2/photo.NEF",
        ),
        (
            PhotoLayout::Batch,
            true,
            "2026-10-19_旅行/107NZ5_2/photo.NEF",
        ),
        (PhotoLayout::Original, true, "107NZ5_2/photo.NEF"),
        (PhotoLayout::Batch, false, "2026-10-19_旅行/photo.NEF"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        let (service, mut input) = setup(path).await;
        std::fs::write(
            path.join("card/DCIM/107NZ5_2/photo.NEF"),
            dated_tiff("2026-10-18"),
        )
        .unwrap();
        std::fs::write(
            path.join("card/DCIM/107NZ5_2/next.NEF"),
            dated_tiff("2026-10-19"),
        )
        .unwrap();
        input.layout = layout;
        input.keep_hierarchy = keep;
        let session = service.photo_plan(input).await.unwrap();
        let catalog = service.photo_catalog().await.unwrap();
        let photo = catalog
            .photos
            .iter()
            .find(|p| p.original_path.ends_with("photo.NEF"))
            .unwrap();
        assert_eq!(photo.capture_date.as_deref(), Some("2026-10-18"));
        assert_eq!(photo.files[0].path, expected);
        assert!(photo.issues.is_empty());
        assert_eq!(session.photo_ids.len(), 2);
    }
}

#[tokio::test]
async fn nas_outage_does_not_block_local_marks_and_can_be_retried() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    let (service, input) = setup(path).await;
    jpeg(&path.join("jpg/photo.JPG"));
    let review = service.photo_review_workspace();
    let session = review
        .photo_open_review("offline".into(), input.jpg, None)
        .await
        .unwrap();
    let id = session.photo_ids[0];
    review.photo_sync(session.id).await.unwrap();
    std::fs::rename(path.join("jpg"), path.join("offline")).unwrap();
    review
        .photo_mark(session.id, id, 4, PhotoFlag::Pick)
        .await
        .unwrap();
    assert!(review.photo_sync(session.id).await.is_err());
    let catalog = review.photo_catalog().await.unwrap();
    assert_eq!(catalog.photos[0].rating, 4);
    assert!(catalog.sessions[0].sync_error.is_some());
    assert!(catalog.sessions[0].revision > catalog.sessions[0].synced_revision);
    std::fs::rename(path.join("offline"), path.join("jpg")).unwrap();
    review.photo_sync(session.id).await.unwrap();
    let catalog = review.photo_catalog().await.unwrap();
    assert_eq!(
        catalog.sessions[0].revision,
        catalog.sessions[0].synced_revision
    );
}

async fn location(service: &StorageService, path: &Path) -> StorageLocator {
    let volume = service
        .add_selected_directory(path.to_path_buf(), false)
        .await
        .unwrap();
    StorageLocator {
        volume_id: volume.id,
        logical_path: String::new(),
        version_id: None,
    }
}
fn jpeg(path: &Path) {
    image::RgbImage::from_pixel(32, 16, image::Rgb([80, 100, 140]))
        .save(path)
        .unwrap();
}

#[tokio::test]
async fn review_opens_existing_files_without_import_and_uses_an_independent_journal() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    let (service, input) = setup(path).await;
    std::fs::write(
        path.join("raw/photo.NEF"),
        crate::browsing::nef::fixture(true, false),
    )
    .unwrap();
    jpeg(&path.join("jpg/photo.JPG"));
    let review = service.photo_review_workspace();
    let session = review
        .photo_open_review(
            "已有图库".into(),
            input.jpg.clone(),
            Some(input.raw.clone()),
        )
        .await
        .unwrap();
    assert!(service.photo_catalog().await.unwrap().sessions.is_empty());
    let catalog = review.photo_catalog().await.unwrap();
    assert_eq!(catalog.photos.len(), 1);
    assert_eq!(catalog.photos[0].files.len(), 2);
    assert!(catalog.photos[0].files.iter().all(|f| !f.verified));
    let id = catalog.photos[0].id;
    let preview = review.photo_preview(id, true, false).await.unwrap();
    assert!(!preview.embedded);
    assert_eq!((preview.width, preview.height), (32, 16));
    {
        let _copy_busy = service.photo_lock.lock().await;
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            review.photo_mark(session.id, id, 3, PhotoFlag::Reject),
        )
        .await
        .unwrap()
        .unwrap();
    }
    assert!(service.photo_catalog().await.unwrap().photos.is_empty());
    let reopened = review
        .photo_open_review("再次打开".into(), input.jpg, Some(input.raw))
        .await
        .unwrap();
    assert_eq!(reopened.photo_ids, session.photo_ids);
    let photo = review.photo_undo(session.id).await.unwrap().unwrap();
    assert_eq!(photo.rating, 0);
    assert!(!photo.reviewed);
    assert_eq!(std::fs::read_dir(path.join("jpg")).unwrap().count(), 1);
}

#[tokio::test]
async fn review_covers_over_200_photos_and_portable_sync_restores_on_a_second_computer() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    let (service, input) = setup(path).await;
    for i in 0..241 {
        jpeg(&path.join(format!("jpg/{i:04}.JPG")));
    }
    let review = service.photo_review_workspace();
    let session = review
        .photo_open_review("241 张".into(), input.jpg, None)
        .await
        .unwrap();
    assert_eq!(session.photo_ids.len(), 241);
    let last = session.photo_ids[240];
    review
        .photo_mark(session.id, last, 5, PhotoFlag::Pick)
        .await
        .unwrap();
    review
        .photo_save_position(
            session.id,
            PhotoReviewPosition {
                current: Some(last),
                filter: "pick".into(),
                minimum_rating: 3,
                auto_advance: true,
            },
        )
        .await
        .unwrap();
    review.photo_sync(session.id).await.unwrap();
    let manifest_path = path.join(format!("jpg/.filo/reviews/{}.json", session.id));
    let bytes = std::fs::read(&manifest_path).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains(path.to_str().unwrap()));
    let other_dir = tempfile::tempdir().unwrap();
    let other = StorageService::new(
        Repository::open(&other_dir.path().join("other.sqlite"))
            .await
            .unwrap(),
    );
    let root = location(&other, &path.join("jpg")).await;
    let other = other.photo_review_workspace();
    assert_eq!(other.photo_restore(root.clone(), root).await.unwrap(), 1);
    let catalog = other.photo_catalog().await.unwrap();
    let photo = catalog.photos.iter().find(|p| p.id == last).unwrap();
    assert_eq!(photo.rating, 5);
    assert_eq!(photo.flag, PhotoFlag::Pick);
    assert_eq!(catalog.sessions[0].position.current, Some(last));
    assert!(catalog.sessions[0].source.is_none());
    assert!(!path.join("jpg/.filo/sessions").exists());
    // A peer edit is a conflict, never an overwrite of the NAS or the local pending score.
    let mut remote: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    remote["session"]["name"] = "另一台电脑".into();
    std::fs::write(&manifest_path, serde_json::to_vec(&remote).unwrap()).unwrap();
    review
        .photo_mark(session.id, last, 4, PhotoFlag::Reject)
        .await
        .unwrap();
    assert_eq!(
        review.photo_sync(session.id).await.unwrap_err().code,
        StorageErrorCode::Conflict
    );
    assert_eq!(
        review
            .photo_catalog()
            .await
            .unwrap()
            .photos
            .iter()
            .find(|p| p.id == last)
            .unwrap()
            .rating,
        4
    );
    assert!(String::from_utf8(std::fs::read(&manifest_path).unwrap())
        .unwrap()
        .contains("另一台电脑"));
    assert!(std::fs::read_dir(path.join("jpg/.filo/reviews"))
        .unwrap()
        .any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("local-conflict")));
}

#[tokio::test]
async fn xmp_handoff_preserves_adjustments_and_acr_and_stops_on_external_changes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    let (service, input) = setup(path).await;
    std::fs::write(path.join("raw/photo.NEF"), b"raw unchanged").unwrap();
    std::fs::write(path.join("raw/photo.acr"), b"acr unchanged").unwrap();
    std::fs::write(path.join("raw/photo.xmp"),br#"<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="+1.25"/></rdf:RDF>"#).unwrap();
    let review = service.photo_review_workspace();
    let session = review
        .photo_open_review("RAW".into(), input.raw, None)
        .await
        .unwrap();
    let id = session.photo_ids[0];
    review
        .photo_mark(session.id, id, 3, PhotoFlag::Reject)
        .await
        .unwrap();
    let result = review.photo_prepare_lrc(session.id).await.unwrap();
    assert!(result.failures.is_empty());
    assert_eq!(result.directories.len(), 1);
    let before = std::fs::read(path.join("raw/photo.xmp")).unwrap();
    let text = String::from_utf8_lossy(&before);
    assert!(text.contains("Exposure2012=\"+1.25\""));
    assert!(text.contains("<xmp:Rating>3</xmp:Rating>"));
    assert!(text.contains("<xmpDM:pick>-1</xmpDM:pick>"));
    assert_eq!(
        std::fs::read(path.join("raw/photo.acr")).unwrap(),
        b"acr unchanged"
    );
    assert_eq!(
        std::fs::read(path.join("raw/photo.NEF")).unwrap(),
        b"raw unchanged"
    );
    let external = String::from_utf8(before).unwrap().replace("+1.25", "+2.25");
    std::fs::write(path.join("raw/photo.xmp"), &external).unwrap();
    review
        .photo_mark(session.id, id, 4, PhotoFlag::Pick)
        .await
        .unwrap();
    assert_eq!(
        review
            .photo_prepare_lrc(session.id)
            .await
            .unwrap()
            .failures
            .len(),
        1
    );
    assert_eq!(
        std::fs::read_to_string(path.join("raw/photo.xmp")).unwrap(),
        external
    );
}

#[tokio::test]
async fn local_save_failure_does_not_commit_mark_or_undo_history() {
    use sqlx::Connection;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    let (service, input) = setup(path).await;
    jpeg(&path.join("jpg/photo.JPG"));
    let review = service.photo_review_workspace();
    let session = review
        .photo_open_review("save failure".into(), input.jpg, None)
        .await
        .unwrap();
    let id = session.photo_ids[0];
    let mut connection = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(path.join("db.sqlite")),
    )
    .await
    .unwrap();
    sqlx::query("CREATE TRIGGER fail_photo_save BEFORE UPDATE ON photo_review_catalog BEGIN SELECT RAISE(FAIL, 'simulated disk failure'); END").execute(&mut connection).await.unwrap();
    assert!(review
        .photo_mark(session.id, id, 5, PhotoFlag::Pick)
        .await
        .is_err());
    let catalog = review.photo_catalog().await.unwrap();
    assert_eq!(catalog.photos[0].rating, 0);
    assert!(!catalog.photos[0].reviewed);
    assert!(catalog.sessions[0].undo.is_empty());
    sqlx::query("DROP TRIGGER fail_photo_save")
        .execute(&mut connection)
        .await
        .unwrap();
    review
        .photo_mark(session.id, id, 5, PhotoFlag::Pick)
        .await
        .unwrap();
}

#[tokio::test]
async fn interrupted_pair_can_resume_and_backups_fill_missing_members() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    let (service, input) = setup(path).await;
    write_pair(path, "a", "photo", b"content");
    std::fs::remove_file(path.join("card/DCIM/a/photo.JPG")).unwrap();
    let first = service.photo_plan(input.clone()).await.unwrap();
    service
        .photo_import(first.id, Arc::new(|_| {}))
        .await
        .unwrap();
    std::fs::write(path.join("card/DCIM/a/photo.JPG"), b"contentJPG").unwrap();
    let next = service.photo_plan(input).await.unwrap();
    assert_eq!(next.photo_ids, first.photo_ids);
    service
        .photo_import(next.id, Arc::new(|_| {}))
        .await
        .unwrap();
    assert_eq!(service.photo_catalog().await.unwrap().photos.len(), 1);
    assert!(service.photo_catalog().await.unwrap().photos[0]
        .files
        .iter()
        .all(|f| f.verified));
    assert!(
        service.list_transfers().await.unwrap().is_empty(),
        "import history must remain independent"
    );
}

async fn setup(path: &Path) -> (StorageService, PhotoPlanInput) {
    for name in ["card/DCIM/107NZ5_2", "jpg", "raw"] {
        std::fs::create_dir_all(path.join(name)).unwrap();
    }
    let service = StorageService::new(Repository::open(&path.join("db.sqlite")).await.unwrap());
    async fn root(
        service: &StorageService,
        path: std::path::PathBuf,
        read_only: bool,
    ) -> StorageLocator {
        let volume = service
            .add_selected_directory(path, read_only)
            .await
            .unwrap();
        StorageLocator {
            volume_id: volume.id,
            logical_path: String::new(),
            version_id: None,
        }
    }
    let input = PhotoPlanInput {
        name: "2026-10-19_旅行".into(),
        card_name: "主卡".into(),
        source: root(&service, path.join("card"), true).await,
        jpg: root(&service, path.join("jpg"), false).await,
        raw: root(&service, path.join("raw"), false).await,
        layout: PhotoLayout::Date,
        keep_hierarchy: false,
        date_override: Some("2026-10-19".into()),
    };
    (service, input)
}

#[tokio::test]
async fn directory_review_saves_beside_photos_and_restores_without_local_history() {
    let dir = tempfile::tempdir().unwrap();
    let (service, input) = setup(dir.path()).await;
    let folder = dir.path().join("jpg/trip/day1");
    std::fs::create_dir_all(folder.join(".filo/cache")).unwrap();
    jpeg(&folder.join("one.jpg"));
    jpeg(&folder.join("two.jpg"));
    jpeg(&folder.join(".filo/cache/hidden.jpg"));
    jpeg(&dir.path().join("jpg/outside.jpg"));
    let root = StorageLocator {
        logical_path: "trip/day1".into(),
        ..input.jpg
    };
    let review = service.photo_review_workspace();
    let session = review
        .photo_open_directory_review(root.clone())
        .await
        .unwrap();
    assert_eq!(session.photo_ids.len(), 2);
    assert_eq!(session.directory.as_ref(), Some(&root));
    let id = session.photo_ids[0];
    review
        .photo_mark(session.id, id, 4, PhotoFlag::Pick)
        .await
        .unwrap();
    review
        .photo_save_position(
            session.id,
            PhotoReviewPosition {
                current: Some(id),
                filter: "pick".into(),
                minimum_rating: 4,
                auto_advance: true,
            },
        )
        .await
        .unwrap();
    let progress = folder.join(".filo/review.json");
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&progress).unwrap()).unwrap();
    assert_eq!(manifest["photos"][0]["rating"], 4);
    assert_eq!(manifest["session"]["position"]["current"], id.to_string());
    assert!(manifest["session"]["directory"].is_null());
    assert!(!dir.path().join("jpg/.filo").exists());
    assert!(service.photo_catalog().await.unwrap().sessions.is_empty());

    // A fresh database and different volume ID still recover from the folder.
    let other = StorageService::new(
        Repository::open(&dir.path().join("other.sqlite"))
            .await
            .unwrap(),
    );
    let volume = other
        .add_selected_directory(dir.path().join("jpg"), false)
        .await
        .unwrap();
    let root = StorageLocator {
        volume_id: volume.id,
        ..root
    };
    let other = other.photo_review_workspace();
    let restored = other
        .photo_open_directory_review(root.clone())
        .await
        .unwrap();
    assert_eq!(restored.id, session.id);
    assert_eq!(restored.position.current, Some(id));
    assert_eq!(restored.position.minimum_rating, 4);
    assert!(restored.position.auto_advance);
    let catalog = other.photo_catalog().await.unwrap();
    assert_eq!(
        catalog.photos.iter().find(|p| p.id == id).unwrap().rating,
        4
    );
    other.photo_undo(restored.id).await.unwrap();
    let again = other.photo_open_directory_review(root).await.unwrap();
    assert_eq!(again.id, session.id);
    assert_eq!(other.photo_catalog().await.unwrap().sessions.len(), 1);
    assert_eq!(
        other
            .photo_catalog()
            .await
            .unwrap()
            .photos
            .iter()
            .find(|p| p.id == id)
            .unwrap()
            .rating,
        0
    );
}

#[tokio::test]
async fn directory_review_preserves_external_changes_and_reports_failed_saves() {
    let dir = tempfile::tempdir().unwrap();
    let (service, input) = setup(dir.path()).await;
    jpeg(&dir.path().join("jpg/one.jpg"));
    let review = service.photo_review_workspace();
    let session = review
        .photo_open_directory_review(input.jpg.clone())
        .await
        .unwrap();
    let id = session.photo_ids[0];
    let target = dir.path().join("jpg/.filo/review.json");
    let mut external: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&target).unwrap()).unwrap();
    external["session"]["revision"] = serde_json::json!(99);
    external["photos"][0]["rating"] = serde_json::json!(5);
    let bytes = serde_json::to_vec(&external).unwrap();
    std::fs::write(&target, &bytes).unwrap();
    assert_eq!(
        review
            .photo_mark(session.id, id, 2, PhotoFlag::Pick)
            .await
            .unwrap_err()
            .code,
        StorageErrorCode::Conflict
    );
    assert_eq!(std::fs::read(&target).unwrap(), bytes);
    assert_eq!(review.photo_catalog().await.unwrap().photos[0].rating, 0);
    let resumed = review
        .photo_open_directory_review(input.jpg.clone())
        .await
        .unwrap();
    assert_eq!(review.photo_catalog().await.unwrap().photos[0].rating, 5);
    std::fs::rename(
        dir.path().join("jpg/.filo"),
        dir.path().join("jpg/saved-progress"),
    )
    .unwrap();
    std::fs::write(dir.path().join("jpg/.filo"), b"occupied").unwrap();
    assert!(review
        .photo_mark(resumed.id, id, 1, PhotoFlag::Reject)
        .await
        .is_err());
    assert_eq!(review.photo_catalog().await.unwrap().photos[0].rating, 5);
    let readonly = service
        .add_selected_directory(dir.path().join("card"), true)
        .await
        .unwrap();
    let root = StorageLocator {
        volume_id: readonly.id,
        logical_path: String::new(),
        version_id: None,
    };
    assert_eq!(
        review
            .photo_open_directory_review(root)
            .await
            .unwrap_err()
            .code,
        StorageErrorCode::AccessDenied
    );
    assert!(!dir.path().join("card/.filo").exists());
}

#[tokio::test]
async fn directory_review_reconciles_new_photos_and_isolates_copied_folders() {
    let dir = tempfile::tempdir().unwrap();
    let (service, input) = setup(dir.path()).await;
    jpeg(&dir.path().join("jpg/one.jpg"));
    let review = service.photo_review_workspace();
    let first = review
        .photo_open_directory_review(input.jpg.clone())
        .await
        .unwrap();
    let id = first.photo_ids[0];
    review
        .photo_mark(first.id, id, 3, PhotoFlag::Pick)
        .await
        .unwrap();
    jpeg(&dir.path().join("jpg/new.jpg"));
    let reopened = review
        .photo_open_directory_review(input.jpg.clone())
        .await
        .unwrap();
    assert_eq!(reopened.id, first.id);
    assert_eq!(reopened.photo_ids.len(), 2);
    std::fs::copy(
        dir.path().join("jpg/one.jpg"),
        dir.path().join("raw/one.jpg"),
    )
    .unwrap();
    std::fs::create_dir_all(dir.path().join("raw/.filo")).unwrap();
    std::fs::copy(
        dir.path().join("jpg/.filo/review.json"),
        dir.path().join("raw/.filo/review.json"),
    )
    .unwrap();
    // Copies with preserved file metadata keep their marks but get independent IDs.
    let modified = std::fs::File::open(dir.path().join("jpg/one.jpg"))
        .unwrap()
        .metadata()
        .unwrap()
        .modified()
        .unwrap();
    std::fs::File::options()
        .write(true)
        .open(dir.path().join("raw/one.jpg"))
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    let copied = review.photo_open_directory_review(input.raw).await.unwrap();
    assert_ne!(copied.id, reopened.id);
    assert_eq!(copied.photo_ids.len(), 1);
    assert_ne!(copied.photo_ids[0], id);
    review
        .photo_mark(copied.id, copied.photo_ids[0], 1, PhotoFlag::Reject)
        .await
        .unwrap();
    let original = review.photo_open_directory_review(input.jpg).await.unwrap();
    assert_eq!(original.id, first.id);
    assert_eq!(
        review
            .photo_catalog()
            .await
            .unwrap()
            .photos
            .iter()
            .find(|p| p.id == id)
            .unwrap()
            .rating,
        3
    );
}
fn write_pair(path: &Path, folder: &str, name: &str, content: &[u8]) {
    let folder = path.join("card/DCIM").join(folder);
    std::fs::create_dir_all(&folder).unwrap();
    for ext in ["NEF", "JPG"] {
        let mut bytes = content.to_vec();
        bytes.extend_from_slice(ext.as_bytes());
        std::fs::write(folder.join(format!("{name}.{ext}")), bytes).unwrap();
    }
}

#[tokio::test]
async fn paired_copy_is_verified_and_reimport_reuses_identity_and_original_plan() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    let (service, mut input) = setup(path).await;
    write_pair(path, "107NZ5_2", "DSC_6166", b"one");
    let session = service.photo_plan(input.clone()).await.unwrap();
    let catalog = service.photo_catalog().await.unwrap();
    assert_eq!(catalog.photos.len(), 1);
    assert_eq!(catalog.photos[0].files.len(), 2);
    assert!(catalog.photos[0]
        .files
        .iter()
        .all(|f| f.path.starts_with("2026/2026-10-19/")));
    service
        .photo_import(session.id, Arc::new(|_| {}))
        .await
        .unwrap();
    let catalog = service.photo_catalog().await.unwrap();
    assert!(catalog.photos[0].files.iter().all(|f| f.verified));
    assert!(path.join("card/DCIM/107NZ5_2/DSC_6166.NEF").exists());
    input.layout = PhotoLayout::Batch;
    input.keep_hierarchy = true;
    let again = service.photo_plan(input).await.unwrap();
    assert_eq!(again.photo_ids, session.photo_ids);
    assert_eq!(service.photo_catalog().await.unwrap().photos.len(), 1);
    std::fs::remove_file(path.join("jpg/2026/2026-10-19/DSC_6166.JPG")).unwrap();
    service
        .photo_import(again.id, Arc::new(|_| {}))
        .await
        .unwrap();
    assert!(path.join("jpg/2026/2026-10-19/DSC_6166.JPG").exists());
}

#[tokio::test]
async fn group_collision_uses_one_suffix_and_retry_never_renumbers() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    let (service, input) = setup(path).await;
    write_pair(path, "a", "same", b"one");
    write_pair(path, "b", "same", b"two");
    std::fs::create_dir_all(path.join("raw/2026/2026-10-19")).unwrap();
    std::fs::write(path.join("raw/2026/2026-10-19/same.xmp"), b"external").unwrap();
    let session = service.photo_plan(input).await.unwrap();
    let planned = service.photo_catalog().await.unwrap();
    assert!(planned.photos[0]
        .files
        .iter()
        .all(|f| f.path.contains("same_2.")));
    assert!(planned.photos[1]
        .files
        .iter()
        .all(|f| f.path.contains("same_3.")));
    // Simulate a process ending after target publication but before journal update.
    std::fs::write(
        path.join("raw").join(
            &planned.photos[0]
                .files
                .iter()
                .find(|f| f.kind == PhotoFileKind::Raw)
                .unwrap()
                .path,
        ),
        b"oneNEF",
    )
    .unwrap();
    service
        .photo_import(session.id, Arc::new(|_| {}))
        .await
        .unwrap();
    service
        .photo_import(session.id, Arc::new(|_| {}))
        .await
        .unwrap();
    let after = service.photo_catalog().await.unwrap();
    assert!(after
        .photos
        .iter()
        .flat_map(|p| &p.files)
        .all(|f| f.verified));
    assert_eq!(
        after.photos[0].files[0].path,
        planned.photos[0].files[0].path
    );
    assert_eq!(
        std::fs::read(path.join("raw/2026/2026-10-19/same.xmp")).unwrap(),
        b"external"
    );
}

#[tokio::test]
async fn changed_source_and_missing_dates_never_produce_false_success() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    let (service, mut input) = setup(path).await;
    write_pair(path, "a", "photo", b"one");
    input.date_override = None;
    let session = service.photo_plan(input).await.unwrap();
    assert!(service
        .photo_import(session.id, Arc::new(|_| {}))
        .await
        .is_err());
    std::fs::create_dir_all(path.join("raw/2026/2026-10-20")).unwrap();
    std::fs::write(
        path.join("raw/2026/2026-10-20/photo.xmp"),
        b"unrelated adjustments",
    )
    .unwrap();
    assert!(service
        .photo_resolve_date(session.id, "2026-10-20".into())
        .await
        .is_err());
    std::fs::remove_file(path.join("raw/2026/2026-10-20/photo.xmp")).unwrap();
    service
        .photo_resolve_date(session.id, "2026-10-20".into())
        .await
        .unwrap();
    std::fs::write(path.join("card/DCIM/a/photo.NEF"), b"changed").unwrap();
    service
        .photo_import(session.id, Arc::new(|_| {}))
        .await
        .unwrap();
    let catalog = service.photo_catalog().await.unwrap();
    let photo = &catalog.photos[0];
    assert!(
        !photo
            .files
            .iter()
            .find(|f| f.kind == PhotoFileKind::Raw)
            .unwrap()
            .verified
    );
    assert!(
        photo
            .files
            .iter()
            .find(|f| f.kind == PhotoFileKind::Jpg)
            .unwrap()
            .verified
    );
    assert!(!path.join("raw/2026/2026-10-20/photo.NEF").exists());
}
