use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use storage_provider_api::StagedWrite;

struct ProbeBackend {
    inner: OpenDalLocalBackend,
    primary_reads: AtomicUsize,
    full_reads: AtomicUsize,
    stats: AtomicUsize,
    root_stats: AtomicUsize,
    block_listing: AtomicBool,
    listing_started: tokio::sync::Notify,
    block_primary: AtomicBool,
    primary_started: tokio::sync::Notify,
    primary_resume: tokio::sync::Notify,
}

#[tokio::test(start_paused = true)]
async fn stalled_reads_time_out_without_waiting_for_the_whole_scan() {
    let scan = ReviewScan {
        token: CancellationToken::new(),
        observer: Arc::new(|_| {}),
    };
    let started = tokio::time::Instant::now();
    let error = scan
        .read(std::future::pending::<StorageResult<()>>())
        .await
        .unwrap_err();
    assert_eq!(error.code, StorageErrorCode::Io);
    assert!(error.message.contains("超时"));
    assert_eq!(started.elapsed(), Duration::from_secs(30));
}

#[async_trait::async_trait]
impl StorageBackend for ProbeBackend {
    fn is_remote(&self) -> bool {
        true
    }
    fn volume_id(&self) -> Uuid {
        self.inner.volume_id()
    }
    fn capabilities(&self) -> StorageCapabilities {
        self.inner.capabilities()
    }
    async fn list(&self, parent: &StorageLocator) -> StorageResult<Vec<StorageEntry>> {
        if self.block_listing.load(Ordering::SeqCst) {
            self.listing_started.notify_one();
            return std::future::pending().await;
        }
        self.inner.list(parent).await
    }
    async fn stat(&self, path: &StorageLocator) -> StorageResult<StorageEntry> {
        self.stats.fetch_add(1, Ordering::SeqCst);
        if path.logical_path.is_empty() {
            self.root_stats.fetch_add(1, Ordering::SeqCst);
        }
        self.inner.stat(path).await
    }
    async fn create_dir(&self, path: &StorageLocator) -> StorageResult<()> {
        self.inner.create_dir(path).await
    }
    async fn rename(&self, from: &StorageLocator, to: &StorageLocator) -> StorageResult<()> {
        self.inner.rename(from, to).await
    }
    async fn delete(&self, path: &StorageLocator) -> StorageResult<()> {
        self.inner.delete(path).await
    }
    async fn open_read(&self, path: &StorageLocator) -> StorageResult<StorageReader> {
        if !path.logical_path.ends_with(".json") {
            self.full_reads.fetch_add(1, Ordering::SeqCst);
        }
        self.inner.open_read(path).await
    }
    async fn read_range(
        &self,
        entry: &StorageEntry,
        range: std::ops::Range<u64>,
    ) -> StorageResult<Vec<u8>> {
        if !entry.name.ends_with(".json") {
            self.primary_reads.fetch_add(1, Ordering::SeqCst);
            if self.block_primary.load(Ordering::SeqCst) {
                self.primary_started.notify_one();
                self.primary_resume.notified().await;
            }
        }
        self.inner.read_range(entry, range).await
    }
    async fn stage_write(&self, path: &StorageLocator) -> StorageResult<Box<dyn StagedWrite>> {
        self.inner.stage_write(path).await
    }
    async fn stage_replace(&self, entry: &StorageEntry) -> StorageResult<Box<dyn StagedWrite>> {
        self.inner.stage_replace(entry).await
    }
}

