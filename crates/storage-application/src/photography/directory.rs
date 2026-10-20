use super::*;

impl StorageService {
    pub(super) async fn migrate_directory_marks(
        &self,
        root: &StorageLocator,
        saved: &mut sync::Manifest,
    ) -> StorageResult<Vec<Photo>> {
        sync::validate(saved, true)?;
        let archive = PhotoArchive {
            id: saved.session.archive_id,
            jpg: root.clone(),
            raw: root.clone(),
        };
        let mut migrated = Vec::new();
        for photo in &mut saved.photos {
            if photo.revision > 0
                && photo.xmp_synced_revision != Some(photo.revision)
                && (photo.rating > 0 || photo.flag != PhotoFlag::None || photo.xmp_hash.is_some())
                && self.photo_primary_target(&archive, photo).await?.is_some()
            {
                self.write_photo_mark(&archive, photo).await?;
                migrated.push(photo.clone());
            }
        }
        Ok(migrated)
    }

    pub async fn photo_open_directory_review(
        &self,
        root: StorageLocator,
    ) -> StorageResult<PhotoSession> {
        self.photo_scan_review(
            Uuid::new_v4(),
            PhotoReviewInput {
                name: String::new(),
                jpg: root,
                raw: None,
                directory: true,
                raw_only: None,
            },
            Arc::new(|_| {}),
        )
        .await
    }

    pub(super) async fn load_directory_review(
        &self,
        catalog: &mut PhotoCatalog,
        root: &StorageLocator,
    ) -> StorageResult<(Option<PhotoSession>, Option<sync::DirectoryProgress>)> {
        let backend = self.backend(root.volume_id).await?;
        let target = child(root, sync::DIRECTORY_PROGRESS)?;
        let saved = sync::read_document(backend.as_ref(), &target, sync::MANIFEST_LIMIT).await?;
        let document = saved
            .as_ref()
            .map(|(_, bytes)| serde_json::from_slice::<serde_json::Value>(bytes))
            .transpose()
            .map_err(|_| invalid("目录中的审图记录损坏，已保留原文件"))?;
        if document
            .as_ref()
            .is_none_or(|value| value.get("session").is_none())
        {
            let progress: Option<sync::DirectoryProgress> = document
                .map(serde_json::from_value)
                .transpose()
                .map_err(|_| invalid("目录中的审图进度无效，已保留原文件"))?;
            if let Some(path) = progress.as_ref().and_then(|p| p.current.as_ref()) {
                if path.is_empty() || normalize_path(path)? != *path {
                    return Err(invalid("目录中的审图位置无效，已保留原文件"));
                }
            }
            let mut cached = catalog
                .sessions
                .iter()
                .position(|s| s.directory.as_ref() == Some(root))
                .map(|index| catalog.sessions.remove(index));
            if let Some(session) = &mut cached {
                session.position.current = None;
                session.nas_hash = saved.as_ref().map(|(_, bytes)| bytes_hash(bytes));
                session.synced_revision = session.revision;
                session.sync_error = None;
            }
            return Ok((cached, progress));
        }

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
            return Ok((None, None));
        };
        let mut saved: sync::Manifest = serde_json::from_slice(&bytes)
            .map_err(|_| invalid("目录中的审图记录损坏，已保留原文件"))?;
        saved.session.undo.retain(|undo| undo.before != undo.after);
        self.migrate_directory_marks(root, &mut saved).await?;
        let progress = sync::DirectoryProgress {
            sort: saved.session.position.sort,
            current: saved.session.position.current.and_then(|id| {
                saved
                    .photos
                    .iter()
                    .find(|p| p.id == id)
                    .map(|p| p.original_path.clone())
            }),
        };
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
        saved.session.position.current = None;
        catalog.archives.push(PhotoArchive {
            id: saved.session.archive_id,
            jpg: root.clone(),
            raw: root.clone(),
        });
        catalog.photos.extend(saved.photos);
        Ok((Some(saved.session), Some(progress)))
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
            .photo_preview(session.photo_ids[0], false, true, false)
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
        assert_eq!(saved["current"], "nested/one.jpg");
        assert_eq!(saved.as_object().unwrap().len(), 2);
        assert_eq!(
            xmp::read_mark(&std::fs::read(root.join("trip/nested/one.xmp")).unwrap())
                .unwrap()
                .rating,
            5
        );
        assert!(!root.join(".filo").exists());
        let reopened = review
            .photo_open_directory_review(root_locator)
            .await
            .unwrap();
        assert_eq!(reopened.id, session.id);
    }
}
