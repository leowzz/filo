use super::*;

impl StorageService {
    pub async fn photo_export(
        &self,
        session_id: Uuid,
        mut destination: StorageLocator,
        filter: PhotoExportFilter,
        observer: Arc<dyn Fn(PhotoProgress) + Send + Sync>,
    ) -> StorageResult<PhotoExport> {
        let _sync = self.photo_sync_lock.lock().await;
        let _mutation = self.mutation_lock.read().await;
        if destination.version_id.is_some() {
            return Err(invalid("请选择当前导出目录"));
        }
        if filter.rating > 5 {
            return Err(invalid("星级必须在 0 到 5 之间"));
        }
        destination.logical_path = normalize_path(&destination.logical_path)?;
        let catalog = self.photo_catalog().await?;
        let session = &catalog.sessions[session_index(&catalog, session_id)?];
        let archive = archive_for(&catalog, session.archive_id)?;
        let files: Vec<_> = catalog
            .photos
            .iter()
            .filter(|p| {
                session.photo_ids.contains(&p.id) && !p.excluded && filter.matches(p.rating, p.flag)
            })
            .flat_map(|p| p.files.iter().filter(|f| f.kind == PhotoFileKind::Raw))
            .collect();
        if files.is_empty() {
            return Err(invalid("没有符合筛选条件的 RAW"));
        }
        let source = self.backend(archive.raw.volume_id).await?;
        let target = self.backend(destination.volume_id).await?;
        if !crate::tree::directory(&target.stat(&destination).await?) {
            return Err(invalid("请选择导出目录"));
        }
        crate::tree::check_overlap(source.as_ref(), target.as_ref(), &archive.raw, &destination)?;
        let mut result = PhotoExport {
            directory: target
                .storage_path(&destination)
                .map(|(_, path)| path)
                .ok_or_else(|| invalid("请选择系统可访问的导出目录"))?,
            exported_at: chrono::Utc::now().to_rfc3339(),
            filter,
            total: files.len(),
            copied: 0,
            skipped: 0,
            failures: vec![],
        };
        for (index, file) in files.iter().enumerate() {
            observer(PhotoProgress {
                session_id,
                completed: index,
                total: files.len(),
                path: file.path.clone(),
            });
            let outcome = async {
                let from = file_target(archive, file)?;
                let to = child(&destination, &file.path)?;
                copy_raw(source.as_ref(), target.as_ref(), &from, &to).await
            }
            .await;
            match outcome {
                Ok(true) => result.copied += 1,
                Ok(false) => result.skipped += 1,
                Err(error) => result
                    .failures
                    .push(format!("{}：{}", file.path, error.message)),
            }
            observer(PhotoProgress {
                session_id,
                completed: index + 1,
                total: files.len(),
                path: file.path.clone(),
            });
        }
        drop(_mutation);
        let _guard = self.photo_lock.lock().await;
        let (revision, mut catalog) = self.load_photos().await?;
        let index = session_index(&catalog, session_id)?;
        catalog.sessions[index].last_export = Some(result.clone());
        catalog.sessions[index].revision += 1;
        self.save_photos(revision, &catalog)
            .await
            .map_err(|error| {
                StorageError::new(
                    error.code,
                    format!(
                        "已复制 {} 个，跳过 {} 个，失败 {} 个；导出位置 {} 未能保存：{}",
                        result.copied,
                        result.skipped,
                        result.failures.len(),
                        result.directory,
                        error.message
                    ),
                )
            })?;
        Ok(result)
    }
}

impl PhotoExportFilter {
    fn matches(&self, rating: u8, flag: PhotoFlag) -> bool {
        let matches_rating = match self.rating_mode {
            PhotoRatingFilter::Any => true,
            PhotoRatingFilter::AtLeast => rating >= self.rating,
            PhotoRatingFilter::Exactly => rating == self.rating,
            PhotoRatingFilter::AtMost => rating <= self.rating,
        };
        matches_rating && self.flag.is_none_or(|expected| expected == flag)
    }
}

/// Publish only a complete, verified copy; never replace a different existing file.
async fn copy_raw(
    source: &dyn StorageBackend,
    destination: &dyn StorageBackend,
    from: &StorageLocator,
    to: &StorageLocator,
) -> StorageResult<bool> {
    let before = source.stat(from).await?;
    if before.kind != StorageEntryKind::File {
        return Err(conflict("RAW 原片不是普通文件"));
    }
    let token = CancellationToken::new();
    if let Some(entry) = existing(destination, to).await? {
        if file_digest(source, &before, &token).await?
            == file_digest(destination, &entry, &token).await?
        {
            return Ok(false);
        }
        return Err(conflict("目标已有不同内容的同名文件，未覆盖"));
    }
    ensure_parent(destination, to).await?;
    let mut reader = source.open_read(from).await?;
    let mut writer = destination.stage_write(to).await?;
    let mut buffer = vec![0; 256 * 1024];
    let mut hash = Sha256::new();
    let mut size = 0u64;
    loop {
        let count = reader.read(&mut buffer).await.map_err(io_error)?;
        if count == 0 {
            break;
        }
        writer.write(&buffer[..count]).await?;
        hash.update(&buffer[..count]);
        size += count as u64;
    }
    if before.size != Some(size)
        || !crate::browsing::nef::same_file(&before, &source.stat(from).await?)
    {
        return Err(conflict("复制期间 RAW 原片发生变化，请重试"));
    }
    if !writer.verifies_on_commit()
        && digest(writer.reader().await?, &token).await? != (size, format!("{:x}", hash.finalize()))
    {
        return Err(conflict("导出校验失败，请重试"));
    }
    writer.commit().await?;
    Ok(true)
}
