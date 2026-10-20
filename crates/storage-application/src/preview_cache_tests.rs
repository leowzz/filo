use super::*;

fn id(name: &str) -> String {
    format!("{:x}", Sha256::digest(name.as_bytes()))
}

async fn open(dir: &tempfile::TempDir) -> PreviewCache {
    PreviewCache::open(
        dir.path().join("application-cache/previews"),
        dir.path().join("config/preview-cache.json"),
    )
    .await
    .unwrap()
}

fn age(cache: &PreviewCache, name: &str, seconds: u64) {
    let mut cache = cache.0.lock().unwrap();
    let key = id(name);
    let time = SystemTime::now() - Duration::from_secs(seconds);
    fs::File::open(cache.root.join(format!("{key}.cache")))
        .unwrap()
        .set_modified(time)
        .unwrap();
    cache.entries.get_mut(&key).unwrap().accessed = time;
}

#[tokio::test]
async fn defaults_and_lru_survive_restart_and_use_a_separate_directory() {
    let dir = tempfile::tempdir().unwrap();
    let cache = open(&dir).await;
    assert_eq!(
        cache.info().await.unwrap().settings,
        PreviewCacheSettings {
            max_bytes: 1024 * 1024 * 1024,
            max_age_days: 30
        }
    );
    cache
        .configure(PreviewCacheSettings {
            max_bytes: 12,
            max_age_days: 30,
        })
        .await
        .unwrap();
    cache.put(id("a"), "aaaa").await;
    cache.put(id("b"), "bbbb").await;
    age(&cache, "a", 20);
    age(&cache, "b", 10);
    assert_eq!(cache.get::<String>(&id("a")).await.as_deref(), Some("aaaa"));
    drop(cache);
    let cache = open(&dir).await;
    cache.put(id("c"), "cccc").await;
    assert!(
        cache.get::<String>(&id("b")).await.is_none(),
        "recent access must keep a ahead of b after restart"
    );
    assert_eq!(cache.get::<String>(&id("a")).await.as_deref(), Some("aaaa"));
    assert_eq!(cache.get::<String>(&id("c")).await.as_deref(), Some("cccc"));
    let info = cache.info().await.unwrap();
    assert_eq!(info.used_bytes, 12);
    assert!(info.directory.ends_with("application-cache/previews"));
    assert!(!dir.path().join("photos/.filo").exists());
}

#[tokio::test]
async fn expiry_is_based_on_last_access_and_settings_apply_immediately() {
    let dir = tempfile::tempdir().unwrap();
    let cache = open(&dir).await;
    for name in ["expired", "old", "recent"] {
        cache.put(id(name), "data").await;
    }
    age(&cache, "expired", 31 * 86400);
    age(&cache, "old", 29 * 86400);
    age(&cache, "recent", 29 * 86400);
    assert!(cache.get::<String>(&id("expired")).await.is_none());
    assert!(cache.get::<String>(&id("recent")).await.is_some());
    cache
        .configure(PreviewCacheSettings {
            max_bytes: 1024,
            max_age_days: 7,
        })
        .await
        .unwrap();
    assert!(cache.get::<String>(&id("old")).await.is_none());
    assert_eq!(
        cache.get::<String>(&id("recent")).await.as_deref(),
        Some("data")
    );
    drop(cache);
    assert_eq!(
        open(&dir).await.info().await.unwrap().settings.max_age_days,
        7
    );
}

#[tokio::test]
async fn startup_prunes_expired_entries_and_lower_limits_evict_oldest() {
    let dir = tempfile::tempdir().unwrap();
    let cache = open(&dir).await;
    for name in ["expired", "old", "recent"] {
        cache.put(id(name), "data").await;
    }
    age(&cache, "expired", 31 * 86400);
    age(&cache, "old", 10);
    drop(cache);
    let cache = open(&dir).await;
    assert_eq!(cache.info().await.unwrap().used_bytes, 12);
    let info = cache
        .configure(PreviewCacheSettings {
            max_bytes: 6,
            max_age_days: 30,
        })
        .await
        .unwrap();
    assert_eq!(info.used_bytes, 6);
    assert!(cache.get::<String>(&id("old")).await.is_none());
    assert!(cache.get::<String>(&id("recent")).await.is_some());
}

