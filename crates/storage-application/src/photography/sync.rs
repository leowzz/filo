use super::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub(super) const MANIFEST_LIMIT: u64 = 64 * 1024 * 1024;
pub(super) const DIRECTORY_PROGRESS: &str = ".filo/review.json";
#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
pub(super) struct DirectoryProgress {
    pub sort: PhotoSort,
    pub current: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_export: Option<PhotoExport>,
}
#[derive(Serialize, Deserialize)]
pub(super) struct Manifest {
    pub schema: u32,
    pub session: PhotoSession,
    pub photos: Vec<Photo>,
}

pub(super) async fn read_document(
    backend: &dyn StorageBackend,
    locator: &StorageLocator,
    limit: u64,
) -> StorageResult<Option<(StorageEntry, Vec<u8>)>> {
    let Some(entry) = existing(backend, locator).await? else {
        return Ok(None);
    };
    if entry.kind != StorageEntryKind::File || entry.size.is_none_or(|size| size > limit) {
        return Err(invalid("元数据文件过大或不是普通文件，已保留原文件"));
    }
    let mut reader = backend.open_read(locator).await?.take(limit + 1);
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).await.map_err(io_error)?;
    if bytes.len() as u64 > limit
        || !crate::browsing::nef::same_file(&entry, &backend.stat(locator).await?)
    {
        return Err(conflict("读取时元数据文件发生变化，请重试"));
    }
    Ok(Some((entry, bytes)))
}

pub(super) async fn write_document(
    backend: &dyn StorageBackend,
    target: &StorageLocator,
    expected: Option<&StorageEntry>,
    bytes: &[u8],
) -> StorageResult<()> {
    ensure_parent(backend, target).await?;
    let mut writer = match expected {
        Some(entry) => backend.stage_replace(entry).await?,
        None => backend.stage_write(target).await?,
    };
    writer.write(bytes).await?;
    if !writer.verifies_on_commit()
        && digest(writer.reader().await?, &CancellationToken::new()).await?
            != (bytes.len() as u64, bytes_hash(bytes))
    {
        return Err(conflict("元数据校验失败，原文件已保留"));
    }
    writer.commit().await
}

fn manifest(catalog: &PhotoCatalog, session: &PhotoSession) -> Manifest {
    let mut session = session.clone();
    session.source = None;
    session.directory = None;
    session.nas_hash = None;
    session.sync_error = None;
    session.synced_revision = session.revision;
    let photos = catalog
        .photos
        .iter()
        .filter(|p| session.photo_ids.contains(&p.id))
        .cloned()
        .collect();
    Manifest {
        schema: 1,
        session,
        photos,
    }
}

pub(super) fn validate(manifest: &Manifest, review: bool) -> StorageResult<()> {
    let session = &manifest.session;
    if manifest.schema != 1
        || manifest.photos.len() > 100_000
        || session.photo_ids.len() != manifest.photos.len()
    {
        return Err(invalid("批次清单版本或照片数量无效"));
    }
    let mut ids = HashSet::new();
    let mut files = HashSet::new();
    let mut paths = HashSet::new();
    for photo in &manifest.photos {
        if photo.archive_id != session.archive_id
            || photo.rating > 5
            || !ids.insert(photo.id)
            || !session.photo_ids.contains(&photo.id)
            || photo.files.is_empty()
            || photo.files.len() > 4
        {
            return Err(invalid("批次清单照片关系无效"));
        }
        for file in &photo.files {
            if !files.insert(file.id)
                || !paths.insert((file.kind.root(), file.path.to_ascii_lowercase()))
                || file.path.is_empty()
                || normalize_path(&file.path)? != file.path
                || (!review || !file.sha256.is_empty()) && file.sha256.len() != 64
                || !file.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err(invalid("批次清单文件路径或内容摘要无效"));
            }
        }
    }
    for source in &session.sources {
        if !files.contains(&source.file_id)
            || source.path.is_empty()
            || normalize_path(&source.path)? != source.path
        {
            return Err(invalid("批次清单来源关系无效"));
        }
    }
    if session.undo.len() > 100
        || session
            .undo
            .iter()
            .any(|u| !ids.contains(&u.photo_id) || u.before.rating > 5 || u.after.rating > 5)
        || session
            .position
            .current
            .is_some_and(|id| !ids.contains(&id))
    {
        return Err(invalid("批次清单审图状态无效"));
    }
    Ok(())
}