async fn setup(path: &std::path::Path) -> (StorageService, StorageLocator, Arc<ProbeBackend>) {
    std::fs::create_dir(path.join("photos")).unwrap();
    let service = StorageService::new(Repository::open(&path.join("db.sqlite")).await.unwrap());
    let volume = service
        .add_selected_directory(path.join("photos"), false)
        .await
        .unwrap();
    let probe = Arc::new(ProbeBackend {
        inner: OpenDalLocalBackend::new(&volume).await.unwrap(),
        primary_reads: AtomicUsize::new(0),
        full_reads: AtomicUsize::new(0),
        stats: AtomicUsize::new(0),
        root_stats: AtomicUsize::new(0),
        block_listing: AtomicBool::new(false),
        listing_started: tokio::sync::Notify::new(),
        block_primary: AtomicBool::new(false),
        primary_started: tokio::sync::Notify::new(),
        primary_resume: tokio::sync::Notify::new(),
    });
    service
        .temporary_backends
        .lock()
        .await
        .insert(volume.id, probe.clone());
    (
        service.photo_review_workspace(),
        StorageLocator {
            volume_id: volume.id,
            logical_path: String::new(),
            version_id: None,
        },
        probe,
    )
}

fn input(root: StorageLocator) -> PhotoReviewInput {
    PhotoReviewInput {
        name: String::new(),
        jpg: root,
        raw: None,
        directory: true,
        raw_only: None,
    }
}

#[tokio::test]
async fn remote_thumbnails_do_not_read_sources_but_explicit_previews_still_work() {
    let dir = tempfile::tempdir().unwrap();
    let (service, root, probe) = setup(dir.path()).await;
    image::RgbImage::new(32, 16)
        .save(dir.path().join("photos/image.JPG"))
        .unwrap();
    std::fs::write(
        dir.path().join("photos/raw.NEF"),
        crate::browsing::nef::fixture(true, false),
    )
    .unwrap();
    let session = service
        .photo_open_directory_review(root.clone())
        .await
        .unwrap();
    let before = (
        probe.stats.load(Ordering::SeqCst),
        probe.full_reads.load(Ordering::SeqCst),
        probe.primary_reads.load(Ordering::SeqCst),
    );
    for name in ["image.JPG", "raw.NEF"] {
        let locator = StorageLocator {
            logical_path: name.into(),
            ..root.clone()
        };
        let error = service.preview_entry(locator, true).await.err().unwrap();
        assert_eq!(error.code, StorageErrorCode::Unsupported);
    }
    for &id in &session.photo_ids {
        let error = service
            .photo_preview(id, false, true, false)
            .await
            .unwrap_err();
        assert_eq!(error.code, StorageErrorCode::Unsupported);
    }
    assert_eq!(
        (
            probe.stats.load(Ordering::SeqCst),
            probe.full_reads.load(Ordering::SeqCst),
            probe.primary_reads.load(Ordering::SeqCst),
        ),
        before,
        "thumbnail requests must not stat, download, or range-read remote files"
    );
    for name in ["image.JPG", "raw.NEF"] {
        let locator = StorageLocator {
            logical_path: name.into(),
            ..root.clone()
        };
        let preview = service.preview_entry(locator, false).await.unwrap();
        assert_eq!(preview.kind, "image");
    }
    for &id in &session.photo_ids {
        let preview = service
            .photo_preview(id, false, false, false)
            .await
            .unwrap();
        assert_eq!(preview.mime, "image/jpeg");
    }
    assert!(probe.full_reads.load(Ordering::SeqCst) > before.1);
    assert!(probe.primary_reads.load(Ordering::SeqCst) > before.2);
}

