use super::*;
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
#[test]
fn atomic_rename_cannot_replace_a_target_created_after_preflight() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("source"), b"source").unwrap();
    // Simulate an external writer creating the target after the preflight check.
    std::fs::write(directory.path().join("target"), b"external").unwrap();
    assert_eq!(
        rename_no_replace(directory.path(), "source", "target")
            .unwrap_err()
            .code,
        StorageErrorCode::AlreadyExists
    );
    assert_eq!(
        std::fs::read(directory.path().join("target")).unwrap(),
        b"external"
    );
    assert_eq!(
        std::fs::read(directory.path().join("source")).unwrap(),
        b"source"
    );
}
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
#[test]
fn atomic_rename_supports_nested_unicode_paths_and_protects_existing_directories() {
    let directory = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(directory.path()).unwrap();
    std::fs::create_dir(root.join("父目录")).unwrap();
    std::fs::create_dir(root.join("父目录/源文件夹")).unwrap();
    std::fs::write(root.join("父目录/源文件夹/内容.txt"), b"keep").unwrap();
    rename_no_replace(&root, "父目录/源文件夹", "父目录/新文件夹").unwrap();
    assert_eq!(
        std::fs::read(root.join("父目录/新文件夹/内容.txt")).unwrap(),
        b"keep"
    );
    assert!(!root.join("父目录/源文件夹").exists());
    std::fs::create_dir(root.join("父目录/已存在")).unwrap();
    assert!(rename_no_replace(&root, "父目录/新文件夹", "父目录/已存在").is_err());
    assert_eq!(
        std::fs::read(root.join("父目录/新文件夹/内容.txt")).unwrap(),
        b"keep"
    );
    assert!(std::fs::read_dir(root.join("父目录/已存在"))
        .unwrap()
        .next()
        .is_none());
}
async fn fixture(read_only: bool) -> (tempfile::TempDir, OpenDalLocalBackend) {
    let dir = tempfile::tempdir().unwrap();
    let volume = StorageVolume {
        id: Uuid::new_v4(),
        connection_id: Uuid::new_v4(),
        name: "test".into(),
        root: VolumeRoot::Local {
            root_path: std::fs::canonicalize(dir.path()).unwrap(),
        },
        read_only,
    };
    let backend = OpenDalLocalBackend::new(&volume).await.unwrap();
    (dir, backend)
}
fn locator(backend: &OpenDalLocalBackend, path: &str) -> StorageLocator {
    StorageLocator {
        volume_id: backend.volume_id,
        logical_path: path.into(),
        version_id: None,
    }
}
#[tokio::test]
async fn physical_paths_use_the_same_hierarchy_across_connected_roots() {
    let (directory, backend) = fixture(false).await;
    std::fs::create_dir_all(directory.path().join("Folder/Nested")).unwrap();
    let alias = OpenDalLocalBackend::new(&StorageVolume {
        id: Uuid::new_v4(),
        connection_id: Uuid::new_v4(),
        name: "nested alias".into(),
        root: VolumeRoot::Local {
            root_path: std::fs::canonicalize(directory.path().join("Folder/Nested")).unwrap(),
        },
        read_only: false,
    })
    .await
    .unwrap();
    let parent = backend.storage_path(&locator(&backend, "Folder")).unwrap();
    let direct = backend
        .storage_path(&locator(&backend, "Folder/Nested/新文件.txt"))
        .unwrap();
    let nested = alias.storage_path(&locator(&alias, "新文件.txt")).unwrap();
    assert_eq!(direct, nested);
    assert!(nested.1.starts_with(&format!("{}/", parent.1)));
    #[cfg(any(target_os = "macos", windows))]
    assert_eq!(
        parent,
        backend.storage_path(&locator(&backend, "FOLDER")).unwrap()
    );
    #[cfg(unix)]
    assert_ne!(
        backend.storage_path(&locator(&backend, "Folder/Nested")),
        backend.storage_path(&locator(&backend, "Folder\\Nested")),
    );
}
#[tokio::test]
async fn trash_preserves_directory_contents_and_checks_authority() {
    let (directory, backend) = fixture(false).await;
    let recycle = tempfile::tempdir().unwrap();
    std::fs::create_dir(directory.path().join("folder")).unwrap();
    std::fs::write(directory.path().join("folder/keep.txt"), b"keep").unwrap();
    let target = recycle.path().join("folder");
    backend
        .trash_with(&locator(&backend, "folder"), move |path| {
            std::fs::rename(path, target).map_err(io_error)
        })
        .await
        .unwrap();
    assert!(!directory.path().join("folder").exists());
    assert_eq!(
        std::fs::read(recycle.path().join("folder/keep.txt")).unwrap(),
        b"keep"
    );
    for path in ["", "../outside"] {
        assert!(backend
            .trash_with(&locator(&backend, path), |_| panic!("must not call trash"))
            .await
            .is_err());
    }
    let (readonly_directory, readonly) = fixture(true).await;
    std::fs::write(readonly_directory.path().join("keep.txt"), b"keep").unwrap();
    assert_eq!(
        readonly
            .trash_with(&locator(&readonly, "keep.txt"), |_| panic!(
                "must not call trash"
            ))
            .await
            .unwrap_err()
            .code,
        StorageErrorCode::AccessDenied
    );
    assert!(readonly_directory.path().join("keep.txt").exists());
    std::fs::write(directory.path().join("failure.txt"), b"preserve").unwrap();
    assert!(backend
        .trash_with(&locator(&backend, "failure.txt"), |_| Err(
            StorageError::new(StorageErrorCode::Io, "unavailable")
        ))
        .await
        .is_err());
    assert!(directory.path().join("failure.txt").exists());
}

