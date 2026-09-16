use crate::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, io::Cursor};
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

pub(super) struct SearchTask {
    state: Arc<Mutex<ContentSearch>>,
    token: CancellationToken,
    volume: Uuid,
}
fn error(message: &str) -> StorageError {
    StorageError::new(StorageErrorCode::Unsupported, message)
}

const UNSUPPORTED_PREVIEW: &str = "此文件暂不支持预览，请下载或使用系统应用打开";

fn known_binary(name: &str) -> bool {
    let extension = name
        .rsplit_once('.')
        .map(|(_, ext)| ext)
        .unwrap_or_default();
    matches!(
        extension,
        "dmg"
            | "iso"
            | "img"
            | "pkg"
            | "exe"
            | "msi"
            | "dll"
            | "so"
            | "dylib"
            | "zip"
            | "rar"
            | "7z"
            | "tar"
            | "gz"
            | "bz2"
            | "xz"
            | "zst"
            | "doc"
            | "docx"
            | "xls"
            | "xlsx"
            | "ppt"
            | "pptx"
            | "odt"
            | "ods"
            | "odp"
            | "mp3"
            | "mp4"
            | "m4a"
            | "mov"
            | "avi"
            | "mkv"
            | "wav"
            | "flac"
            | "sqlite"
            | "db"
            | "bin"
            | "woff"
            | "woff2"
            | "ttf"
            | "otf"
    )
}