#[tokio::test]
async fn raw_only_scan_reads_no_photo_contents_and_previews_are_lazy() {
    let dir = tempfile::tempdir().unwrap();
    let (service, root, probe) = setup(dir.path()).await;
    let bytes = crate::browsing::nef::fixture(true, false);
    for i in 0..241 {
        std::fs::write(dir.path().join(format!("photos/{i:04}.NEF")), &bytes).unwrap();
    }
    std::fs::create_dir_all(dir.path().join("photos/.filo/cache")).unwrap();
    std::fs::write(dir.path().join("photos/.filo/cache/hidden.NEF"), &bytes).unwrap();
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let observer = events.clone();
    let session = service
        .photo_scan_review(
            Uuid::new_v4(),
            input(root.clone()),
            Arc::new(move |p| observer.lock().unwrap().push(p)),
        )
        .await
        .unwrap();
    assert_eq!(session.photo_ids.len(), 241);
    assert_eq!(
        probe.root_stats.load(Ordering::SeqCst),
        0,
        "the provider listing validates the directory without a duplicate remote stat"
    );
    assert_eq!(
        probe.primary_reads.load(Ordering::SeqCst),
        0,
        "opening must never pre-read standalone RAW files"
    );
    {
        let events = events.lock().unwrap();
        assert!(events
            .iter()
            .any(|p| p.stage == PhotoReviewStage::Listing && p.found == 241));
        assert_eq!(events.last().unwrap().stage, PhotoReviewStage::Saving);
    }
    service
        .photo_mark(session.id, session.photo_ids[240], 4, PhotoFlag::Pick)
        .await
        .unwrap();
    let reopened = service.photo_open_directory_review(root).await.unwrap();
    assert_eq!(reopened.photo_ids, session.photo_ids);
    assert_eq!(probe.primary_reads.load(Ordering::SeqCst), 0);
    let preview = service
        .photo_preview(session.photo_ids[0], false, false, false)
        .await
        .unwrap();
    assert_eq!(preview.mime, "image/jpeg");
    assert!(probe.primary_reads.load(Ordering::SeqCst) > 0);
    assert!(dir.path().join("photos/.filo/review.json").is_file());
}

fn tiff(date: &str) -> Vec<u8> {
    let mut bytes = vec![0; 96];
    bytes[..8].copy_from_slice(b"II\x2a\0\x08\0\0\0");
    bytes[8..10].copy_from_slice(&1u16.to_le_bytes());
    bytes[10..12].copy_from_slice(&0x9003u16.to_le_bytes());
    bytes[12..14].copy_from_slice(&2u16.to_le_bytes());
    bytes[14..18].copy_from_slice(&20u32.to_le_bytes());
    bytes[18..22].copy_from_slice(&32u32.to_le_bytes());
    bytes[32..52].copy_from_slice(format!("{date} 12:00:00\0").as_bytes());
    bytes
}

