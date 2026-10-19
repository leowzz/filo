use super::*;

impl StorageService {
    pub async fn photo_cancel_import(&self, session_id: Uuid) -> StorageResult<()> {
        if let Some(token) = self.photo_jobs.lock().await.get(&session_id) {
            token.cancel();
        }
        Ok(())
    }

    pub async fn photo_rebind_source(
        &self,
        session_id: Uuid,
        source: StorageLocator,
    ) -> StorageResult<()> {
        let _guard = self.photo_lock.lock().await;
        let backend = self.backend(source.volume_id).await?;
        if backend.stat(&source).await?.kind != StorageEntryKind::Directory {
            return Err(invalid("请选择来源目录"));
        }
        let source = backend
            .list(&source)
            .await?
            .into_iter()
            .find(|e| e.kind == StorageEntryKind::Directory && e.name.eq_ignore_ascii_case("DCIM"))
            .map(|e| e.locator)
            .unwrap_or(source);
        let (revision, mut catalog) = self.load_photos().await?;
        let index = session_index(&catalog, session_id)?;
        let archive = archive_for(&catalog, catalog.sessions[index].archive_id)?;
        for root in [&archive.jpg, &archive.raw] {
            crate::tree::check_overlap(
                backend.as_ref(),
                self.backend(root.volume_id).await?.as_ref(),
                &source,
                root,
            )?;
        }
        catalog.sessions[index].source = Some(source);
        self.save_photos(revision, &catalog).await
    }

    pub async fn photo_import(
        &self,
        session_id: Uuid,
        observer: Arc<dyn Fn(PhotoProgress) + Send + Sync>,
    ) -> StorageResult<PhotoSession> {
        let token = CancellationToken::new();
        {
            let mut jobs = self.photo_jobs.lock().await;
            if jobs.contains_key(&session_id) {
                return Err(conflict("此批次正在导入"));
            }
            jobs.insert(session_id, token.clone());
        }
        let result = self.import_photos(session_id, &token, observer).await;
        self.photo_jobs.lock().await.remove(&session_id);
        result
    }

    async fn import_photos(
        &self,
        session_id: Uuid,
        token: &CancellationToken,
        observer: Arc<dyn Fn(PhotoProgress) + Send + Sync>,
    ) -> StorageResult<PhotoSession> {
        let _guard = self.photo_lock.lock().await;
        let _mutation = self.mutation_lock.read().await;
        let (mut revision, mut catalog) = self.load_photos().await?;
        let index = session_index(&catalog, session_id)?;
        let session = catalog.sessions[index].clone();
        let archive = archive_for(&catalog, session.archive_id)?.clone();
        let (jpg, raw) = self.photo_archive_backends(&archive).await?;
        let source = match &session.source {
            Some(root) => Some(self.backend(root.volume_id).await?),
            None => None,
        };
        let ids: HashSet<_> = session.photo_ids.iter().copied().collect();
        if catalog
            .photos
            .iter()
            .any(|p| ids.contains(&p.id) && !p.excluded && !p.issues.is_empty())
        {
            return Err(conflict("请先指定缺失日期、处理配对问题或排除对应照片"));
        }
        let mut tasks = vec![];
        for (pi, photo) in catalog
            .photos
            .iter()
            .enumerate()
            .filter(|(_, p)| ids.contains(&p.id) && !p.excluded)
        {
            for fi in 0..photo.files.len() {
                tasks.push((pi, fi));
            }
        }
        let total = tasks.len();
        for (completed, (pi, fi)) in tasks.into_iter().enumerate() {
            if token.is_cancelled() {
                return Err(StorageError::new(
                    StorageErrorCode::Cancelled,
                    "导入已暂停，可继续未完成文件",
                ));
            }
            let photo_id = catalog.photos[pi].id;
            let file = catalog.photos[pi].files[fi].clone();
            let target = file_target(&archive, &file)?;
            let backend = if file.kind == PhotoFileKind::Jpg {
                jpg.as_ref()
            } else {
                raw.as_ref()
            };
            observer(PhotoProgress {
                session_id,
                completed,
                total,
                path: file.path.clone(),
            });
            let result = async {
                // Never trust a journal flag alone. This also recovers a commit whose journal write was interrupted.
                if let Some(entry) = existing(backend, &target).await? {
                    let (size, hash) = file_digest(backend, &entry, token).await?;
                    let expected = if file.kind == PhotoFileKind::Xmp {
                        catalog.photos[pi]
                            .xmp_hash
                            .as_deref()
                            .unwrap_or(&file.sha256)
                    } else {
                        &file.sha256
                    };
                    if size == file.size && hash == expected
                        || file.kind == PhotoFileKind::Xmp && hash == expected
                    {
                        return Ok(());
                    }
                    return Err(conflict("目标已有不同内容，已保留双方；请核对后重试"));
                }
                let src_root = session
                    .source
                    .as_ref()
                    .ok_or_else(|| invalid("请先重新关联存储卡，或在目标重新上线后重试"))?;
                let source = source.as_ref().ok_or_else(|| invalid("来源目录未关联"))?;
                let record = session
                    .sources
                    .iter()
                    .find(|s| s.file_id == file.id)
                    .ok_or_else(|| invalid("此文件没有当前来源记录，请重新扫描原卡补齐"))?;
                let src = child(src_root, &record.path)?;
                let entry = source.stat(&src).await?;
                ensure_parent(backend, &target).await?;
                let mut job = TransferJob {
                    id: Uuid::new_v4(),
                    kind: TransferKind::Copy,
                    source: src,
                    destination: target.clone(),
                    state: TransferState::Queued,
                    bytes_total: entry.size,
                    bytes_transferred: 0,
                    error_code: None,
                    error_message: None,
                    created_at: chrono::Utc::now().to_rfc3339(),
                    updated_at: chrono::Utc::now().to_rfc3339(),
                };
                self.copy_file_verified(
                    &mut job,
                    token,
                    &(Arc::new(|_| {}) as crate::TransferObserver),
                    source.as_ref(),
                    backend,
                    &entry,
                    &target,
                    ConflictPolicy::Reject,
                    Some(&file.sha256),
                )
                .await?;
                Ok(())
            }
            .await;
            let member = &mut catalog.photos[pi].files[fi];
            member.verified = result.is_ok();
            member.error = result
                .as_ref()
                .err()
                .map(|e: &StorageError| e.message.clone());
            touch(&mut catalog, photo_id);
            // Each publication has its own durable checkpoint. A failed save stops immediately.
            self.save_photos(revision, &catalog).await?;
            revision += 1;
            if let Err(error) = result {
                if error.code == StorageErrorCode::Cancelled {
                    return Err(error);
                }
            }
            observer(PhotoProgress {
                session_id,
                completed: completed + 1,
                total,
                path: file.path,
            });
        }
        Ok(catalog.sessions[index].clone())
    }
}