#[tokio::test]
async fn opening_resolves_only_authorized_regular_files_even_when_readonly() {
    let (directory, backend) = fixture(true).await;
    let filename = "a file 'with' $(quotes).txt";
    std::fs::write(directory.path().join(filename), b"safe").unwrap();
    assert_eq!(
        backend
            .open_path(&locator(&backend, filename))
            .await
            .unwrap(),
        std::fs::canonicalize(directory.path())
            .unwrap()
            .join(filename)
    );
    for path in ["", "../outside", "/etc/passwd", "missing"] {
        assert!(backend.open_path(&locator(&backend, path)).await.is_err());
        for directory in [false, true] {
            if path == "missing" && directory {
                continue;
            }
            assert!(backend
                .transfer_open_target(&locator(&backend, path), directory)
                .await
                .is_err());
        }
    }
    let mut wrong_volume = locator(&backend, filename);
    wrong_volume.volume_id = Uuid::new_v4();
    assert!(backend.open_path(&wrong_volume).await.is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            directory.path().join(filename),
            directory.path().join("link"),
        )
        .unwrap();
        assert!(backend.open_path(&locator(&backend, "link")).await.is_err());
        for directory in [false, true] {
            assert!(backend
                .open_transfer_path(&locator(&backend, "link"), directory)
                .await
                .is_err());
        }
        assert!(backend
            .trash_with(&locator(&backend, "link"), |_| panic!(
                "must not call trash"
            ))
            .await
            .is_err());
    }
}

#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "explicit system Trash smoke test; touches only a unique test file"]
async fn system_trash_smoke() {
    let (directory, backend) = fixture(false).await;
    let name = format!("filo-trash-smoke-{}.txt", Uuid::new_v4());
    std::fs::write(directory.path().join(&name), b"Filo trash integration").unwrap();
    backend.trash(&locator(&backend, &name)).await.unwrap();
    assert!(!directory.path().join(&name).exists());
    let recycled = std::path::PathBuf::from(std::env::var_os("HOME").unwrap())
        .join(".Trash")
        .join(&name);
    assert_eq!(std::fs::read(&recycled).unwrap(), b"Filo trash integration");
    // Remove only this test's UUID-named fixture; never enumerate or empty Trash.
    std::fs::remove_file(recycled).unwrap();
}

#[tokio::test]
async fn staged_write_never_replaces_a_late_target_and_cleans_up() {
    let (directory, backend) = fixture(false).await;
    let target = locator(&backend, "target");
    let mut staged = backend.stage_write(&target).await.unwrap();
    staged.write(b"new data").await.unwrap();
    drop(staged.reader().await.unwrap());
    std::fs::write(directory.path().join("target"), b"external data").unwrap();
    assert_eq!(
        staged.commit().await.unwrap_err().code,
        StorageErrorCode::AlreadyExists
    );
    assert_eq!(
        std::fs::read(directory.path().join("target")).unwrap(),
        b"external data"
    );
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    let (readonly_directory, readonly) = fixture(true).await;
    assert!(readonly
        .stage_write(&locator(&readonly, "blocked"))
        .await
        .is_err());
    assert_eq!(
        std::fs::read_dir(readonly_directory.path())
            .unwrap()
            .count(),
        0
    );
}

