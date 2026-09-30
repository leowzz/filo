use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use storage_provider_api::{StagedWrite, StorageReader};
use storage_repository::Repository;

struct SyntheticBackend {
    id: Uuid,
    count: usize,
    calls: Arc<AtomicUsize>,
    fail_next: Arc<AtomicBool>,
    duplicate: bool,
}
struct SyntheticReader {
    id: Uuid,
    count: usize,
    offset: usize,
    calls: Arc<AtomicUsize>,
    fail_next: Arc<AtomicBool>,
    duplicate: bool,
}
#[async_trait::async_trait]
impl DirectoryReader for SyntheticReader {
    async fn next_batch(&mut self, limit: usize) -> StorageResult<Vec<StorageEntry>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.fail_next.swap(false, Ordering::SeqCst) {
            return Err(StorageError::new(
                StorageErrorCode::Network,
                "test network failure",
            ));
        }
        let end = (self.offset + limit).min(self.count);
        let entries = (self.offset..end)
            .map(|i| {
                let name = if self.duplicate {
                    "same".into()
                } else {
                    format!("file-{i:05}")
                };
                StorageEntry {
                    locator: StorageLocator {
                        volume_id: self.id,
                        logical_path: name.clone(),
                        version_id: None,
                    },
                    name,
                    kind: StorageEntryKind::File,
                    size: Some(i as u64),
                    modified_at: None,
                    etag: None,
                    content_type: None,
                    metadata: serde_json::json!({}),
                }
            })
            .collect();
        self.offset = end;
        Ok(entries)
    }
    fn is_exhausted(&self) -> bool {
        self.offset == self.count
    }
}
#[async_trait::async_trait]
impl StorageBackend for SyntheticBackend {
    fn volume_id(&self) -> Uuid {
        self.id
    }
    fn capabilities(&self) -> StorageCapabilities {
        StorageCapabilities::s3(false)
    }
    fn storage_path(&self, locator: &StorageLocator) -> Option<(String, String)> {
        Some((self.id.to_string(), locator.logical_path.clone()))
    }
    async fn open_listing(&self, _: &StorageLocator) -> StorageResult<Box<dyn DirectoryReader>> {
        Ok(Box::new(SyntheticReader {
            id: self.id,
            count: self.count,
            offset: 0,
            calls: self.calls.clone(),
            fail_next: self.fail_next.clone(),
            duplicate: self.duplicate,
        }))
    }
    async fn list(&self, _: &StorageLocator) -> StorageResult<Vec<StorageEntry>> {
        unreachable!("must use bounded reader")
    }
    async fn stat(&self, _: &StorageLocator) -> StorageResult<StorageEntry> {
        unreachable!()
    }
    async fn create_dir(&self, _: &StorageLocator) -> StorageResult<()> {
        unreachable!()
    }
    async fn rename(&self, _: &StorageLocator, _: &StorageLocator) -> StorageResult<()> {
        unreachable!()
    }
    async fn delete(&self, _: &StorageLocator) -> StorageResult<()> {
        unreachable!()
    }
    async fn open_read(&self, _: &StorageLocator) -> StorageResult<StorageReader> {
        unreachable!()
    }
    async fn stage_write(&self, _: &StorageLocator) -> StorageResult<Box<dyn StagedWrite>> {
        unreachable!()
    }
}

async fn fixture(
    count: usize,
    duplicate: bool,
) -> (
    StorageService,
    StorageLocator,
    Arc<SyntheticBackend>,
    tempfile::TempDir,
) {
    let database = tempfile::tempdir().unwrap();
    let service = StorageService::new(
        Repository::open(&database.path().join("test.sqlite"))
            .await
            .unwrap(),
    );
    let id = Uuid::new_v4();
    let backend = Arc::new(SyntheticBackend {
        id,
        count,
        duplicate,
        calls: Arc::new(AtomicUsize::new(0)),
        fail_next: Arc::new(AtomicBool::new(false)),
    });
    service
        .temporary_backends
        .lock()
        .await
        .insert(id, backend.clone());
    (
        service,
        StorageLocator {
            volume_id: id,
            logical_path: String::new(),
            version_id: None,
        },
        backend,
        database,
    )
}
fn options() -> ListOptions {
    ListOptions {
        sort: EntrySort::Provider,
        ..ListOptions::default()
    }
}