impl StorageService {
    // Only directory order and browsing position belong in the progress file.
    // Photo marks are committed separately to their XMP sidecars.
    pub(super) async fn save_directory_progress(
        &self,
        catalog: &mut PhotoCatalog,
    ) -> StorageResult<()> {
        for index in 0..catalog.sessions.len() {
            let Some(root) = catalog.sessions[index].directory.clone() else {
                continue;
            };
            if catalog.sessions[index].synced_revision == catalog.sessions[index].revision
                && catalog.sessions[index].nas_hash.is_some()
            {
                continue;
            }
            let session = &catalog.sessions[index];
            let snapshot = DirectoryProgress {
                sort: session.position.sort,
                last_export: session.last_export.clone(),
                current: session.position.current.and_then(|id| {
                    catalog
                        .photos
                        .iter()
                        .find(|p| p.id == id)
                        .map(|p| p.original_path.clone())
                }),
            };
            let bytes =
                serde_json::to_vec_pretty(&snapshot).map_err(|_| invalid("无法保存审图进度"))?;
            if bytes.len() as u64 > MANIFEST_LIMIT {
                return Err(invalid("审图记录超过 64 MiB，请分组处理"));
            }
            let desired = bytes_hash(&bytes);
            if catalog.sessions[index].nas_hash.as_deref() == Some(&desired) {
                catalog.sessions[index].synced_revision = catalog.sessions[index].revision;
                catalog.sessions[index].sync_error = None;
                continue;
            }
            let backend = self.backend(root.volume_id).await?;
            let target = child(&root, DIRECTORY_PROGRESS)?;
            let before = read_document(backend.as_ref(), &target, MANIFEST_LIMIT).await?;
            let actual = before.as_ref().map(|(_, bytes)| bytes_hash(bytes));
            if actual != catalog.sessions[index].nas_hash && actual.as_deref() != Some(&desired) {
                return Err(conflict(
                    "目录中的审图进度已被其他窗口或电脑更新，请重新进入审图后重试",
                ));
            }
            if let Some((_, bytes)) = &before {
                let document: serde_json::Value = serde_json::from_slice(bytes)
                    .map_err(|_| invalid("目录中的审图记录损坏，已保留原文件"))?;
                if document.get("session").is_some() {
                    let mut legacy: Manifest = serde_json::from_value(document)
                        .map_err(|_| invalid("目录中的审图记录无效，已保留原文件"))?;
                    let migrated = self.migrate_directory_marks(&root, &mut legacy).await?;
                    let archive = catalog.sessions[index].archive_id;
                    let by_path: HashMap<_, _> = catalog
                        .photos
                        .iter()
                        .enumerate()
                        .filter(|(_, p)| p.archive_id == archive)
                        .flat_map(|(index, p)| {
                            p.files
                                .iter()
                                .filter(|file| file.kind.primary())
                                .map(move |file| (file.path.clone(), index))
                        })
                        .collect();
                    for photo in migrated {
                        if let Some(&index) = by_path.get(&photo.original_path) {
                            let cached = &mut catalog.photos[index];
                            cached.xmp_hash = photo.xmp_hash;
                            cached.xmp_synced_revision = photo.xmp_synced_revision;
                        }
                    }
                }
            }
            if actual.as_deref() != Some(&desired) {
                write_document(
                    backend.as_ref(),
                    &target,
                    before.as_ref().map(|(entry, _)| entry),
                    &bytes,
                )
                .await?;
            }
            let session = &mut catalog.sessions[index];
            session.nas_hash = Some(desired);
            session.synced_revision = session.revision;
            session.sync_error = None;
        }
        Ok(())
    }

    pub async fn photo_sync(&self, session_id: Uuid) -> StorageResult<()> {
        let _sync = self.photo_sync_lock.lock().await;
        let result = self.sync_photos(session_id).await;
        if let Err(error) = &result {
            let _guard = self.photo_lock.lock().await;
            let (revision, mut catalog) = self.load_photos().await?;
            let index = session_index(&catalog, session_id)?;
            catalog.sessions[index].sync_error = Some(error.message.clone());
            self.save_photos(revision, &catalog).await?;
        }
        result
    }

    async fn sync_photos(&self, session_id: Uuid) -> StorageResult<()> {
        // Snapshot locally, then release the journal lock before doing NAS I/O.
        // Review saves remain responsive while the NAS is slow or disconnected.
        let (snapshot, archive, directory) = {
            let _guard = self.photo_lock.lock().await;
            let (revision, catalog) = self.load_photos().await?;
            let session = &catalog.sessions[session_index(&catalog, session_id)?];
            if session.directory.is_some() {
                return self.save_photos(revision, &catalog).await;
            }
            (
                manifest(&catalog, session),
                archive_for(&catalog, session.archive_id)?.clone(),
                session.directory.clone(),
            )
        };
        let _mutation = self.mutation_lock.read().await;
        let root = directory.as_ref().unwrap_or(&archive.raw);
        let backend = self.backend(root.volume_id).await?;
        let target = child(
            root,
            &if directory.is_some() {
                DIRECTORY_PROGRESS.into()
            } else {
                format!("{}/{session_id}.json", self.manifest_directory())
            },
        )?;
        let before = read_document(backend.as_ref(), &target, MANIFEST_LIMIT).await?;
        let expected_hash = {
            let catalog = self.photo_catalog().await?;
            catalog.sessions[session_index(&catalog, session_id)?]
                .nas_hash
                .clone()
        };
        let actual_hash = before.as_ref().map(|(_, bytes)| bytes_hash(bytes));
        let bytes =
            serde_json::to_vec_pretty(&snapshot).map_err(|_| invalid("无法生成批次清单"))?;
        let desired_hash = bytes_hash(&bytes);
        if bytes.len() as u64 > MANIFEST_LIMIT {
            return Err(invalid("审图或拷卡清单超过 64 MiB，请分组处理"));
        }
        if actual_hash != expected_hash && actual_hash.as_deref() != Some(&desired_hash) {
            // Local pending work remains in SQLite and as a separate portable conflict copy.
            let copy = child(
                &archive.raw,
                &format!(
                    "{}/{session_id}.local-conflict-{}.json",
                    self.manifest_directory(),
                    Uuid::new_v4()
                ),
            )?;
            write_document(backend.as_ref(), &copy, None, &bytes).await?;
            return Err(conflict(
                "NAS 批次记录已被其他电脑更新。两份记录均已保留，请先核对后恢复 NAS 批次",
            ));
        }
        if actual_hash.as_deref() != Some(&desired_hash) {
            write_document(
                backend.as_ref(),
                &target,
                before.as_ref().map(|(entry, _)| entry),
                &bytes,
            )
            .await?;
        }
        let _guard = self.photo_lock.lock().await;
        let (revision, mut catalog) = self.load_photos().await?;
        let index = session_index(&catalog, session_id)?;
        let session = &mut catalog.sessions[index];
        session.nas_hash = Some(bytes_hash(&bytes));
        session.synced_revision = snapshot.session.revision;
        session.sync_error = None;
        self.save_photos(revision, &catalog).await
    }