#[tokio::test]
async fn existing_files_and_mutations() {
    let (dir, backend) = fixture(false).await;
    std::fs::write(dir.path().join("original.txt"), b"hello existing file").unwrap();
    assert_eq!(backend.list(&locator(&backend, "")).await.unwrap().len(), 1);
    backend
        .create_dir(&locator(&backend, "folder"))
        .await
        .unwrap();
    backend
        .rename(
            &locator(&backend, "original.txt"),
            &locator(&backend, "renamed.txt"),
        )
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(dir.path().join("renamed.txt")).unwrap(),
        b"hello existing file"
    );
    backend
        .delete(&locator(&backend, "renamed.txt"))
        .await
        .unwrap();
    backend.delete(&locator(&backend, "folder")).await.unwrap();
    assert!(backend.delete(&locator(&backend, "")).await.is_err());
}
#[tokio::test]
async fn rejects_overwrite_nonempty_delete_and_read_only() {
    let (dir, backend) = fixture(false).await;
    std::fs::write(dir.path().join("a"), b"a").unwrap();
    std::fs::write(dir.path().join("b"), b"b").unwrap();
    assert_eq!(
        backend
            .rename(&locator(&backend, "a"), &locator(&backend, "b"))
            .await
            .unwrap_err()
            .code,
        StorageErrorCode::AlreadyExists
    );
    std::fs::create_dir(dir.path().join("full")).unwrap();
    std::fs::write(dir.path().join("full/keep"), b"keep").unwrap();
    assert!(backend.delete(&locator(&backend, "full")).await.is_err());
    assert!(dir.path().join("full/keep").exists());
    let (read_dir, read_backend) = fixture(true).await;
    std::fs::write(read_dir.path().join("keep"), b"keep").unwrap();
    assert!(read_backend
        .delete(&locator(&read_backend, "keep"))
        .await
        .is_err());
    assert!(read_backend
        .create_dir(&locator(&read_backend, "new"))
        .await
        .is_err());
    assert!(read_backend
        .rename(
            &locator(&read_backend, "keep"),
            &locator(&read_backend, "new")
        )
        .await
        .is_err());
}
#[cfg(unix)]
#[tokio::test]
async fn rejects_symlinks_and_path_escape() {
    let (dir, backend) = fixture(false).await;
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret"), b"secret").unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("escape")).unwrap();
    for path in ["../secret", "/etc/passwd", "escape/secret", "escape"] {
        assert!(backend.stat(&locator(&backend, path)).await.is_err());
        assert!(backend.delete(&locator(&backend, path)).await.is_err());
    }
    assert!(backend
        .create_dir(&locator(&backend, "escape/new"))
        .await
        .is_err());
    assert!(backend.list(&locator(&backend, "escape")).await.is_err());
    assert_eq!(
        backend.list(&locator(&backend, "")).await.unwrap()[0].kind,
        StorageEntryKind::Symlink
    );
    assert!(outside.path().join("secret").exists());
}

#[tokio::test]
async fn transfer_directory_reveals_existing_files_and_opens_parent_for_missing_files() {
    let (directory, backend) = fixture(true).await;
    let name = "a file 'with' $(quotes).txt";
    let file = std::fs::canonicalize(directory.path()).unwrap().join(name);
    std::fs::write(&file, b"content").unwrap();
    let entry = locator(&backend, name);
    assert_eq!(
        backend.transfer_open_target(&entry, true).await.unwrap(),
        (file.clone(), true, false)
    );
    assert_eq!(
        backend.transfer_open_target(&entry, false).await.unwrap(),
        (file.clone(), false, false)
    );
    std::fs::remove_file(&file).unwrap();
    assert_eq!(
        backend.transfer_open_target(&entry, true).await.unwrap(),
        (file.parent().unwrap().to_path_buf(), false, true)
    );
    assert!(backend.transfer_open_target(&entry, false).await.is_err());
    assert!(backend
        .transfer_open_target(&locator(&backend, "missing-parent/file"), true)
        .await
        .is_err());
}
