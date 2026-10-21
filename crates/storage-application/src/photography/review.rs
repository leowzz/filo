use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use image::ImageDecoder;

impl StorageService {
    pub async fn photo_mark(
        &self,
        session_id: Uuid,
        photo_id: Uuid,
        rating: u8,
        flag: PhotoFlag,
    ) -> StorageResult<Photo> {
        if rating > 5 {
            return Err(invalid("星级范围为 0–5"));
        }
        let _guard = self.photo_lock.lock().await;
        let _mutation = self.mutation_lock.read().await;
        let (revision, mut catalog) = self.load_photos().await?;
        let index = session_index(&catalog, session_id)?;
        if !catalog.sessions[index].photo_ids.contains(&photo_id) {
            return Err(invalid("照片不属于此批次"));
        }
        let archive = catalog.sessions[index]
            .directory
            .as_ref()
            .map(|_| archive_for(&catalog, catalog.sessions[index].archive_id).cloned())
            .transpose()?;
        let photo = catalog
            .photos
            .iter_mut()
            .find(|p| p.id == photo_id)
            .ok_or_else(|| invalid("未找到照片"))?;
        if photo.excluded {
            return Err(invalid("此照片已排除，请先恢复导入"));
        }
        let before = PhotoMark::from(&*photo);
        let after = PhotoMark { rating, flag };
        if before == after {
            return Ok(photo.clone());
        }
        photo.rating = rating;
        photo.flag = flag;
        photo.revision += 1;
        let mut result = photo.clone();
        let session = &mut catalog.sessions[index];
        session.undo.push(PhotoUndo {
            photo_id,
            before,
            after,
        });
        if session.undo.len() > 100 {
            session.undo.remove(0);
        }
        session.position.current = Some(photo_id);
        touch(&mut catalog, photo_id);
        if let Some(archive) = archive {
            self.save_directory_progress(&mut catalog).await?;
            result.xmp_hash = catalog
                .photos
                .iter()
                .find(|p| p.id == photo_id)
                .unwrap()
                .xmp_hash
                .clone();
            self.write_photo_mark(&archive, &mut result).await?;
            *catalog
                .photos
                .iter_mut()
                .find(|p| p.id == photo_id)
                .unwrap() = result.clone();
        }
        self.save_photos(revision, &catalog).await?;
        Ok(result)
    }

    pub async fn photo_undo(&self, session_id: Uuid) -> StorageResult<Option<Photo>> {
        let _guard = self.photo_lock.lock().await;
        let _mutation = self.mutation_lock.read().await;
        let (revision, mut catalog) = self.load_photos().await?;
        let index = session_index(&catalog, session_id)?;
        let Some(undo) = catalog.sessions[index].undo.pop() else {
            return Ok(None);
        };
        let archive = catalog.sessions[index]
            .directory
            .as_ref()
            .map(|_| archive_for(&catalog, catalog.sessions[index].archive_id).cloned())
            .transpose()?;
        let photo = catalog
            .photos
            .iter_mut()
            .find(|p| p.id == undo.photo_id)
            .ok_or_else(|| invalid("未找到撤销对应的照片"))?;
        if PhotoMark::from(&*photo) != undo.after {
            return Err(conflict("照片在其他批次已被修改，无法撤销旧操作"));
        }
        photo.rating = undo.before.rating;
        photo.flag = undo.before.flag;
        photo.revision += 1;
        let mut result = photo.clone();
        catalog.sessions[index].position.current = Some(photo.id);
        touch(&mut catalog, result.id);
        if let Some(archive) = archive {
            self.save_directory_progress(&mut catalog).await?;
            result.xmp_hash = catalog
                .photos
                .iter()
                .find(|p| p.id == result.id)
                .unwrap()
                .xmp_hash
                .clone();
            self.write_photo_mark(&archive, &mut result).await?;
            *catalog
                .photos
                .iter_mut()
                .find(|p| p.id == result.id)
                .unwrap() = result.clone();
        }
        self.save_photos(revision, &catalog).await?;
        Ok(Some(result))
    }

    pub async fn photo_save_position(
        &self,
        session_id: Uuid,
        mut position: PhotoReviewPosition,
    ) -> StorageResult<()> {
        let _guard = self.photo_lock.lock().await;
        let _mutation = self.mutation_lock.read().await;
        let (revision, mut catalog) = self.load_photos().await?;
        let index = session_index(&catalog, session_id)?;
        if position
            .current
            .is_some_and(|id| !catalog.sessions[index].photo_ids.contains(&id))
        {
            return Err(invalid("当前位置不属于此批次"));
        }
        if !["", "all", "none", "pick", "reject"].contains(&position.filter.as_str()) {
            position.filter = "all".into();
        }
        position.minimum_rating = position.minimum_rating.min(5);
        catalog.sessions[index].position = position;
        catalog.sessions[index].revision += 1;
        self.save_photos(revision, &catalog).await
    }

    pub async fn photo_focus(&self, photo_id: Uuid) -> StorageResult<Option<PhotoFocus>> {
        let catalog = self.photo_catalog().await?;
        let photo = catalog
            .photos
            .iter()
            .find(|p| p.id == photo_id)
            .ok_or_else(|| invalid("未找到照片"))?;
        let Some(file) = photo.files.iter().find(|f| {
            f.kind == PhotoFileKind::Raw
                && (self.photo_review_workspace || f.verified)
                && f.path.to_ascii_lowercase().ends_with(".nef")
        }) else {
            return Ok(None);
        };
        let _mutation = self.mutation_lock.read().await;
        let target = file_target(archive_for(&catalog, photo.archive_id)?, file)?;
        let backend = self.backend(target.volume_id).await?;
        let entry = backend.stat(&target).await?;
        crate::browsing::nef::focus(backend.as_ref(), &entry, &self.nef_previews).await
    }