#[tokio::test]
async fn corrupt_missing_and_oversized_cache_entries_do_not_break_previews() {
    let dir = tempfile::tempdir().unwrap();
    let cache = open(&dir).await;
    cache
        .configure(PreviewCacheSettings {
            max_bytes: 8,
            max_age_days: 30,
        })
        .await
        .unwrap();
    cache.put(id("huge"), "too large for the budget").await;
    assert_eq!(cache.info().await.unwrap().used_bytes, 0);
    cache.put(id("bad"), "data").await;
    let path = dir
        .path()
        .join(format!("application-cache/previews/{}.cache", id("bad")));
    fs::write(&path, b"invalid").unwrap();
    assert!(cache.get::<String>(&id("bad")).await.is_none());
    assert!(!path.exists());
    cache.put(id("bad"), "data").await;
    fs::remove_file(path).unwrap();
    assert!(cache.get::<String>(&id("bad")).await.is_none());
    assert_eq!(cache.info().await.unwrap().used_bytes, 0);
}

#[tokio::test]
async fn concurrent_inserts_obey_the_budget_and_clear_preserves_settings() {
    let dir = tempfile::tempdir().unwrap();
    let cache = open(&dir).await;
    let settings = PreviewCacheSettings {
        max_bytes: 12,
        max_age_days: 7,
    };
    cache.configure(settings).await.unwrap();
    tokio::join!(
        cache.put(id("a"), "data"),
        cache.put(id("b"), "data"),
        cache.put(id("c"), "data")
    );
    assert!(cache.info().await.unwrap().used_bytes <= 12);
    let unrelated = dir.path().join("application-cache/previews/unrelated.txt");
    fs::write(&unrelated, "keep").unwrap();
    assert_eq!(cache.clear().await.unwrap().used_bytes, 0);
    assert!(unrelated.exists());
    drop(cache);
    assert_eq!(open(&dir).await.info().await.unwrap().settings, settings);
}

#[tokio::test]
async fn invalid_settings_leave_durable_configuration_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let cache = open(&dir).await;
    for settings in [
        PreviewCacheSettings {
            max_bytes: 0,
            max_age_days: 30,
        },
        PreviewCacheSettings {
            max_bytes: 1024,
            max_age_days: 0,
        },
        PreviewCacheSettings {
            max_bytes: 1024,
            max_age_days: 3651,
        },
    ] {
        assert!(cache.configure(settings).await.is_err());
    }
    assert_eq!(
        cache.info().await.unwrap().settings,
        PreviewCacheSettings::default()
    );
    assert!(!dir.path().join("config/preview-cache.json").exists());
}

#[test]
fn source_revisions_and_rendering_variants_have_distinct_keys() {
    let mut entry = StorageEntry {
        locator: StorageLocator {
            volume_id: uuid::Uuid::new_v4(),
            logical_path: "photo.NEF".into(),
            version_id: None,
        },
        name: "photo.NEF".into(),
        kind: StorageEntryKind::File,
        size: Some(100),
        modified_at: None,
        etag: None,
        content_type: None,
        metadata: serde_json::json!({}),
    };
    assert!(key(&entry, "photo:false:false").is_none());
    entry.modified_at = Some("first".into());
    let original = key(&entry, "photo:false:false").unwrap();
    assert_ne!(Some(original.clone()), key(&entry, "photo:true:false"));
    assert_ne!(Some(original.clone()), key(&entry, "photo:false:true"));
    assert_ne!(Some(original.clone()), key(&entry, "entry:false"));
    entry.modified_at = Some("changed".into());
    assert_ne!(Some(original), key(&entry, "photo:false:false"));
}