    pub async fn photo_restore(
        &self,
        jpg: StorageLocator,
        raw: StorageLocator,
    ) -> StorageResult<usize> {
        let _sync = self.photo_sync_lock.lock().await;
        let _guard = self.photo_lock.lock().await;
        let _mutation = self.mutation_lock.read().await;
        let (revision, mut catalog) = self.load_photos().await?;
        let volumes = self.repository.list_volumes().await?;
        for root in [&jpg, &raw] {
            if !volumes.iter().any(|v| {
                v.id == root.volume_id && !v.read_only && matches!(v.root, VolumeRoot::Local { .. })
            }) {
                return Err(invalid("请关联可写的系统挂载 JPG/RAW 目录"));
            }
        }
        let backend = self.backend(raw.volume_id).await?;
        let jpg_backend = self.backend(jpg.volume_id).await?;
        if !self.photo_review_workspace {
            crate::tree::check_overlap(backend.as_ref(), jpg_backend.as_ref(), &raw, &jpg)?;
            crate::tree::check_overlap(jpg_backend.as_ref(), backend.as_ref(), &jpg, &raw)?;
        }
        let directory = child(&raw, self.manifest_directory())?;
        let mut manifests = Vec::new();
        for entry in backend.list(&directory).await? {
            let Some(id) = entry
                .name
                .strip_suffix(".json")
                .and_then(|s| Uuid::parse_str(s).ok())
            else {
                continue;
            };
            let Some((_, bytes)) =
                read_document(backend.as_ref(), &entry.locator, MANIFEST_LIMIT).await?
            else {
                continue;
            };
            let mut manifest: Manifest = serde_json::from_slice(&bytes)
                .map_err(|_| invalid(format!("{}：批次清单损坏，未导入任何记录", entry.name)))?;
            validate(&manifest, self.photo_review_workspace)?;
            if id != manifest.session.id {
                return Err(invalid("批次文件名与清单 ID 不一致"));
            }
            manifest.session.source = None;
            manifest.session.nas_hash = Some(bytes_hash(&bytes));
            manifest.session.sync_error = None;
            manifest.session.synced_revision = manifest.session.revision;
            manifests.push(manifest);
        }
        // Validate every manifest before changing the local journal or root bindings.
        for manifest in &manifests {
            if let Some(local) = catalog
                .sessions
                .iter()
                .find(|s| s.id == manifest.session.id)
            {
                if local.revision != local.synced_revision {
                    return Err(conflict(
                        "本机还有未同步的审图记录，已保留；请先核对本机与 NAS 冲突",
                    ));
                }
            }
            for photo in &manifest.photos {
                if catalog
                    .photos
                    .iter()
                    .any(|p| p.id == photo.id && p.revision > photo.revision)
                {
                    return Err(conflict("本机照片有更新的审图记录，请先同步相关批次"));
                }
            }
        }
        let count = manifests.len();
        for manifest in manifests {
            let archive_id = manifest.session.archive_id;
            let archive = PhotoArchive {
                id: archive_id,
                jpg: jpg.clone(),
                raw: raw.clone(),
            };
            if let Some(old) = catalog.archives.iter_mut().find(|a| a.id == archive_id) {
                *old = archive;
            } else {
                catalog.archives.push(archive);
            }
            for photo in manifest.photos {
                if let Some(old) = catalog.photos.iter_mut().find(|p| p.id == photo.id) {
                    *old = photo;
                } else {
                    catalog.photos.push(photo);
                }
            }
            if let Some(old) = catalog
                .sessions
                .iter_mut()
                .find(|s| s.id == manifest.session.id)
            {
                *old = manifest.session;
            } else {
                catalog.sessions.push(manifest.session);
            }
        }
        self.save_photos(revision, &catalog).await?;
        Ok(count)
    }
}