async fn read_preview_bytes(
    reader: storage_provider_api::StorageReader,
    limit: u64,
    text: bool,
) -> StorageResult<Vec<u8>> {
    let mut reader = reader.take(limit + 1);
    let mut bytes = Vec::new();
    if !text {
        reader
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| error("无法读取预览内容"))?;
        return Ok(bytes);
    }
    let mut chunk = [0u8; 8192];
    loop {
        let count = reader
            .read(&mut chunk)
            .await
            .map_err(|_| error("无法读取预览内容"))?;
        if count == 0 {
            return Ok(bytes);
        }
        // Stop unknown binary files at the first binary chunk, not after 1 MiB.
        if chunk[..count].contains(&0) {
            return Err(error(UNSUPPORTED_PREVIEW));
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
}

impl StorageService {
    pub async fn preview_entry(
        &self,
        locator: StorageLocator,
        thumbnail: bool,
    ) -> StorageResult<Preview> {
        let name = locator
            .logical_path
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .to_lowercase();
        let is_image = [".png", ".jpg", ".jpeg", ".gif", ".webp"]
            .iter()
            .any(|ext| name.ends_with(ext));
        let is_pdf = name.ends_with(".pdf");
        // Reject known unsupported formats before queuing or making remote requests.
        if known_binary(&name) {
            return Err(error(UNSUPPORTED_PREVIEW));
        }
        if thumbnail && !is_image {
            return Err(error("此文件没有缩略图"));
        }
        let slots = if thumbnail {
            &self.thumbnail_slots
        } else {
            &self.preview_slots
        };
        let _slot = slots.acquire().await.map_err(|_| error("预览任务已停止"))?;
        let _guard = self.mutation_lock.read().await;
        let backend = self.backend(locator.volume_id).await?;
        let entry = backend.stat(&locator).await?;
        if entry.kind != StorageEntryKind::File {
            return Err(error("请选择普通文件进行预览"));
        }
        let limit = if is_image || is_pdf {
            20 * 1024 * 1024
        } else {
            1024 * 1024
        };
        if (is_image || is_pdf) && entry.size.unwrap_or(u64::MAX) > limit {
            return Err(error("图片或 PDF 超过 20 MiB，请下载或使用系统应用打开"));
        }
        let mut bytes = read_preview_bytes(
            backend.open_read(&locator).await?,
            limit,
            !is_image && !is_pdf,
        )
        .await?;
        let truncated = bytes.len() > limit as usize;
        if truncated && (is_image || is_pdf) {
            return Err(error("图片或 PDF 超过 20 MiB，请下载或使用系统应用打开"));
        }
        bytes.truncate(limit as usize);
        if is_image {
            let content = tokio::task::spawn_blocking(move || -> StorageResult<String> {
                let mut reader = image::ImageReader::new(Cursor::new(bytes))
                    .with_guessed_format()
                    .map_err(|_| error("图片格式无法识别"))?;
                let mut limits = image::Limits::default();
                limits.max_image_width = Some(16000);
                limits.max_image_height = Some(16000);
                limits.max_alloc = Some(128 * 1024 * 1024);
                reader.limits(limits);
                let image = reader
                    .decode()
                    .map_err(|_| error("图片损坏、过大或格式不受支持"))?;
                let image = if thumbnail {
                    image.thumbnail(80, 80)
                } else {
                    image.thumbnail(2400, 2400)
                };
                let mut output = Cursor::new(Vec::new());
                image
                    .write_to(&mut output, image::ImageFormat::Png)
                    .map_err(|_| error("无法生成图片预览"))?;
                Ok(STANDARD.encode(output.into_inner()))
            })
            .await
            .map_err(|_| error("预览任务中断"))??;
            return Ok(Preview {
                kind: "image".into(),
                mime: "image/png".into(),
                content,
                truncated: false,
            });
        }
        if is_pdf {
            if !bytes.starts_with(b"%PDF-") {
                return Err(error("PDF 文件格式无效"));
            }
            return Ok(Preview {
                kind: "pdf".into(),
                mime: "application/pdf".into(),
                content: STANDARD.encode(bytes),
                truncated: false,
            });
        }
        let content = String::from_utf8_lossy(&bytes).into_owned();
        Ok(Preview {
            kind: "text".into(),
            mime: "text/plain".into(),
            content,
            truncated,
        })
    }
    pub async fn directory_stamp(&self, parent: StorageLocator) -> StorageResult<String> {
        let _guard = self.mutation_lock.read().await;
        let backend = self.backend(parent.volume_id).await?;
        let mut reader = backend.open_listing(&parent).await?;
        // Order independent fingerprint: providers need not enumerate in the same order.
        let mut sum = [0u8; 32];
        let mut count = 0u64;
        loop {
            let entries = reader.next_batch(500).await?;
            if entries.is_empty() {
                break;
            }
            for entry in entries {
                let digest = Sha256::digest(
                    serde_json::to_vec(&entry).map_err(|_| error("无法检查目录变化"))?,
                );
                for (i, b) in digest.iter().enumerate() {
                    sum[i] = sum[i].wrapping_add(*b);
                }
                count += 1;
            }
        }
        Ok(format!("{count}:{}", STANDARD.encode(sum)))
    }
    pub async fn start_content_search(
        &self,
        parent: StorageLocator,
        query: String,
        show_hidden: bool,
    ) -> StorageResult<Uuid> {
        if query.trim().is_empty() || query.len() > 1024 {
            return Err(error("搜索内容需为 1–1024 字节"));
        }
        self.backend(parent.volume_id).await?.stat(&parent).await?;
        let mut searches = self.searches.lock().await;
        if searches.len() >= 4 {
            for task in searches.values() {
                task.token.cancel();
            }
            searches.clear();
        }
        let id = Uuid::new_v4();
        let token = CancellationToken::new();
        let state = Arc::new(Mutex::new(ContentSearch {
            id,
            ..Default::default()
        }));
        searches.insert(
            id,
            SearchTask {
                state: state.clone(),
                token: token.clone(),
                volume: parent.volume_id,
            },
        );
        let service = self.clone();
        tokio::spawn(async move {
            let result = crate::catch_panic(service.search_contents(
                parent,
                query,
                show_hidden,
                &token,
                &state,
            ))
            .await;
            let mut state = state.lock().await;
            if let Err(error) = result {
                state.errors.push(error.message);
            }
            state.done = true;
            state.cancelled = token.is_cancelled();
        });
        Ok(id)
    }
    pub async fn content_search_status(
        &self,
        id: Uuid,
        cancel: bool,
    ) -> StorageResult<ContentSearch> {
        let tasks = self.searches.lock().await;
        let task = tasks
            .get(&id)
            .ok_or_else(|| error("搜索已过期，请重新开始"))?;
        self.backend(task.volume).await?;
        if cancel {
            task.token.cancel();
        }
        let snapshot = task.state.lock().await.clone();
        Ok(snapshot)
    }
    async fn search_contents(
        &self,
        parent: StorageLocator,
        query: String,
        show_hidden: bool,
        token: &CancellationToken,
        state: &Arc<Mutex<ContentSearch>>,
    ) -> StorageResult<()> {
        let _guard = self.mutation_lock.read().await;
        let backend = self.backend(parent.volume_id).await?;
        let mut stack = vec![parent];
        let mut seen = HashSet::new();
        let needle = query.as_bytes().to_ascii_lowercase();
        while let Some(dir) = stack.pop() {
            if token.is_cancelled() {
                break;
            }
            if !seen.insert(dir.logical_path.clone()) {
                continue;
            }
            let mut reader = match backend.open_listing(&dir).await {
                Ok(r) => r,
                Err(e) => {
                    let mut s = state.lock().await;
                    if s.errors.len() < 10 {
                        s.errors
                            .push(format!("{}：{}", dir.logical_path, e.message));
                    }
                    continue;
                }
            };
            loop {
                let batch = tokio::select! { _=token.cancelled()=>return Ok(()),result=reader.next_batch(200)=>result?};
                if batch.is_empty() {
                    break;
                }
                for entry in batch {
                    if token.is_cancelled() {
                        return Ok(());
                    }
                    if !show_hidden && entry.name.starts_with('.') {
                        continue;
                    }
                    if crate::tree::directory(&entry) {
                        stack.push(entry.locator.clone());
                        if stack.len() + seen.len() > 100000 {
                            state.lock().await.limited = true;
                            return Ok(());
                        }
                        continue;
                    }
                    if entry.kind != StorageEntryKind::File {
                        state.lock().await.skipped += 1;
                        continue;
                    }
                    let result = tokio::select! {_=token.cancelled()=>return Ok(()),r=search_file(backend.as_ref(),&entry,&needle)=>r};
                    let mut s = state.lock().await;
                    s.scanned += 1;
                    match result {
                        Ok(Some((line, snippet))) => s.hits.push(SearchHit {
                            entry,
                            line,
                            snippet,
                        }),
                        Ok(None) => {}
                        Err(e) => {
                            s.skipped += 1;
                            if e.code != StorageErrorCode::Unsupported && s.errors.len() < 10 {
                                s.errors.push(format!("{}：{}", entry.name, e.message));
                            }
                        }
                    }
                    if s.hits.len() >= 1000 || s.scanned >= 100000 {
                        s.limited = true;
                        return Ok(());
                    }
                }
            }
        }
        Ok(())
    }
}
async fn search_file(
    backend: &dyn StorageBackend,
    entry: &StorageEntry,
    needle: &[u8],
) -> StorageResult<Option<(u64, String)>> {
    let mut reader = backend.open_read(&entry.locator).await?;
    let mut buffer = vec![0u8; 64 * 1024];
    let mut tail = Vec::new();
    let mut line = 1u64;
    loop {
        let count = reader
            .read(&mut buffer)
            .await
            .map_err(|_| StorageError::new(StorageErrorCode::Io, "读取内容失败"))?;
        if count == 0 {
            return Ok(None);
        }
        if buffer[..count].contains(&0) {
            return Err(error("已跳过二进制文件"));
        }
        tail.extend_from_slice(&buffer[..count]);
        let lower = tail.to_ascii_lowercase();
        if let Some(at) = lower.windows(needle.len()).position(|part| part == needle) {
            let line = line + tail[..at].iter().filter(|&&b| b == b'\n').count() as u64;
            let snippet = String::from_utf8_lossy(
                &tail[at.saturating_sub(80)..(at + needle.len() + 160).min(tail.len())],
            )
            .replace(['\r', '\n'], " ");
            return Ok(Some((line, snippet)));
        }
        let keep = (needle.len() - 1).min(tail.len());
        let drain = tail.len() - keep;
        line += tail[..drain].iter().filter(|&&b| b == b'\n').count() as u64;
        tail.drain(..drain);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn unsupported_preview_skips_queue_and_backend_access() {
        let db = tempfile::tempdir().unwrap();
        let service = StorageService::new(
            Repository::open(&db.path().join("test.sqlite"))
                .await
                .unwrap(),
        );
        let _busy = service.preview_slots.acquire_many(2).await.unwrap();
        // No such volume exists: any stat/read would fail instead of classifying the file.
        for path in ["installer.DMG", "archive.zip", "slides.pptx", "movie.mp4"] {
            let result = tokio::time::timeout(
                std::time::Duration::from_millis(100),
                service.preview_entry(
                    StorageLocator {
                        volume_id: Uuid::new_v4(),
                        logical_path: path.into(),
                        version_id: None,
                    },
                    false,
                ),
            )
            .await
            .unwrap()
            .err()
            .unwrap();
            assert_eq!(result.code, StorageErrorCode::Unsupported);
            assert_eq!(result.message, UNSUPPORTED_PREVIEW);
        }
    }

    #[tokio::test]
    async fn unknown_binary_stops_without_waiting_for_the_rest() {
        use tokio::io::AsyncWriteExt;
        let (reader, mut writer) = tokio::io::duplex(8192);
        writer.write_all(&[0, 1, 2, 3]).await.unwrap();
        // Keep the stream open but send no more bytes, as with a slow remote file.
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            read_preview_bytes(Box::pin(reader), 1024 * 1024, true),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert_eq!(result.message, UNSUPPORTED_PREVIEW);
        drop(writer);
        let bytes = read_preview_bytes(Box::pin(Cursor::new(vec![b'x'; 100])), 10, true)
            .await
            .unwrap();
        assert_eq!(
            bytes.len(),
            11,
            "Reads only the text limit plus a truncation marker"
        );
    }

    #[tokio::test]
    async fn preview_search_and_change_detection_are_scoped_and_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let db = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("nested")).unwrap();
        std::fs::write(dir.path().join("nested/hello.txt"), "first\nneedle 中文\n").unwrap();
        std::fs::write(dir.path().join(".hidden"), "needle").unwrap();
        std::fs::write(dir.path().join("binary"), [0, 1, 2]).unwrap();
        let mut boundary = vec![b'x'; 65534];
        boundary.extend_from_slice(b"Needle");
        std::fs::write(dir.path().join("boundary.txt"), boundary).unwrap();
        let image = image::RgbImage::new(400, 200);
        image.save(dir.path().join("photo.png")).unwrap();
        let service = StorageService::new(
            Repository::open(&db.path().join("test.sqlite"))
                .await
                .unwrap(),
        );
        let volume = service
            .add_selected_directory(dir.path().into(), true)
            .await
            .unwrap();
        let loc = |path: &str| StorageLocator {
            volume_id: volume.id,
            logical_path: path.into(),
            version_id: None,
        };
        let thumbnails_busy = service.thumbnail_slots.acquire().await.unwrap();
        let preview = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            service.preview_entry(loc("nested/hello.txt"), false),
        )
        .await
        .unwrap()
        .unwrap();
        drop(thumbnails_busy);
        assert_eq!(preview.kind, "text");
        assert!(preview.content.contains("中文"));
        let thumb = service.preview_entry(loc("photo.png"), true).await.unwrap();
        let data = STANDARD.decode(thumb.content).unwrap();
        let thumb = image::load_from_memory(&data).unwrap();
        assert_eq!((thumb.width(), thumb.height()), (80, 40));
        assert!(service
            .preview_entry(loc("../escape"), false)
            .await
            .is_err());
        assert!(service.preview_entry(loc("binary"), false).await.is_err());
        let before = service.directory_stamp(loc("")).await.unwrap();
        std::fs::write(dir.path().join("new.txt"), "new").unwrap();
        assert_ne!(before, service.directory_stamp(loc("")).await.unwrap());
        let id = service
            .start_content_search(loc(""), "needle".into(), false)
            .await
            .unwrap();
        let state = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let state = service.content_search_status(id, false).await.unwrap();
                if state.done {
                    break state;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(state.hits.len(), 2);
        assert!(state.skipped >= 1);
        assert_eq!(
            state
                .hits
                .iter()
                .find(|h| h.entry.name == "hello.txt")
                .unwrap()
                .line,
            2
        );
        let id = service
            .start_content_search(loc(""), "needle".into(), true)
            .await
            .unwrap();
        service.content_search_status(id, true).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let state = service.content_search_status(id, false).await.unwrap();
                if state.done {
                    assert!(state.cancelled);
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
}
