use super::*;

impl StorageService {
    pub(super) async fn load_capture_times(
        &self,
        session_id: Uuid,
        scan: &review_scan::ReviewScan,
    ) -> StorageResult<Vec<PhotoCaptureTime>> {
        let catalog = self.photo_catalog().await?;
        let session = &catalog.sessions[session_index(&catalog, session_id)?];
        let photos: Vec<_> = catalog
            .photos
            .iter()
            .filter(|p| !p.excluded && session.photo_ids.contains(&p.id))
            .collect();
        let pending: Vec<_> = photos.iter().filter(|p| !p.capture_time_loaded).collect();
        let mut updates = Vec::new();
        for (completed, photo) in pending.iter().enumerate() {
            scan.check()?;
            scan.progress(
                PhotoReviewStage::Pairing,
                photos.len(),
                completed,
                Some(pending.len()),
                &photo.original_path,
            );
            let archive = archive_for(&catalog, photo.archive_id)?;
            let mut time = None;
            // Prefer RAW metadata, falling back to its paired JPG when absent.
            for kind in [PhotoFileKind::Raw, PhotoFileKind::Jpg] {
                let Some(file) = photo.files.iter().find(|f| f.kind == kind) else {
                    continue;
                };
                let _mutation = self.mutation_lock.read().await;
                let target = file_target(archive, file)?;
                let backend = scan.read(self.backend(target.volume_id)).await?;
                let entry = scan.read(backend.stat(&target)).await?;
                time = scan
                    .read(metadata::read(backend.as_ref(), &entry))
                    .await?
                    .time;
                if time.is_some() {
                    break;
                }
            }
            updates.push((photo.id, photo.files.clone(), time));
        }
        scan.check()?;
        if updates.is_empty() {
            return Ok(photos
                .iter()
                .map(|p| PhotoCaptureTime {
                    id: p.id,
                    capture_time: p.capture_time.clone(),
                })
                .collect());
        }
        // Merge into the latest catalog so ratings, flags and progress saved
        // while headers were loading are preserved.
        let _guard = self.photo_lock.lock().await;
        let _mutation = self.mutation_lock.read().await;
        scan.check()?;
        let (revision, mut catalog) = self.load_photos().await?;
        let index = session_index(&catalog, session_id)?;
        for (id, files, time) in updates {
            let photo = catalog
                .photos
                .iter_mut()
                .find(|p| p.id == id)
                .filter(|p| {
                    p.files
                        .iter()
                        .filter(|f| f.kind.primary())
                        .map(|f| f.id)
                        .eq(files.iter().filter(|f| f.kind.primary()).map(|f| f.id))
                })
                .ok_or_else(|| conflict("照片列表已变化，请重新进入审图"))?;
            if photo.capture_date.is_none() {
                photo.capture_date = time.as_deref().map(metadata::date);
            }
            photo.capture_time = time;
            photo.capture_time_loaded = true;
        }
        scan.progress(
            PhotoReviewStage::Saving,
            photos.len(),
            pending.len(),
            Some(pending.len()),
            "",
        );
        self.save_photos(revision, &catalog).await?;
        Ok(catalog
            .photos
            .iter()
            .filter(|p| !p.excluded && catalog.sessions[index].photo_ids.contains(&p.id))
            .map(|p| PhotoCaptureTime {
                id: p.id,
                capture_time: p.capture_time.clone(),
            })
            .collect())
    }
}
