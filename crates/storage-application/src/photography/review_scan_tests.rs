use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use storage_provider_api::StagedWrite;

struct ProbeBackend {
    inner: OpenDalLocalBackend,
    primary_reads: AtomicUsize,
    block_listing: AtomicBool,
    listing_started: tokio::sync::Notify,
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
        self.inner.open_read(path).await
    }
    async fn read_range(
        &self,
        entry: &StorageEntry,
        range: std::ops::Range<u64>,
    ) -> StorageResult<Vec<u8>> {
        if !entry.name.ends_with(".json") {
            self.primary_reads.fetch_add(1, Ordering::SeqCst);
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
        block_listing: AtomicBool::new(false),
        listing_started: tokio::sync::Notify::new(),
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
    }
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
        .photo_preview(session.photo_ids[0], false, false)
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
    assert!(catalog.photos.iter().all(|p| p.files.len() == 1));
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