#[tokio::test]
async fn capture_times_load_only_on_demand_and_cache_missing_dates_until_files_change() {
    let dir = tempfile::tempdir().unwrap();
    let (service, root, probe) = setup(dir.path()).await;
    let mut late = tiff("2026:10:19");
    late[43..51].copy_from_slice(b"23:59:00");
    std::fs::write(dir.path().join("photos/late.NEF"), &late).unwrap();
    std::fs::write(dir.path().join("photos/early.NEF"), tiff("2026:10:19")).unwrap();
    std::fs::write(dir.path().join("photos/missing.NEF"), [0; 96]).unwrap();
    let session = service
        .photo_open_directory_review(root.clone())
        .await
        .unwrap();
    assert_eq!(probe.primary_reads.load(Ordering::SeqCst), 0);
    let load = || service.photo_load_capture_times(Uuid::new_v4(), session.id, Arc::new(|_| {}));
    let times = load().await.unwrap();
    assert_eq!(probe.primary_reads.load(Ordering::SeqCst), 3);
    let catalog = service.photo_catalog().await.unwrap();
    for photo in &catalog.photos {
        assert!(photo.capture_time_loaded);
        let time = &times
            .iter()
            .find(|t| t.id == photo.id)
            .unwrap()
            .capture_time;
        assert_eq!(time, &photo.capture_time);
        match photo.original_path.as_str() {
            "late.NEF" => assert_eq!(time.as_deref(), Some("2026:10:19 23:59:00")),
            "early.NEF" => assert_eq!(time.as_deref(), Some("2026:10:19 12:00:00")),
            "missing.NEF" => assert!(time.is_none()),
            _ => unreachable!(),
        }
    }
    load().await.unwrap();
    service
        .photo_open_directory_review(root.clone())
        .await
        .unwrap();
    load().await.unwrap();
    assert_eq!(probe.primary_reads.load(Ordering::SeqCst), 3);
    service
        .photo_save_position(
            session.id,
            PhotoReviewPosition {
                current: Some(session.photo_ids[0]),
                sort: PhotoSort::CaptureDesc,
                filter: "none".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let progress: serde_json::Value = serde_json::from_slice(
        &std::fs::read(dir.path().join("photos/.filo/review.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(progress.as_object().unwrap().len(), 2);
    assert_eq!(progress["sort"], "capture_desc");
    let reopened = service
        .photo_open_directory_review(root.clone())
        .await
        .unwrap();
    assert!(matches!(reopened.position.sort, PhotoSort::CaptureDesc));
    assert_eq!(reopened.position.filter, "none");
    let mut changed = tiff("2026:10:20");
    changed.push(0); // Changes the cached file revision even on coarse clocks.
    std::fs::write(dir.path().join("photos/late.NEF"), changed).unwrap();
    service.photo_open_directory_review(root).await.unwrap();
    load().await.unwrap();
    assert_eq!(probe.primary_reads.load(Ordering::SeqCst), 4);
    let catalog = service.photo_catalog().await.unwrap();
    assert_eq!(
        catalog
            .photos
            .iter()
            .find(|p| p.original_path == "late.NEF")
            .unwrap()
            .capture_time
            .as_deref(),
        Some("2026:10:20 12:00:00")
    );
    assert!(!dir.path().join("photos/late.xmp").exists());
}

#[tokio::test]
async fn capture_time_loading_merges_concurrent_marks_and_can_be_cancelled() {
    let dir = tempfile::tempdir().unwrap();
    let (service, root, probe) = setup(dir.path()).await;
    std::fs::write(dir.path().join("photos/a.NEF"), tiff("2026:10:19")).unwrap();
    let session = service.photo_open_directory_review(root).await.unwrap();
    probe.block_primary.store(true, Ordering::SeqCst);
    let worker = service.clone();
    let request = Uuid::new_v4();
    let session_id = session.id;
    let loading = tokio::spawn(async move {
        worker
            .photo_load_capture_times(request, session_id, Arc::new(|_| {}))
            .await
    });
    probe.primary_started.notified().await;
    // Slow header I/O must not block marking the current photo.
    tokio::time::timeout(
        Duration::from_secs(2),
        service.photo_mark(session.id, session.photo_ids[0], 4, PhotoFlag::Pick),
    )
    .await
    .unwrap()
    .unwrap();
    probe.primary_resume.notify_one();
    loading.await.unwrap().unwrap();
    let catalog = service.photo_catalog().await.unwrap();
    assert_eq!(catalog.photos[0].rating, 4);
    assert_eq!(catalog.photos[0].flag, PhotoFlag::Pick);
    assert!(catalog.photos[0].capture_time_loaded);
    assert_eq!(catalog.sessions[0].undo.len(), 1);
    // Reset only the metadata cache to exercise cancellation of a blocked read.
    let _guard = service.photo_lock.lock().await;
    let (revision, mut catalog) = service.load_photos().await.unwrap();
    catalog.photos[0].capture_time_loaded = false;
    service.save_photos(revision, &catalog).await.unwrap();
    drop(_guard);
    let worker = service.clone();
    let request = Uuid::new_v4();
    let loading = tokio::spawn(async move {
        worker
            .photo_load_capture_times(request, session_id, Arc::new(|_| {}))
            .await
    });
    probe.primary_started.notified().await;
    service.photo_cancel_review_scan(request).await.unwrap();
    let error = loading.await.unwrap().unwrap_err();
    assert_eq!(error.code, StorageErrorCode::Cancelled);
    assert!(!service.photo_catalog().await.unwrap().photos[0].capture_time_loaded);
    assert!(!service
        .photo_review_scans
        .lock()
        .await
        .contains_key(&request));
}

#[tokio::test]
async fn unchanged_pairs_reuse_validation_including_conflicts() {
    let dir = tempfile::tempdir().unwrap();
    let (service, root, probe) = setup(dir.path()).await;
    for (name, date) in [
        ("same.NEF", "2026:10:18"),
        ("same.JPG", "2026:10:18"),
        ("split.NEF", "2026:10:18"),
        ("split.JPG", "2026:10:19"),
    ] {
        std::fs::write(dir.path().join("photos").join(name), tiff(date)).unwrap();
    }
    let first = service
        .photo_open_directory_review(root.clone())
        .await
        .unwrap();
    assert_eq!(
        first.photo_ids.len(),
        3,
        "conflicting dates must remain separate"
    );
    assert_eq!(probe.primary_reads.load(Ordering::SeqCst), 4);
    let catalog = service.photo_catalog().await.unwrap();
    for photo in &catalog.photos {
        assert!(photo.capture_time_loaded);
        assert_eq!(
            photo.capture_time.as_deref(),
            Some(if photo.original_path == "split.JPG" {
                "2026:10:19 12:00:00"
            } else {
                "2026:10:18 12:00:00"
            })
        );
    }
    service
        .photo_load_capture_times(Uuid::new_v4(), first.id, Arc::new(|_| {}))
        .await
        .unwrap();
    assert_eq!(probe.primary_reads.load(Ordering::SeqCst), 4);
    let paired = catalog
        .photos
        .iter()
        .find(|p| p.files.len() == 2)
        .unwrap()
        .id;
    service
        .photo_mark(first.id, paired, 5, PhotoFlag::Pick)
        .await
        .unwrap();
    let reopened = service
        .photo_open_directory_review(root.clone())
        .await
        .unwrap();
    assert_eq!(reopened.photo_ids, first.photo_ids);
    assert_eq!(
        probe.primary_reads.load(Ordering::SeqCst),
        4,
        "reopening unchanged pairs must not reread EXIF"
    );
    let catalog = service.photo_catalog().await.unwrap();
    assert_eq!(
        catalog
            .photos
            .iter()
            .find(|p| p.id == paired)
            .unwrap()
            .rating,
        5
    );
    // A changed member must invalidate the cached grouping.
    let mut changed = tiff("2026:10:20");
    changed.push(0);
    std::fs::write(dir.path().join("photos/same.JPG"), changed).unwrap();
    let changed = service.photo_open_directory_review(root).await.unwrap();
    assert_eq!(changed.photo_ids.len(), 4);
    assert_eq!(probe.primary_reads.load(Ordering::SeqCst), 6);
    let catalog = service.photo_catalog().await.unwrap();
    assert!(catalog
        .photos
        .iter()
        .all(|p| p.files.iter().filter(|f| f.kind.primary()).count() == 1));
}

#[tokio::test]
async fn cancelling_a_stalled_listing_releases_scan_without_publishing() {
    let dir = tempfile::tempdir().unwrap();
    let (service, root, probe) = setup(dir.path()).await;
    std::fs::write(dir.path().join("photos/one.NEF"), b"RAW").unwrap();
    probe.block_listing.store(true, Ordering::SeqCst);
    let request = Uuid::new_v4();
    let worker = service.clone();
    let locator = root.clone();
    let scan = tokio::spawn(async move {
        worker
            .photo_scan_review(request, input(locator), Arc::new(|_| {}))
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), probe.listing_started.notified())
        .await
        .unwrap();
    service.photo_cancel_review_scan(request).await.unwrap();
    let error = tokio::time::timeout(Duration::from_secs(2), scan)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error.code, StorageErrorCode::Cancelled);
    assert!(service.photo_catalog().await.unwrap().sessions.is_empty());
    assert!(!dir.path().join("photos/.filo").exists());
    assert!(service.photo_review_scans.lock().await.is_empty());
    assert!(!service.photo_has_active_imports().await);
    probe.block_listing.store(false, Ordering::SeqCst);
    assert_eq!(
        service
            .photo_open_directory_review(root)
            .await
            .unwrap()
            .photo_ids
            .len(),
        1
    );
}

#[tokio::test]
async fn raw_view_uses_raw_preview_and_persists_without_changing_photo_identity() {
    let dir = tempfile::tempdir().unwrap();
    let (service, root, _) = setup(dir.path()).await;
    for name in ["pair.NEF", "raw.NEF"] {
        std::fs::write(
            dir.path().join("photos").join(name),
            crate::browsing::nef::fixture(true, false),
        )
        .unwrap();
    }
    for name in ["pair.JPG", "jpg.JPG"] {
        image::RgbImage::new(32, 16)
            .save(dir.path().join("photos").join(name))
            .unwrap();
    }
    let mut request = input(root.clone());
    request.raw_only = Some(true);
    let session = service
        .photo_scan_review(Uuid::new_v4(), request, Arc::new(|_| {}))
        .await
        .unwrap();
    assert!(session.position.raw_only);
    assert_eq!(
        session.photo_ids.len(),
        3,
        "view options must not remove photos from the shared journal"
    );
    let catalog = service.photo_catalog().await.unwrap();
    let paired = catalog
        .photos
        .iter()
        .find(|p| p.files.len() == 2)
        .unwrap()
        .id;
    let jpg_only = catalog
        .photos
        .iter()
        .find(|p| p.original_path == "jpg.JPG")
        .unwrap()
        .id;
    let jpg = service
        .photo_preview(paired, true, false, false)
        .await
        .unwrap();
    let raw = service
        .photo_preview(paired, true, false, true)
        .await
        .unwrap();
    assert!(!jpg.embedded);
    assert!(raw.embedded);
    assert_eq!((jpg.width, jpg.height), (32, 16));
    assert_eq!((raw.width, raw.height), (200, 400));
    assert!(service
        .photo_preview(jpg_only, false, false, true)
        .await
        .is_err());
    service
        .photo_mark(session.id, paired, 4, PhotoFlag::Pick)
        .await
        .unwrap();
    let restored = service
        .photo_open_directory_review(root.clone())
        .await
        .unwrap();
    assert!(restored.position.raw_only);
    assert_eq!(restored.photo_ids, session.photo_ids);
    let mut request = input(root);
    request.raw_only = Some(false);
    let all = service
        .photo_scan_review(Uuid::new_v4(), request, Arc::new(|_| {}))
        .await
        .unwrap();
    assert!(!all.position.raw_only);
    assert_eq!(all.photo_ids, session.photo_ids);
    let catalog = service.photo_catalog().await.unwrap();
    assert_eq!(
        catalog
            .photos
            .iter()
            .find(|p| p.id == paired)
            .unwrap()
            .rating,
        4
    );
    let manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(dir.path().join("photos/.filo/review.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(manifest.as_object().unwrap().len(), 2);
    assert_eq!(manifest["sort"], "name_asc");
    let position = serde_json::json!({});
    assert!(
        !serde_json::from_value::<PhotoReviewPosition>(position)
            .unwrap()
            .raw_only
    );
    let paired_photo = catalog.photos.iter().find(|p| p.id == paired).unwrap();
    let alias = paired_photo
        .files
        .iter()
        .find(|f| f.kind.primary() && f.path != paired_photo.original_path)
        .unwrap();
    let mut progress = manifest;
    progress["current"] = serde_json::json!(alias.path);
    std::fs::write(
        dir.path().join("photos/.filo/review.json"),
        serde_json::to_vec(&progress).unwrap(),
    )
    .unwrap();
    let resumed = service
        .photo_open_directory_review(all.directory.unwrap())
        .await
        .unwrap();
    assert_eq!(
        resumed.position.current,
        Some(paired),
        "either member of a RAW/JPG pair restores the same photo"
    );
}
