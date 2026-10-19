use super::*;
use std::path::Path;

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
