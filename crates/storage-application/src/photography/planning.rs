use super::*;

struct Scanned {
    entry: StorageEntry,
    path: String,
    kind: PhotoFileKind,
    hash: String,
    metadata: metadata::Metadata,
}

fn kind(name: &str) -> Option<PhotoFileKind> {
    match name.rsplit('.').next()?.to_ascii_lowercase().as_str() {
        "nef" => Some(PhotoFileKind::Raw),
        "jpg" | "jpeg" => Some(PhotoFileKind::Jpg),
        "xmp" => Some(PhotoFileKind::Xmp),
        "acr" => Some(PhotoFileKind::Acr),
        _ => None,
    }
}
fn safe_name(name: &str) -> StorageResult<()> {
    if name.trim().is_empty()
        || name.len() > 160
        || name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || matches!(
            name.to_ascii_uppercase().as_str(),
            "." | ".." | "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "LPT1"
        )
    {
        return Err(invalid("批次名称不能包含路径分隔符或 Windows 不支持的字符"));
    }
    Ok(())
}
fn group_directory(input: &PhotoPlanInput, date: Option<&str>, relative: &str) -> String {
    let group = match input.layout {
        PhotoLayout::Date => date
            .map(|d| format!("{}/{d}", &d[..4]))
            .unwrap_or_else(|| "未知拍摄日期".into()),
        PhotoLayout::Batch => input.name.clone(),
        PhotoLayout::Original => String::new(),
    };
    let parent = if input.keep_hierarchy {
        relative.rsplit_once('/').map(|(p, _)| p).unwrap_or("")
    } else {
        ""
    };
    [group.as_str(), parent]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

impl StorageService {
    pub async fn photo_plan(&self, mut input: PhotoPlanInput) -> StorageResult<PhotoSession> {
        input.name = input.name.trim().to_string();
        safe_name(&input.name)?;
        if let Some(date) = &input.date_override {
            if date.len() != 10 || chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err() {
                return Err(invalid("请使用有效的 YYYY-MM-DD 拍摄日期"));
            }
        }
        let _guard = self.photo_lock.lock().await;
        let _mutation = self.mutation_lock.read().await;
        let (revision, mut catalog) = self.load_photos().await?;
        // Only mounted filesystem roots are supported by the first-release workflow.
        let volumes = self.repository.list_volumes().await?;
        for root in [&input.source, &input.jpg, &input.raw] {
            normalize_path(&root.logical_path)?;
            let volume = volumes
                .iter()
                .find(|v| v.id == root.volume_id)
                .ok_or_else(|| invalid("请重新选择存储卡和归档目录"))?;
            if !matches!(volume.root, VolumeRoot::Local { .. }) {
                return Err(invalid("摄影首版请使用系统挂载的本地或 SMB 目录"));
            }
            if root != &input.source && volume.read_only {
                return Err(invalid("归档位置为只读，请选择可写目录"));
            }
        }
        let source = self.backend(input.source.volume_id).await?;
        let jpg = self.backend(input.jpg.volume_id).await?;
        let raw = self.backend(input.raw.volume_id).await?;
        for (a, ap, b, bp) in [
            (source.as_ref(), &input.source, jpg.as_ref(), &input.jpg),
            (source.as_ref(), &input.source, raw.as_ref(), &input.raw),
            (jpg.as_ref(), &input.jpg, raw.as_ref(), &input.raw),
        ] {
            crate::tree::check_overlap(a, b, ap, bp)?;
            crate::tree::check_overlap(b, a, bp, ap)?;
            if a.stat(ap).await?.kind != StorageEntryKind::Directory
                || b.stat(bp).await?.kind != StorageEntryKind::Directory
            {
                return Err(invalid("请选择已有目录"));
            }
        }
        // DCIM itself is the relative root, never the card name or drive letter.
        let children = source.list(&input.source).await?;
        if let Some(dcim) = children
            .iter()
            .find(|e| e.kind == StorageEntryKind::Directory && e.name.eq_ignore_ascii_case("DCIM"))
        {
            input.source = dcim.locator.clone();
        }
        let mut pending = vec![input.source.clone()];
        let mut groups = BTreeMap::<String, Vec<Scanned>>::new();
        let token = CancellationToken::new();
        let mut count = 0;
        while let Some(parent) = pending.pop() {
            let mut listing = source.open_listing(&parent).await?;
            loop {
                let entries = listing.next_batch(256).await?;
                if entries.is_empty() {
                    break;
                }
                for entry in entries {
                    count += 1;
                    if count > 100_000 {
                        return Err(invalid("来源目录超过 100000 项，请选择较小的照片目录"));
                    }
                    if entry.name.starts_with('.') {
                        continue;
                    }
                    if entry.kind == StorageEntryKind::Directory {
                        pending.push(entry.locator.clone());
                        continue;
                    }
                    if entry.kind != StorageEntryKind::File {
                        continue;
                    }
                    let Some(kind) = kind(&entry.name) else {
                        continue;
                    };
                    let relative = if input.source.logical_path.is_empty() {
                        entry.locator.logical_path.clone()
                    } else {
                        entry
                            .locator
                            .logical_path
                            .strip_prefix(&format!("{}/", input.source.logical_path))
                            .ok_or_else(|| invalid("来源目录返回了范围外的文件"))?
                            .to_string()
                    };
                    let (stem, _) = relative
                        .rsplit_once('.')
                        .ok_or_else(|| invalid("照片名称无效"))?;
                    let key = stem.to_ascii_lowercase();
                    let (_, hash) = file_digest(source.as_ref(), &entry, &token).await?;
                    let metadata = if kind.primary() {
                        metadata::read(source.as_ref(), &entry).await?
                    } else {
                        metadata::Metadata::default()
                    };
                    groups.entry(key).or_default().push(Scanned {
                        entry,
                        path: relative,
                        kind,
                        hash,
                        metadata,
                    });
                }
            }
        }
        let archive_id = match catalog
            .archives
            .iter()
            .find(|a| a.jpg == input.jpg && a.raw == input.raw)
        {
            Some(archive) => archive.id,
            None => {
                let id = Uuid::new_v4();
                catalog.archives.push(PhotoArchive {
                    id,
                    jpg: input.jpg.clone(),
                    raw: input.raw.clone(),
                });
                id
            }
        };
        let mut session = PhotoSession {
            directory: None,
            id: Uuid::new_v4(),
            archive_id,
            name: input.name.clone(),
            card_name: input.card_name.clone(),
            created_at: chrono::Utc::now().to_rfc3339(),
            source: Some(input.source.clone()),
            layout: input.layout,
            keep_hierarchy: input.keep_hierarchy,
            photo_ids: vec![],
            sources: vec![],
            revision: 1,
            synced_revision: 0,
            nas_hash: None,
            sync_error: None,
            handed_off: false,
            position: PhotoReviewPosition::default(),
            undo: vec![],
        };
        for files in groups
            .values()
            .filter(|files| files.iter().any(|f| f.kind.primary()))
        {
            let mut issues = Vec::new();
            for kind in [
                PhotoFileKind::Raw,
                PhotoFileKind::Jpg,
                PhotoFileKind::Xmp,
                PhotoFileKind::Acr,
            ] {
                if files.iter().filter(|f| f.kind == kind).count() > 1 {
                    return Err(conflict(format!(
                        "{}：同一目录存在多个同格式候选文件，请先整理来源",
                        files[0].path
                    )));
                }
            }
            let primary: Vec<_> = files.iter().filter(|f| f.kind.primary()).collect();
            let raw_meta = primary
                .iter()
                .find(|f| f.kind == PhotoFileKind::Raw)
                .map(|f| &f.metadata);
            let jpg_meta = primary
                .iter()
                .find(|f| f.kind == PhotoFileKind::Jpg)
                .map(|f| &f.metadata);
            if let Some((a, b)) = raw_meta.zip(jpg_meta) {
                if a.camera
                    .as_ref()
                    .zip(b.camera.as_ref())
                    .is_some_and(|(a, b)| a != b)
                    || a.time
                        .as_ref()
                        .zip(b.time.as_ref())
                        .is_some_and(|(a, b)| a != b)
                {
                    issues.push("NEF/JPG 拍摄时间或相机不一致，请确认配对".into());
                }
            }
            let time = raw_meta
                .and_then(|m| m.time.as_ref())
                .or_else(|| jpg_meta.and_then(|m| m.time.as_ref()));
            let mut date = time.map(|t| metadata::date(t));
            if let Some(override_date) = &input.date_override {
                let date_conflict = raw_meta.zip(jpg_meta).is_some_and(|(a, b)| {
                    a.time
                        .as_ref()
                        .zip(b.time.as_ref())
                        .is_some_and(|(a, b)| metadata::date(a) != metadata::date(b))
                });
                if date.is_none() || date_conflict {
                    date = Some(override_date.clone());
                }
                // A date override resolves absent/different dates, never camera or time-of-day conflicts.
                if let Some((a, b)) = raw_meta.zip(jpg_meta) {
                    let camera_conflict = a
                        .camera
                        .as_ref()
                        .zip(b.camera.as_ref())
                        .is_some_and(|(a, b)| a != b);
                    let time_conflict = a
                        .time
                        .as_ref()
                        .zip(b.time.as_ref())
                        .is_some_and(|(a, b)| a[11..] != b[11..]);
                    if !camera_conflict && !time_conflict {
                        issues.clear();
                    }
                }
            }
            if date.is_none() {
                issues.push("缺少有效拍摄日期，请指定日期或排除此照片".into());
            }
            let candidates: Vec<_> = catalog
                .photos
                .iter()
                .enumerate()
                .filter(|(_, p)| {
                    p.archive_id == archive_id
                        && primary.iter().any(|f| {
                            p.files
                                .iter()
                                .any(|old| old.kind == f.kind && old.sha256 == f.hash)
                        })
                        && primary.iter().all(|f| {
                            p.files
                                .iter()
                                .find(|old| old.kind == f.kind)
                                .is_none_or(|old| old.sha256 == f.hash)
                        })
                })
                .map(|(i, _)| i)
                .collect();
            if candidates.len() > 1 {
                return Err(conflict("相同内容关联了多个旧照片，请先处理已有批次"));
            }
            let photo_index = if let Some(&index) = candidates.first() {
                index
            } else {
                let directory = group_directory(&input, date.as_deref(), &files[0].path);
                let stem = files[0].entry.name.rsplit_once('.').unwrap().0;
                let mut number = 1u32;
                let targets = loop {
                    let stem = if number == 1 {
                        stem.to_string()
                    } else {
                        format!("{stem}_{number}")
                    };
                    let mut paths = Vec::new();
                    let mut collision = false;
                    for file in files {
                        let extension = file.entry.name.rsplit_once('.').unwrap().1;
                        let path = [directory.as_str(), &format!("{stem}.{extension}")]
                            .into_iter()
                            .filter(|s| !s.is_empty())
                            .collect::<Vec<_>>()
                            .join("/");
                        if catalog
                            .photos
                            .iter()
                            .filter(|p| p.archive_id == archive_id)
                            .flat_map(|p| &p.files)
                            .any(|f| {
                                f.kind.root() == file.kind.root()
                                    && f.path.eq_ignore_ascii_case(&path)
                            })
                        {
                            collision = true;
                            break;
                        }
                        let backend = if file.kind == PhotoFileKind::Jpg {
                            jpg.as_ref()
                        } else {
                            raw.as_ref()
                        };
                        let root = if file.kind == PhotoFileKind::Jpg {
                            &input.jpg
                        } else {
                            &input.raw
                        };
                        if let Some(entry) = existing(backend, &child(root, &path)?).await? {
                            if entry.kind != StorageEntryKind::File
                                || file_digest(backend, &entry, &token).await?.1 != file.hash
                            {
                                collision = true;
                                break;
                            }
                        }
                        paths.push(path);
                    }
                    // Reserve absent companions too, including existing external sidecars.
                    if !collision {
                        for (root, backend, extensions) in [
                            (
                                &input.raw,
                                raw.as_ref(),
                                &["NEF", "nef", "xmp", "XMP", "acr", "ACR"][..],
                            ),
                            (
                                &input.jpg,
                                jpg.as_ref(),
                                &["JPG", "jpg", "JPEG", "jpeg"][..],
                            ),
                        ] {
                            for ext in extensions {
                                let path = format!(
                                    "{}{stem}.{ext}",
                                    if directory.is_empty() {
                                        String::new()
                                    } else {
                                        format!("{directory}/")
                                    }
                                );
                                if paths.iter().any(|p| p.eq_ignore_ascii_case(&path)) {
                                    continue;
                                }
                                if catalog
                                    .photos
                                    .iter()
                                    .filter(|p| p.archive_id == archive_id)
                                    .flat_map(|p| &p.files)
                                    .any(|f| f.path.eq_ignore_ascii_case(&path))
                                    || existing(backend, &child(root, &path)?).await?.is_some()
                                {
                                    collision = true;
                                    break;
                                }
                            }
                            if collision {
                                break;
                            }
                        }
                    }
                    if !collision {
                        break paths;
                    }
                    number += 1;
                    if number > 10_000 {
                        return Err(conflict("同名照片过多，请调整整理方式"));
                    }
                };
                let photo = Photo {
                    id: Uuid::new_v4(),
                    archive_id,
                    original_path: files[0].path.clone(),
                    capture_date: date,
                    issues,
                    files: files
                        .iter()
                        .zip(targets)
                        .map(|(f, path)| PhotoFile {
                            id: Uuid::new_v4(),
                            kind: f.kind,
                            original_name: f.entry.name.clone(),
                            path,
                            sha256: f.hash.clone(),
                            size: f.entry.size.unwrap_or(0),
                            verified: false,
                            error: None,
                            observed_revision: None,
                        })
                        .collect(),
                    rating: 0,
                    flag: PhotoFlag::None,
                    excluded: false,
                    revision: 0,
                    xmp_hash: files
                        .iter()
                        .find(|f| f.kind == PhotoFileKind::Xmp)
                        .map(|f| f.hash.clone()),
                    xmp_synced_revision: None,
                };
                catalog.photos.push(photo);
                catalog.photos.len() - 1
            };
            let photo = &mut catalog.photos[photo_index];
            for file in files {
                let member = if let Some(member) = photo.files.iter().find(|f| f.kind == file.kind)
                {
                    if member.sha256 != file.hash && !file.kind.primary() {
                        return Err(conflict(format!(
                            "{}：附属文件与已有归档不同，已保留双方，请先核对",
                            file.path
                        )));
                    }
                    member.id
                } else {
                    let anchor = &photo.files[0].path;
                    let stem = anchor.rsplit_once('.').unwrap().0;
                    let extension = file.entry.name.rsplit_once('.').unwrap().1;
                    let path = format!("{stem}.{extension}");
                    let backend = if file.kind == PhotoFileKind::Jpg {
                        jpg.as_ref()
                    } else {
                        raw.as_ref()
                    };
                    let root = if file.kind == PhotoFileKind::Jpg {
                        &input.jpg
                    } else {
                        &input.raw
                    };
                    if let Some(entry) = existing(backend, &child(root, &path)?).await? {
                        if file_digest(backend, &entry, &token).await?.1 != file.hash {
                            return Err(conflict("补齐文件的目标位置已被不同内容占用，请先核对"));
                        }
                    }
                    let id = Uuid::new_v4();
                    if file.kind == PhotoFileKind::Xmp {
                        photo.xmp_hash = Some(file.hash.clone());
                    }
                    photo.files.push(PhotoFile {
                        id,
                        kind: file.kind,
                        original_name: file.entry.name.clone(),
                        path,
                        sha256: file.hash.clone(),
                        size: file.entry.size.unwrap_or(0),
                        verified: false,
                        error: None,
                        observed_revision: None,
                    });
                    id
                };
                session.sources.push(PhotoSource {
                    file_id: member,
                    path: file.path.clone(),
                });
            }
            if !session.photo_ids.contains(&photo.id) {
                session.photo_ids.push(photo.id);
            }
        }
        if session.photo_ids.is_empty() {
            return Err(invalid("所选目录没有 NEF 或 JPG 照片"));
        }
        catalog.preset = Some(input);
        catalog.sessions.push(session.clone());
        self.save_photos(revision, &catalog).await?;
        Ok(session)
    }

    pub async fn photo_exclude(
        &self,
        session_id: Uuid,
        photo_id: Uuid,
        excluded: bool,
    ) -> StorageResult<()> {
        let _guard = self.photo_lock.lock().await;
        let (revision, mut catalog) = self.load_photos().await?;
        if !catalog.sessions[session_index(&catalog, session_id)?]
            .photo_ids
            .contains(&photo_id)
        {
            return Err(invalid("照片不属于此批次"));
        }
        let photo = catalog
            .photos
            .iter_mut()
            .find(|p| p.id == photo_id)
            .ok_or_else(|| invalid("未找到照片"))?;
        photo.excluded = excluded;
        touch(&mut catalog, photo_id);
        self.save_photos(revision, &catalog).await
    }

    pub async fn photo_resolve_date(&self, session_id: Uuid, date: String) -> StorageResult<()> {
        if date.len() != 10 || chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").is_err() {
            return Err(invalid("拍摄日期无效"));
        }
        // Plans are immutable. Regenerate an untouched plan to show the real new paths.
        let _guard = self.photo_lock.lock().await;
        let (revision, mut catalog) = self.load_photos().await?;
        let index = session_index(&catalog, session_id)?;
        let ids = catalog.sessions[index].photo_ids.clone();
        for photo in catalog
            .photos
            .iter_mut()
            .filter(|p| ids.contains(&p.id) && !p.excluded && !p.issues.is_empty())
        {
            if photo.files.iter().any(|f| f.verified) {
                return Err(conflict("此照片已开始归档，不能修改导入计划"));
            }
            if photo.issues.iter().any(|i| i.contains("配对")) {
                return Err(conflict("配对矛盾需要先检查来源文件；可先排除此照片"));
            }
            for file in &mut photo.files {
                if catalog.sessions[index].layout == PhotoLayout::Date {
                    file.path =
                        file.path
                            .replacen("未知拍摄日期", &format!("{}/{date}", &date[..4]), 1);
                }
            }
            photo.capture_date = Some(date.clone());
            photo.issues.clear();
        }
        // Recheck every destination and reservation before accepting changed paths.
        let archive = archive_for(&catalog, catalog.sessions[index].archive_id)?;
        for photo in catalog
            .photos
            .iter()
            .filter(|p| ids.contains(&p.id) && !p.excluded)
        {
            let stem = photo.files[0]
                .path
                .rsplit_once('.')
                .ok_or_else(|| invalid("照片计划名称无效"))?
                .0;
            for (kind, extensions) in [
                (PhotoFileKind::Raw, &["NEF", "nef"][..]),
                (PhotoFileKind::Jpg, &["JPG", "jpg", "JPEG", "jpeg"][..]),
                (PhotoFileKind::Xmp, &["xmp", "XMP"][..]),
                (PhotoFileKind::Acr, &["acr", "ACR"][..]),
            ] {
                for extension in extensions {
                    let path = format!("{stem}.{extension}");
                    if photo
                        .files
                        .iter()
                        .any(|f| f.kind == kind && f.path.eq_ignore_ascii_case(&path))
                    {
                        continue;
                    }
                    let root = if kind == PhotoFileKind::Jpg {
                        &archive.jpg
                    } else {
                        &archive.raw
                    };
                    let backend = self.backend(root.volume_id).await?;
                    if existing(backend.as_ref(), &child(root, &path)?)
                        .await?
                        .is_some()
                        || catalog
                            .photos
                            .iter()
                            .filter(|p| p.id != photo.id && p.archive_id == photo.archive_id)
                            .flat_map(|p| &p.files)
                            .any(|f| {
                                f.kind.root() == kind.root() && f.path.eq_ignore_ascii_case(&path)
                            })
                    {
                        return Err(conflict(
                            "指定日期后配对或旁车文件存在同名冲突，请重新扫描并指定日期",
                        ));
                    }
                }
            }
            for file in &photo.files {
                if catalog
                    .photos
                    .iter()
                    .filter(|p| p.id != photo.id && p.archive_id == photo.archive_id)
                    .flat_map(|p| &p.files)
                    .any(|f| {
                        f.kind.root() == file.kind.root() && f.path.eq_ignore_ascii_case(&file.path)
                    })
                {
                    return Err(conflict("指定日期后出现同名冲突，请重新扫描并指定日期"));
                }
                let backend = self.backend(file_target(archive, file)?.volume_id).await?;
                if let Some(entry) =
                    existing(backend.as_ref(), &file_target(archive, file)?).await?
                {
                    if file_digest(backend.as_ref(), &entry, &CancellationToken::new())
                        .await?
                        .1
                        != file.sha256
                    {
                        return Err(conflict(
                            "指定日期后目标已存在不同内容，请重新扫描并指定日期",
                        ));
                    }
                }
            }
        }
        catalog.sessions[index].revision += 1;
        self.save_photos(revision, &catalog).await
    }
}