#[tokio::test]
async fn ordinary_and_photo_previews_share_disk_cache_and_revalidate_sources() {
    let dir = tempfile::tempdir().unwrap();
    let photos = dir.path().join("photos");
    fs::create_dir(&photos).unwrap();
    fs::write(
        photos.join("photo.NEF"),
        crate::browsing::nef::fixture(false, false),
    )
    .unwrap();
    fs::write(photos.join("note.txt"), "first preview").unwrap();
    let repository = storage_repository::Repository::open(&dir.path().join("settings.sqlite"))
        .await
        .unwrap();
    let cache = open(&dir).await;
    let service = crate::StorageService::new(repository.clone()).with_preview_cache(cache.clone());
    let volume = service
        .add_selected_directory(photos.clone(), false)
        .await
        .unwrap();
    let locator = |path: &str| StorageLocator {
        volume_id: volume.id,
        logical_path: path.into(),
        version_id: None,
    };
    let first = service
        .preview_entry(locator("note.txt"), false)
        .await
        .unwrap();
    assert_eq!(first.content, "first preview");
    let first_size = cache.info().await.unwrap().used_bytes;
    assert!(first_size > 0);
    let review = service.photo_review_workspace();
    let session = review
        .photo_open_directory_review(locator(""))
        .await
        .unwrap();
    let photo = review
        .photo_preview(session.photo_ids[0], false, false, false)
        .await
        .unwrap();
    assert_eq!((photo.width, photo.height), (1200, 2400));
    assert!(cache.info().await.unwrap().used_bytes > first_size);
    #[cfg(unix)]
    let disk_files = {
        use std::os::unix::fs::MetadataExt;
        let mut files = Vec::new();
        let backend = service.backend(volume.id).await.unwrap();
        for (name, variant) in [
            ("note.txt", "entry:false"),
            ("photo.NEF", "photo:false:false"),
        ] {
            let source = backend.stat(&locator(name)).await.unwrap();
            let path = dir.path().join(format!(
                "application-cache/previews/{}.cache",
                key(&source, variant).unwrap()
            ));
            files.push((path.clone(), fs::metadata(path).unwrap().ino()));
        }
        files
    };
    // Reopening creates fresh memory caches, but reuses the persisted previews.
    let reopened = crate::StorageService::new(repository).with_preview_cache(open(&dir).await);
    assert_eq!(
        reopened
            .preview_entry(locator("note.txt"), false)
            .await
            .unwrap()
            .content,
        "first preview"
    );
    assert_eq!(
        reopened
            .photo_review_workspace()
            .photo_preview(session.photo_ids[0], false, false, false)
            .await
            .unwrap()
            .content,
        photo.content
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        for (path, inode) in disk_files {
            assert_eq!(
                fs::metadata(path).unwrap().ino(),
                inode,
                "cache hits must reuse the existing file rather than regenerating and replacing it"
            );
        }
    }
    fs::write(photos.join("note.txt"), "a changed preview").unwrap();
    assert_eq!(
        reopened
            .preview_entry(locator("note.txt"), false)
            .await
            .unwrap()
            .content,
        "a changed preview"
    );
    fs::remove_file(photos.join("note.txt")).unwrap();
    assert!(
        reopened
            .preview_entry(locator("note.txt"), false)
            .await
            .is_err(),
        "never serve stale cache for a deleted source"
    );
    assert!(!photos.join(".filo/cache").exists());
}

#[tokio::test]
async fn cached_previews_do_not_wait_for_busy_image_processing_slots() {
    let dir = tempfile::tempdir().unwrap();
    let photos = dir.path().join("photos");
    fs::create_dir(&photos).unwrap();
    fs::write(
        photos.join("photo.NEF"),
        crate::browsing::nef::fixture(false, false),
    )
    .unwrap();
    fs::write(photos.join("note.txt"), "cached text").unwrap();
    let repository = storage_repository::Repository::open(&dir.path().join("settings.sqlite"))
        .await
        .unwrap();
    let service = crate::StorageService::new(repository).with_preview_cache(open(&dir).await);
    let volume = service.add_selected_directory(photos, false).await.unwrap();
    let locator = |path: &str| StorageLocator {
        volume_id: volume.id,
        logical_path: path.into(),
        version_id: None,
    };
    let review = service.photo_review_workspace();
    let session = review
        .photo_open_directory_review(locator(""))
        .await
        .unwrap();
    service
        .preview_entry(locator("note.txt"), false)
        .await
        .unwrap();
    for thumbnail in [false, true] {
        review
            .photo_preview(session.photo_ids[0], false, thumbnail, false)
            .await
            .unwrap();
    }
    let _previews_busy = service.preview_slots.acquire_many(2).await.unwrap();
    let _thumbnail_busy = service.thumbnail_slots.acquire().await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        assert_eq!(
            service
                .preview_entry(locator("note.txt"), false)
                .await
                .unwrap()
                .content,
            "cached text"
        );
        for thumbnail in [false, true] {
            assert!(!review
                .photo_preview(session.photo_ids[0], false, thumbnail, false)
                .await
                .unwrap()
                .content
                .is_empty());
        }
    })
    .await
    .expect("disk cache hits must bypass busy preview and thumbnail generation slots");
}
