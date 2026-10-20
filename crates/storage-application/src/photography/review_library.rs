use super::review_scan::ReviewScan;
use super::*;
use std::collections::HashMap;

type ReviewFile = (StorageEntry, String, PhotoFileKind, metadata::Metadata);

pub(super) fn revision(entry: &StorageEntry) -> String {
    bytes_hash(format!("{:?}:{:?}:{:?}", entry.size, entry.modified_at, entry.etag).as_bytes())
}

// Reuse the previous grouping (including deliberately split JPG/RAW pairs).
// No image contents are needed when all primary paths and revisions still match.
fn unchanged_group(
    group: &[ReviewFile],
    photos: &[Photo],
    index: &HashMap<(String, PhotoFileKind), usize>,
) -> Option<Vec<Uuid>> {
    let mut previous = Vec::new();
    for (entry, path, kind, _) in group.iter().filter(|(_, _, k, _)| k.primary()) {
        let i = *index.get(&(path.clone(), *kind))?;
        let file = photos[i]
            .files
            .iter()
            .find(|f| f.path == *path && f.kind == *kind)?;
        if file.observed_revision.as_deref() != Some(&revision(entry)) {
            return None;
        }
        previous.push(i);
    }
    previous.sort_unstable();
    previous.dedup();
    if previous.iter().any(|i| {
        photos[*i]
            .files
            .iter()
            .filter(|f| f.kind.primary())
            .any(|f| {
                !group
                    .iter()
                    .any(|(_, path, kind, _)| *path == f.path && *kind == f.kind)
            })
    }) {
        return None;
    }
    Some(previous.into_iter().map(|i| photos[i].id).collect())
}

async fn refresh_cached_mark(
    photo: &mut Photo,
    group: &[ReviewFile],
    backends: &HashMap<Uuid, Arc<dyn StorageBackend>>,
    scan: &ReviewScan,
) -> StorageResult<()> {
    let Some((entry, path, _, _)) = group
        .iter()
        .find(|(_, _, kind, _)| *kind == PhotoFileKind::Xmp)
    else {
        photo.rating = 0;
        photo.flag = PhotoFlag::None;
        photo.xmp_hash = None;
        photo.xmp_synced_revision = None;
        photo.files.retain(|f| f.kind != PhotoFileKind::Xmp);
        return Ok(());
    };
    if photo.files.iter().any(|f| {
        f.kind == PhotoFileKind::Xmp
            && f.path == *path
            && f.observed_revision.as_deref() == Some(&revision(entry))
    }) {
        return Ok(());
    }
    let bytes = scan
        .read(sync::read_document(
            backends[&entry.locator.volume_id].as_ref(),
            &entry.locator,
            4 * 1024 * 1024,
        ))
        .await?
        .ok_or_else(|| conflict("XMP 已消失，请重新打开目录"))?
        .1;
    let mark = xmp::read_mark(&bytes)?;
    let hash = bytes_hash(&bytes);
    photo.rating = mark.rating;
    photo.flag = mark.flag;
    photo.xmp_hash = Some(hash.clone());
    photo.xmp_synced_revision = Some(photo.revision);
    photo.files.retain(|f| f.kind != PhotoFileKind::Xmp);
    photo.files.push(PhotoFile {
        id: Uuid::new_v4(),
        kind: PhotoFileKind::Xmp,
        original_name: entry.name.clone(),
        path: path.clone(),
        sha256: hash,
        size: entry.size.unwrap_or(0),
        verified: false,
        error: None,
        observed_revision: Some(revision(entry)),
    });
    Ok(())
}

impl StorageService {
    /// Scan existing files without copying or consulting import history. Separate
    /// JPG/RAW roots are optional; one mixed directory is sufficient.
    pub async fn photo_open_review(
        &self,
        name: String,
        jpg: StorageLocator,
        raw: Option<StorageLocator>,
    ) -> StorageResult<PhotoSession> {
        self.photo_scan_review(
            Uuid::new_v4(),
            PhotoReviewInput {
                name,
                jpg,
                raw,
                directory: false,
                raw_only: None,
            },
            Arc::new(|_| {}),
        )
        .await
    }