    pub async fn photo_preview(
        &self,
        photo_id: Uuid,
        original: bool,
        thumbnail: bool,
        raw_only: bool,
    ) -> StorageResult<PhotoPreview> {
        let catalog = self.photo_catalog().await?;
        let photo = catalog
            .photos
            .iter()
            .find(|p| p.id == photo_id)
            .ok_or_else(|| invalid("未找到照片"))?;
        let archive = archive_for(&catalog, photo.archive_id)?;
        let file = photo
            .files
            .iter()
            .find(|f| {
                !raw_only
                    && f.kind == PhotoFileKind::Jpg
                    && (self.photo_review_workspace || f.verified)
            })
            .or_else(|| {
                photo.files.iter().find(|f| {
                    f.kind == PhotoFileKind::Raw && (self.photo_review_workspace || f.verified)
                })
            })
            .ok_or_else(|| {
                invalid(if raw_only {
                    "此照片没有可查看的 RAW 文件"
                } else {
                    "照片尚未归档，请先完成导入"
                })
            })?;
        let slots = if thumbnail {
            &self.thumbnail_slots
        } else {
            &self.preview_slots
        };
        let _mutation = self.mutation_lock.read().await;
        let target = file_target(archive, file)?;
        let backend = self.backend(target.volume_id).await?;
        let file = if thumbnail && backend.is_remote() {
            photo
                .files
                .iter()
                .find(|f| {
                    f.kind == PhotoFileKind::Raw && (self.photo_review_workspace || f.verified)
                })
                .unwrap_or(file)
        } else {
            file
        };
        let target = file_target(archive, file)?;
        let backend = if backend.volume_id() == target.volume_id {
            backend
        } else {
            self.backend(target.volume_id).await?
        };
        let entry = backend.stat(&target).await?;
        let variant = format!("photo:{original}:{thumbnail}");
        let cache_key = crate::preview_cache::key(&entry, &variant);
        if let (Some(cache), Some(key)) = (&self.preview_cache, &cache_key) {
            if let Some(preview) = cache.get(key).await {
                return Ok(preview);
            }
        }
        let embedded = file.kind == PhotoFileKind::Raw;
        let mut cached_source: Option<PhotoPreview> = None;
        if thumbnail && backend.is_remote() {
            if let Some(cache) = &self.preview_cache {
                for variant in ["photo:false:false", "photo:true:false"] {
                    if let Some(key) = crate::preview_cache::key(&entry, variant) {
                        cached_source = cache.get(&key).await;
                        if cached_source.is_some() {
                            break;
                        }
                    }
                }
            }
            if !embedded && cached_source.is_none() {
                return Err(StorageError::new(
                    StorageErrorCode::Unsupported,
                    "此文件需要完整下载才能生成缩略图",
                ));
            }
        }
        let _slot = slots
            .acquire()
            .await
            .map_err(|_| invalid("预览任务已停止"))?;
        let (bytes, orientation) = if let Some(preview) = cached_source {
            (
                STANDARD
                    .decode(&preview.content)
                    .map_err(|_| invalid("无法读取缩略图缓存"))?,
                image::metadata::Orientation::NoTransforms,
            )
        } else if embedded {
            crate::browsing::nef::load(backend.as_ref(), &entry, thumbnail, &self.nef_previews)
                .await?
        } else {
            if entry.kind != StorageEntryKind::File
                || entry.size.is_none_or(|s| s > 64 * 1024 * 1024)
            {
                return Err(invalid("JPG 超过 64 MiB 或不是普通文件，请使用 LRC 打开"));
            }
            let mut reader = backend.open_read(&target).await?.take(64 * 1024 * 1024 + 1);
            let mut bytes = vec![];
            reader.read_to_end(&mut bytes).await.map_err(io_error)?;
            if bytes.len() > 64 * 1024 * 1024 {
                return Err(invalid("JPG 超过 64 MiB，请使用 LRC 打开"));
            }
            (bytes, image::metadata::Orientation::NoTransforms)
        };
        let preview = tokio::task::spawn_blocking(move || {
            let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
                .with_guessed_format()
                .map_err(|_| invalid("无法识别照片预览"))?;
            let mut limits = image::Limits::default();
            limits.max_alloc = Some(512 * 1024 * 1024);
            limits.max_image_width = Some(24000);
            limits.max_image_height = Some(24000);
            reader.limits(limits);
            let mut decoder = reader
                .into_decoder()
                .map_err(|_| invalid("照片预览损坏或过大"))?;
            let orientation = if embedded {
                orientation
            } else {
                decoder.orientation().unwrap_or(orientation)
            };
            let mut image = image::DynamicImage::from_decoder(decoder)
                .map_err(|_| invalid("无法解码照片预览"))?;
            image.apply_orientation(orientation);
            if thumbnail {
                image = image.thumbnail(160, 160);
            } else if !original {
                image = image.thumbnail(2400, 2400);
            }
            let (width, height) = (image.width(), image.height());
            let mut output = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 88)
                .encode_image(&image)
                .map_err(|_| invalid("无法生成照片预览"))?;
            Ok(PhotoPreview {
                mime: "image/jpeg".into(),
                content: STANDARD.encode(output),
                width,
                height,
                embedded,
            })
        })
        .await
        .map_err(|_| invalid("照片预览任务中断"))??;
        if let (Some(cache), Some(key)) = (&self.preview_cache, cache_key) {
            if backend
                .stat(&target)
                .await
                .ok()
                .and_then(|current| crate::preview_cache::key(&current, &variant))
                == Some(key.clone())
            {
                cache.put(key, preview.clone()).await;
            }
        }
        Ok(preview)
    }
}
