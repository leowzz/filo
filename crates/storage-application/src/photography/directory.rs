use super::*;

impl StorageService {
    pub async fn photo_open_directory_review(
        &self,
        mut root: StorageLocator,
    ) -> StorageResult<PhotoSession> {
        if root.version_id.is_some() {
            return Err(invalid("请从当前目录进入审图，不支持历史版本"));
        }
        root.logical_path = normalize_path(&root.logical_path)?;
        self.open_review(String::new(), root, None, true).await
    }

    pub(super) async fn load_directory_review(
        &self,
        catalog: &mut PhotoCatalog,
        root: &StorageLocator,
    ) -> StorageResult<Option<PhotoSession>> {
        let backend = self.backend(root.volume_id).await?;
        let target = child(root, sync::DIRECTORY_PROGRESS)?;
        let saved = sync::read_document(backend.as_ref(), &target, sync::MANIFEST_LIMIT).await?;

        // Replace only this folder's cache. The file beside the photographs is
        // authoritative, including when opening on a different computer.
        let old_archives: HashSet<_> = catalog
            .sessions
            .iter()
            .filter(|s| s.directory.as_ref() == Some(root))
            .map(|s| s.archive_id)
            .collect();
        catalog
            .sessions
            .retain(|s| s.directory.as_ref() != Some(root));
        let unused: HashSet<_> = old_archives
            .into_iter()
            .filter(|id| !catalog.sessions.iter().any(|s| s.archive_id == *id))
            .collect();
        catalog.archives.retain(|a| !unused.contains(&a.id));
        catalog.photos.retain(|p| !unused.contains(&p.archive_id));
        let Some((_, bytes)) = saved else {
            return Ok(None);
        };
        let mut saved: sync::Manifest = serde_json::from_slice(&bytes)
            .map_err(|_| invalid("目录中的审图记录损坏，已保留原文件"))?;
        sync::validate(&saved, true)?;
        // A copied folder may contain the same portable IDs as another review.
        // Give that copy its own cache identities without sharing progress.
        if catalog
            .archives
            .iter()
            .any(|a| a.id == saved.session.archive_id)
            || catalog.sessions.iter().any(|s| s.id == saved.session.id)
            || catalog
                .photos
                .iter()
                .any(|p| saved.session.photo_ids.contains(&p.id))
        {
            let archive = Uuid::new_v4();
            let ids: BTreeMap<_, _> = saved
                .session
                .photo_ids
                .iter()
                .map(|id| (*id, Uuid::new_v4()))
                .collect();
            saved.session.id = Uuid::new_v4();
            saved.session.archive_id = archive;
            saved.session.photo_ids = saved.session.photo_ids.iter().map(|id| ids[id]).collect();
            saved.session.position.current = saved.session.position.current.map(|id| ids[&id]);
            for undo in &mut saved.session.undo {
                undo.photo_id = ids[&undo.photo_id];
            }
            for photo in &mut saved.photos {
                photo.id = ids[&photo.id];
                photo.archive_id = archive;
                for file in &mut photo.files {
                    file.id = Uuid::new_v4();
                }
            }
        }
        saved.session.source = None;
        saved.session.sources.clear();
        saved.session.directory = Some(root.clone());
        saved.session.nas_hash = Some(bytes_hash(&bytes));
        saved.session.synced_revision = saved.session.revision;
        saved.session.sync_error = None;
        catalog.archives.push(PhotoArchive {
            id: saved.session.archive_id,
            jpg: root.clone(),
            raw: root.clone(),
        });
        catalog.photos.extend(saved.photos);
        Ok(Some(saved.session))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use storage_provider_api::StagedWrite;

    // Exercise configured non-local volumes and virtual prefixes without an
    // external server. Real provider I/O remains covered by integration fixtures.
    struct VirtualBackend(OpenDalLocalBackend);
    fn virtual_entry(mut entry: StorageEntry) -> StorageEntry {
        if entry.kind == StorageEntryKind::Directory {
            entry.kind = StorageEntryKind::VirtualPrefix;
        }
        entry
    }
    #[async_trait::async_trait]
    impl StorageBackend for VirtualBackend {
        fn is_remote(&self) -> bool {
            true
        }
        fn volume_id(&self) -> Uuid {
            self.0.volume_id()
        }
        fn capabilities(&self) -> StorageCapabilities {
            StorageCapabilities::s3(false)
        }
        async fn list(&self, parent: &StorageLocator) -> StorageResult<Vec<StorageEntry>> {
            Ok(self
                .0
                .list(parent)
                .await?
                .into_iter()
                .map(virtual_entry)
                .collect())
        }
        async fn stat(&self, path: &StorageLocator) -> StorageResult<StorageEntry> {
            self.0.stat(path).await.map(virtual_entry)
        }
        async fn create_dir(&self, path: &StorageLocator) -> StorageResult<()> {
            self.0.create_dir(path).await
        }
        async fn rename(&self, from: &StorageLocator, to: &StorageLocator) -> StorageResult<()> {
            self.0.rename(from, to).await
        }
        async fn delete(&self, path: &StorageLocator) -> StorageResult<()> {
            self.0.delete(path).await
        }
        async fn open_read(&self, path: &StorageLocator) -> StorageResult<StorageReader> {
            self.0.open_read(path).await
        }
        async fn read_range(
            &self,
            entry: &StorageEntry,
            range: std::ops::Range<u64>,
        ) -> StorageResult<Vec<u8>> {
            self.0.read_range(entry, range).await
        }
        async fn stage_write(&self, path: &StorageLocator) -> StorageResult<Box<dyn StagedWrite>> {
            self.0.stage_write(path).await
        }
        async fn stage_replace(&self, entry: &StorageEntry) -> StorageResult<Box<dyn StagedWrite>> {
            self.0.stage_replace(entry).await
        }
    }

    #[tokio::test]
    async fn configured_remote_prefix_supports_review_preview_and_progress() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("storage");
        std::fs::create_dir_all(root.join("trip/nested")).unwrap();
        image::RgbImage::new(10, 10)
            .save(root.join("trip/nested/one.jpg"))
            .unwrap();
        let repository = Repository::open(&dir.path().join("db.sqlite"))
            .await
            .unwrap();
        let service = StorageService::new(repository);
        let mut volume = service
            .add_selected_directory(root.clone(), false)
            .await
            .unwrap();
        let backend = OpenDalLocalBackend::new(&volume).await.unwrap();
        volume.root = VolumeRoot::S3 {
            bucket: "fixture".into(),
            prefix: String::new(),
        };
        service
            .repository
            .save_s3(
                &StorageConnection {
                    id: volume.connection_id,
                    name: "fixture".into(),
                    provider: ProviderKind::S3,
                    config: serde_json::json!({}),
                    credential_ref: None,
                    enabled: true,
                },
                &volume,
            )
            .await
            .unwrap();
        service
            .temporary_backends
            .lock()
            .await
            .insert(volume.id, Arc::new(VirtualBackend(backend)));
        let review = service.photo_review_workspace();
        let root_locator = StorageLocator {
            volume_id: volume.id,
            logical_path: "trip".into(),
            version_id: None,
        };
        let session = review
            .photo_open_directory_review(root_locator.clone())
            .await
            .unwrap();
        assert_eq!(session.photo_ids.len(), 1);
        let preview = review
            .photo_preview(session.photo_ids[0], false, true)
            .await
            .unwrap();
        assert_eq!(preview.mime, "image/jpeg");
        review
            .photo_mark(session.id, session.photo_ids[0], 5, PhotoFlag::Pick)
            .await
            .unwrap();
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("trip/.filo/review.json")).unwrap())
                .unwrap();
        assert_eq!(saved["photos"][0]["rating"], 5);
        assert!(!root.join(".filo").exists());
        let reopened = review
            .photo_open_directory_review(root_locator)
            .await
            .unwrap();
        assert_eq!(reopened.id, session.id);
    }
}