#[tokio::test]
async fn fifty_thousand_items_read_only_one_batch_for_first_page_and_retry_safely() {
    let (service, parent, backend, _database) = fixture(50_000, false).await;
    let first = service
        .list_entries_page(parent.clone(), options(), None, 200)
        .await
        .unwrap();
    assert_eq!(first.entries.len(), 200);
    assert_eq!(first.total, 200);
    assert!(!first.total_is_exact);
    assert_eq!(
        backend.calls.load(Ordering::SeqCst),
        1,
        "first page must not scan 50,000 items"
    );
    let cursor = first.next_cursor.clone();
    backend.fail_next.store(true, Ordering::SeqCst);
    assert!(service
        .list_entries_page(parent.clone(), options(), cursor.clone(), 200)
        .await
        .is_err());
    let second = service
        .list_entries_page(parent.clone(), options(), cursor.clone(), 200)
        .await
        .unwrap();
    assert_eq!(second.entries[0].name, "file-00200");
    assert_eq!(second.total, 400);
    let replay = service
        .list_entries_page(parent.clone(), options(), cursor.clone(), 200)
        .await
        .unwrap();
    assert_eq!(replay.entries[0].name, second.entries[0].name);
    assert_eq!(
        backend.calls.load(Ordering::SeqCst),
        3,
        "replaying a page must not request more data"
    );
    assert!(service
        .list_entries_page(parent.clone(), options(), cursor.clone(), 100)
        .await
        .is_err());
    assert!(service
        .list_entries_page(
            StorageLocator {
                logical_path: "other".into(),
                ..parent.clone()
            },
            options(),
            cursor.clone(),
            200
        )
        .await
        .is_err());
    assert!(service
        .list_entries_page(
            parent.clone(),
            ListOptions {
                show_hidden: true,
                ..options()
            },
            cursor.clone(),
            200
        )
        .await
        .is_err());
    assert!(service
        .list_entries_page(
            parent.clone(),
            ListOptions {
                sort: EntrySort::Name,
                ..options()
            },
            cursor.clone(),
            200
        )
        .await
        .is_err());
    let mut page = second;
    let started = Instant::now();
    while page.next_cursor.is_some() {
        page = service
            .list_entries_page(parent.clone(), options(), page.next_cursor, 200)
            .await
            .unwrap();
        assert!(page.entries.len() <= 200);
    }
    assert_eq!(page.total, 50_000);
    assert!(page.total_is_exact);
    assert_eq!(page.entries.last().unwrap().name, "file-49999");
    assert_eq!(backend.calls.load(Ordering::SeqCst), 251);
    eprintln!(
        "50,000-item paging finished in {:?}; first page used one batch",
        started.elapsed()
    );
    let replay = service
        .list_entries_page(parent.clone(), options(), cursor.clone(), 200)
        .await
        .unwrap();
    assert_eq!(
        replay.total, 400,
        "cached pages remain stable after later reads"
    );
    service
        .temporary_backends
        .lock()
        .await
        .remove(&parent.volume_id);
    assert!(service
        .list_entries_page(parent, options(), cursor, 200)
        .await
        .is_err());
}

#[tokio::test]
async fn empty_filtered_pages_keep_a_cursor_and_duplicate_failures_are_repeatable() {
    let (service, parent, backend, _database) = fixture(450, false).await;
    let folder_options = ListOptions {
        folders_only: true,
        ..options()
    };
    let first = service
        .list_entries_page(parent.clone(), folder_options.clone(), None, 200)
        .await
        .unwrap();
    assert!(first.entries.is_empty());
    assert!(!first.total_is_exact);
    assert!(first.next_cursor.is_some());
    assert_eq!(backend.calls.load(Ordering::SeqCst), 1);
    let second = service
        .list_entries_page(
            parent.clone(),
            folder_options.clone(),
            first.next_cursor,
            200,
        )
        .await
        .unwrap();
    let last = service
        .list_entries_page(parent, folder_options, second.next_cursor, 200)
        .await
        .unwrap();
    assert!(last.total_is_exact);
    assert_eq!(last.total, 0);
    assert!(last.next_cursor.is_none());
    let (service, parent, backend, _database) = fixture(2, true).await;
    let first = service
        .list_entries_page(parent.clone(), options(), None, 1)
        .await
        .unwrap();
    for _ in 0..2 {
        let error = service
            .list_entries_page(parent.clone(), options(), first.next_cursor.clone(), 1)
            .await
            .unwrap_err();
        assert_eq!(error.code, StorageErrorCode::Conflict);
    }
    assert_eq!(
        backend.calls.load(Ordering::SeqCst),
        2,
        "failed commits keep the pending batch for retries"
    );
}

#[tokio::test]
async fn streaming_search_still_filters_the_entire_directory() {
    let (service, parent, backend, _database) = fixture(10_000, false).await;
    let query = ListOptions {
        search: "09999".into(),
        ..options()
    };
    let result = service
        .list_entries_page(parent, query, None, 200)
        .await
        .unwrap();
    assert_eq!(result.entries[0].name, "file-09999");
    assert_eq!(result.total, 1);
    assert!(result.total_is_exact);
    assert_eq!(backend.calls.load(Ordering::SeqCst), 21);
}