    pub(super) async fn open_review(
        &self,
        input: PhotoReviewInput,
        scan: &ReviewScan,
    ) -> StorageResult<PhotoSession> {
        let PhotoReviewInput {
            mut name,
            jpg,
            raw,
            directory,
            raw_only,
        } = input;
        if !self.photo_review_workspace {
            return Err(invalid("请从独立的审图工作区打开目录"));
        }
        if !directory && name.trim().is_empty() {
            return Err(invalid("请填写审图名称"));
        }
        let raw = raw.unwrap_or_else(|| jpg.clone());
        let _guard = scan
            .read(async { Ok(self.photo_lock.lock().await) })
            .await?;
        let _mutation = scan
            .read(async { Ok(self.mutation_lock.read().await) })
            .await?;
        let (db_revision, mut catalog) = scan.read(self.load_photos()).await?;
        let volumes = scan.read(self.repository.list_volumes()).await?;
        for root in [&jpg, &raw] {
            let volume = volumes
                .iter()
                .find(|v| v.id == root.volume_id)
                .ok_or_else(|| invalid("未找到已配置的存储"))?;
            if !directory && !matches!(volume.root, VolumeRoot::Local { .. }) {
                return Err(invalid("请使用系统挂载的照片目录"));
            }
            if directory && volume.read_only {
                return Err(StorageError::new(
                    StorageErrorCode::AccessDenied,
                    "此存储为只读，无法在目录的 .filo 下保存审图进度，请先设为可写",
                ));
            }
            if directory {
                name = root
                    .logical_path
                    .rsplit('/')
                    .find(|s| !s.is_empty())
                    .unwrap_or(&volume.name)
                    .to_string();
            }
        }
        let jpg_backend = scan.read(self.backend(jpg.volume_id)).await?;
        let (resumed, progress) = if directory {
            scan.read(self.load_directory_review(&mut catalog, &jpg, jpg_backend.as_ref()))
                .await?
        } else {
            (None, None)
        };
        let archive_id = if let Some(session) = &resumed {
            session.archive_id
        } else if directory {
            let id = Uuid::new_v4();
            catalog.archives.push(PhotoArchive {
                id,
                jpg: jpg.clone(),
                raw: raw.clone(),
            });
            id
        } else {
            match catalog
                .archives
                .iter()
                .find(|a| a.jpg == jpg && a.raw == raw)
            {
                Some(archive) => archive.id,
                None => {
                    let id = Uuid::new_v4();
                    catalog.archives.push(PhotoArchive {
                        id,
                        jpg: jpg.clone(),
                        raw: raw.clone(),
                    });
                    id
                }
            }
        };
        let old_photos: Vec<_> = catalog
            .photos
            .iter()
            .filter(|p| p.archive_id == archive_id)
            .cloned()
            .collect();
        let old_index: HashMap<_, _> = old_photos
            .iter()
            .enumerate()
            .flat_map(|(i, p)| {
                p.files
                    .iter()
                    .filter(|f| f.kind.primary())
                    .map(move |f| ((f.path.clone(), f.kind), i))
            })
            .collect();
        let mut groups = BTreeMap::<String, Vec<ReviewFile>>::new();
        let mut backends = HashMap::from([(jpg.volume_id, jpg_backend)]);
        let roots = if raw == jpg {
            vec![(jpg.clone(), false)]
        } else {
            vec![(jpg.clone(), true), (raw.clone(), false)]
        };
        let mut count = 0;
        let mut found = 0;
        for (root, jpg_only) in roots {
            let backend = match backends.get(&root.volume_id) {
                Some(backend) => backend.clone(),
                None => scan.read(self.backend(root.volume_id)).await?,
            };
            backends.insert(root.volume_id, backend.clone());
            // Opening a directory listing already validates its type and access.
            let mut pending = vec![root.clone()];
            while let Some(parent) = pending.pop() {
                scan.progress(
                    PhotoReviewStage::Listing,
                    found,
                    count,
                    None,
                    &parent.logical_path,
                );
                let mut listing = scan.read(backend.open_listing(&parent)).await?;
                loop {
                    let entries = scan.read(listing.next_batch(256)).await?;
                    if entries.is_empty() {
                        break;
                    }
                    for entry in entries {
                        scan.check()?;
                        count += 1;
                        if count > 100_000 {
                            return Err(invalid("照片目录超过 100000 项，请分组打开"));
                        }
                        if entry.name.starts_with('.') {
                            continue;
                        }
                        if crate::tree::directory(&entry) {
                            pending.push(entry.locator.clone());
                            continue;
                        }
                        if entry.kind != StorageEntryKind::File {
                            continue;
                        }
                        let kind = match entry
                            .name
                            .rsplit('.')
                            .next()
                            .unwrap_or("")
                            .to_ascii_lowercase()
                            .as_str()
                        {
                            "nef" => PhotoFileKind::Raw,
                            "jpg" | "jpeg" => PhotoFileKind::Jpg,
                            "xmp" => PhotoFileKind::Xmp,
                            "acr" => PhotoFileKind::Acr,
                            _ => continue,
                        };
                        if raw != jpg
                            && (jpg_only && kind != PhotoFileKind::Jpg
                                || !jpg_only && kind == PhotoFileKind::Jpg)
                        {
                            continue;
                        }
                        let path = if root.logical_path.is_empty() {
                            entry.locator.logical_path.clone()
                        } else {
                            entry
                                .locator
                                .logical_path
                                .strip_prefix(&format!("{}/", root.logical_path))
                                .ok_or_else(|| invalid("照片目录返回了范围外路径"))?
                                .to_string()
                        };
                        let key = path.rsplit_once('.').unwrap().0.to_ascii_lowercase();
                        if kind.primary() {
                            found += 1;
                        }
                        groups.entry(key).or_default().push((
                            entry,
                            path,
                            kind,
                            metadata::Metadata::default(),
                        ));
                    }
                    scan.progress(
                        PhotoReviewStage::Listing,
                        found,
                        count,
                        None,
                        &parent.logical_path,
                    );
                }
            }
        }
        let mut session = resumed.unwrap_or_else(|| PhotoSession {
            id: Uuid::new_v4(),
            archive_id,
            name: name.trim().into(),
            card_name: String::new(),
            created_at: chrono::Utc::now().to_rfc3339(),
            source: None,
            directory: directory.then(|| jpg.clone()),
            layout: PhotoLayout::Original,
            keep_hierarchy: true,
            photo_ids: vec![],
            sources: vec![],
            revision: 1,
            synced_revision: 0,
            nas_hash: None,
            sync_error: None,
            handed_off: false,
            position: PhotoReviewPosition::default(),
            undo: vec![],
        });
        session.photo_ids.clear();
        if let Some(raw_only) = raw_only {
            session.position.raw_only = raw_only;
        }
        if directory {
            session.revision += 1;
        }
        let total = groups
            .values()
            .filter(|g| g.iter().any(|(_, _, k, _)| k.primary()))
            .count();
        for (completed, group) in groups
            .values_mut()
            .filter(|g| g.iter().any(|(_, _, kind, _)| kind.primary()))
            .enumerate()
        {
            scan.check()?;
            // Reject ambiguity before using a cached grouping.
            let mut kinds = HashSet::new();
            if group.iter().any(|(_, _, kind, _)| !kinds.insert(*kind)) {
                return Err(conflict("同一目录有多个同格式候选照片，请先整理文件名"));
            }
            if completed % 32 == 0 {
                scan.progress(
                    PhotoReviewStage::Pairing,
                    found,
                    completed,
                    Some(total),
                    &group[0].1,
                );
            }
            if let Some(ids) = unchanged_group(group, &old_photos, &old_index) {
                if directory {
                    for id in &ids {
                        let photo = catalog.photos.iter_mut().find(|p| p.id == *id).unwrap();
                        refresh_cached_mark(photo, group, &backends, scan).await?;
                    }
                }
                session.photo_ids.extend(ids);
                continue;
            }
            // A single RAW/JPG needs no EXIF to enter review. Read image headers
            // only for new/changed same-name candidates that need pair validation.
            if kinds.contains(&PhotoFileKind::Raw) && kinds.contains(&PhotoFileKind::Jpg) {
                for (entry, path, _, meta) in group.iter_mut().filter(|(_, _, k, _)| k.primary()) {
                    scan.progress(
                        PhotoReviewStage::Pairing,
                        found,
                        completed,
                        Some(total),
                        path,
                    );
                    let backend = &backends[&entry.locator.volume_id];
                    *meta = scan.read(metadata::read(backend.as_ref(), entry)).await?;
                }
            }
            let raw_meta = group
                .iter()
                .find(|(_, _, kind, _)| *kind == PhotoFileKind::Raw)
                .map(|(_, _, _, meta)| meta);
            let jpg_meta = group
                .iter()
                .find(|(_, _, kind, _)| *kind == PhotoFileKind::Jpg)
                .map(|(_, _, _, meta)| meta);
            let mismatch = raw_meta.zip(jpg_meta).is_some_and(|(a, b)| {
                a.time
                    .as_ref()
                    .zip(b.time.as_ref())
                    .is_some_and(|(a, b)| a != b)
                    || a.camera
                        .as_ref()
                        .zip(b.camera.as_ref())
                        .is_some_and(|(a, b)| a != b)
            });
            // Contradictory candidates remain separate review items.
            let sets: Vec<Vec<_>> = if mismatch {
                vec![
                    group
                        .iter()
                        .filter(|(_, _, k, _)| *k != PhotoFileKind::Jpg)
                        .collect(),
                    group
                        .iter()
                        .filter(|(_, _, k, _)| *k == PhotoFileKind::Jpg)
                        .collect(),
                ]
            } else {
                vec![group.iter().collect()]
            };
            for set in sets {
                if !set.iter().any(|(_, _, k, _)| k.primary()) {
                    continue;
                }
                let primary: Vec<_> = set.iter().filter(|(_, _, k, _)| k.primary()).collect();
                let old = old_index
                    .get(&(primary[0].1.clone(), primary[0].2))
                    .map(|i| &old_photos[*i])
                    .filter(|p| {
                        p.files.iter().filter(|f| f.kind.primary()).count() == primary.len()
                            && primary.iter().all(|(entry, path, kind, _)| {
                                p.files.iter().any(|f| {
                                    f.path == *path
                                        && f.kind == *kind
                                        && f.observed_revision.as_deref() == Some(&revision(entry))
                                })
                            })
                    })
                    .cloned();
                if let Some(old) = old {
                    session.photo_ids.push(old.id);
                    continue;
                }
                let mut files = Vec::new();
                let mut xmp_hash = None;
                let mut initial_mark = PhotoMark {
                    rating: 0,
                    flag: PhotoFlag::None,
                };
                for (entry, path, kind, _) in &set {
                    if files.iter().any(|f: &PhotoFile| f.kind == *kind) {
                        return Err(conflict("同一目录有多个同格式候选照片，请先整理文件名"));
                    }
                    let sha256 = if *kind == PhotoFileKind::Xmp {
                        let backend = &backends[&entry.locator.volume_id];
                        let bytes = scan
                            .read(sync::read_document(
                                backend.as_ref(),
                                &entry.locator,
                                4 * 1024 * 1024,
                            ))
                            .await?
                            .ok_or_else(|| conflict("XMP 已消失，请重新打开目录"))?
                            .1;
                        let hash = bytes_hash(&bytes);
                        if let Ok(mark) = xmp::read_mark(&bytes) {
                            initial_mark = mark;
                        }
                        xmp_hash = Some(hash.clone());
                        hash
                    } else {
                        String::new()
                    };
                    files.push(PhotoFile {
                        id: Uuid::new_v4(),
                        kind: *kind,
                        original_name: entry.name.clone(),
                        path: path.clone(),
                        sha256,
                        size: entry.size.unwrap_or(0),
                        verified: false,
                        error: None,
                        observed_revision: Some(revision(entry)),
                    });
                }
                let time = primary
                    .iter()
                    .find(|(_, _, kind, _)| *kind == PhotoFileKind::Raw)
                    .and_then(|(_, _, _, meta)| meta.time.as_ref())
                    .or_else(|| {
                        primary
                            .iter()
                            .find_map(|(_, _, _, meta)| meta.time.as_ref())
                    });
                let photo = Photo {
                    id: Uuid::new_v4(),
                    archive_id,
                    original_path: primary[0].1.clone(),
                    capture_date: time.map(|t| metadata::date(t)),
                    capture_time: time.cloned(),
                    capture_time_loaded: kinds.contains(&PhotoFileKind::Raw)
                        && kinds.contains(&PhotoFileKind::Jpg),
                    issues: if mismatch {
                        vec!["NEF/JPG 元数据有矛盾，已分开审阅".into()]
                    } else {
                        vec![]
                    },
                    files,
                    rating: initial_mark.rating,
                    flag: initial_mark.flag,
                    excluded: false,
                    revision: 0,
                    xmp_hash,
                    xmp_synced_revision: None,
                };
                session.photo_ids.push(photo.id);
                catalog.photos.push(photo);
            }
        }
        if session.photo_ids.is_empty() {
            return Err(invalid("目录中没有可审阅的 JPG 或 NEF"));
        }
        if directory {
            if let Some(progress) = progress {
                session.position.sort = progress.sort;
                session.position.current = progress.current.and_then(|path| {
                    catalog
                        .photos
                        .iter()
                        .find(|p| {
                            p.archive_id == archive_id
                                && p.files
                                    .iter()
                                    .any(|file| file.kind.primary() && file.path == path)
                                && session.photo_ids.contains(&p.id)
                        })
                        .map(|p| p.id)
                });
            }
            session
                .undo
                .retain(|u| session.photo_ids.contains(&u.photo_id));
            if session
                .position
                .current
                .is_some_and(|id| !session.photo_ids.contains(&id))
            {
                session.position.current = None;
            }
            catalog
                .photos
                .retain(|p| p.archive_id != archive_id || session.photo_ids.contains(&p.id));
        }
        catalog.sessions.push(session.clone());
        scan.check()?;
        scan.progress(PhotoReviewStage::Saving, found, total, Some(total), "");
        self.save_photos(db_revision, &catalog).await?;
        let saved = self.photo_catalog().await?;
        Ok(saved.sessions[session_index(&saved, session.id)?].clone())
    }
}
