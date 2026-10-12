use super::error;
use image::metadata::Orientation;
use std::{
    collections::{HashSet, VecDeque},
    ops::Range,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use storage_domain::*;
use storage_provider_api::StorageBackend;
use tokio::sync::Mutex;

const PAGE_SIZE: u64 = 8192;
const MAX_METADATA: usize = 1024 * 1024;
const MAX_JPEG: u64 = 20 * 1024 * 1024;
const CACHE_BYTES: usize = 64 * 1024 * 1024;
const CACHE_TTL: Duration = Duration::from_secs(60);

pub(super) fn same_file(a: &StorageEntry, b: &StorageEntry) -> bool {
    a.locator == b.locator
        && a.kind == b.kind
        && a.size == b.size
        && a.modified_at == b.modified_at
        && a.etag == b.etag
}

#[derive(Clone)]
struct CachedFile {
    entry: StorageEntry,
    created: Instant,
    data: Arc<Mutex<FileData>>,
    bytes: Arc<AtomicUsize>,
}
#[derive(Default)]
pub(crate) struct Cache {
    files: VecDeque<CachedFile>,
}
impl Cache {
    pub(crate) fn invalidate_volume(&mut self, id: uuid::Uuid) {
        self.files.retain(|file| file.entry.locator.volume_id != id);
    }
    fn prune(&mut self) {
        self.files.retain(|file| file.created.elapsed() < CACHE_TTL);
        while self.files.len() > 16
            || self
                .files
                .iter()
                .map(|f| f.bytes.load(Ordering::Relaxed))
                .sum::<usize>()
                > CACHE_BYTES
        {
            self.files.pop_front();
        }
    }
    fn get(&mut self, entry: &StorageEntry) -> CachedFile {
        self.prune();
        if let Some(i) = self.files.iter().position(|f| same_file(&f.entry, entry)) {
            let file = self.files.remove(i).unwrap();
            self.files.push_back(file.clone());
            return file;
        }
        self.files.retain(|f| f.entry.locator != entry.locator);
        let file = CachedFile {
            entry: entry.clone(),
            created: Instant::now(),
            data: Arc::new(Mutex::new(FileData::default())),
            bytes: Arc::new(AtomicUsize::new(0)),
        };
        // Without a revision marker, re-read instead of serving potentially stale bytes.
        if entry.etag.is_some() || entry.modified_at.is_some() {
            self.files.push_back(file.clone());
            self.prune();
        }
        file
    }
}
#[derive(Clone)]
struct Index {
    orientation: Orientation,
    previews: Vec<Range<u64>>,
}
#[derive(Default)]
struct FileData {
    index: Option<Index>,
    blocks: Vec<(u64, Vec<u8>)>,
    metadata_bytes: usize,
}
impl FileData {
    fn contains(&self, range: &Range<u64>) -> bool {
        self.blocks.iter().any(|(offset, bytes)| {
            range.start >= *offset && range.end <= *offset + bytes.len() as u64
        })
    }
    fn cached(&self, range: &Range<u64>) -> Option<Vec<u8>> {
        self.blocks.iter().find_map(|(offset, bytes)| {
            if range.start >= *offset && range.end <= *offset + bytes.len() as u64 {
                Some(bytes[(range.start - offset) as usize..(range.end - offset) as usize].to_vec())
            } else {
                None
            }
        })
    }
}

struct Reader<'a> {
    backend: &'a dyn StorageBackend,
    entry: &'a StorageEntry,
    data: &'a mut FileData,
    count: &'a AtomicUsize,
}
impl Reader<'_> {
    async fn fetch(&mut self, range: Range<u64>) -> StorageResult<Vec<u8>> {
        if let Some(bytes) = self.data.cached(&range) {
            return Ok(bytes);
        }
        let bytes = self.backend.read_range(self.entry, range.clone()).await?;
        if bytes.len() as u64 != range.end - range.start {
            return Err(error("NEF 预览内容不完整，请重试或使用系统应用打开"));
        }
        self.count.fetch_add(bytes.len(), Ordering::Relaxed);
        self.data.blocks.push((range.start, bytes.clone()));
        Ok(bytes)
    }
    async fn metadata(&mut self, offset: u64, length: u64) -> StorageResult<Vec<u8>> {
        let end = offset.checked_add(length).ok_or_else(invalid)?;
        if self.entry.size.is_some_and(|size| end > size) || length > PAGE_SIZE {
            return Err(invalid());
        }
        let range = offset..end;
        if let Some(bytes) = self.data.cached(&range) {
            return Ok(bytes);
        }
        let start = offset / PAGE_SIZE * PAGE_SIZE;
        let end = end.checked_add(PAGE_SIZE - 1).ok_or_else(invalid)? / PAGE_SIZE * PAGE_SIZE;
        let end = self.entry.size.map_or(end, |size| end.min(size));
        let count = (end - start) as usize;
        if self.data.metadata_bytes + count > MAX_METADATA {
            return Err(invalid());
        }
        self.data.metadata_bytes += count;
        self.fetch(start..end).await?;
        self.data.cached(&range).ok_or_else(invalid)
    }
    async fn values(&mut self, tiff: Tiff, field: &[u8]) -> StorageResult<Vec<u32>> {
        let width = match tiff.u16(field, 2) {
            Some(3) => 2,
            Some(4 | 13) => 4,
            _ => return Ok(vec![]),
        };
        let count = tiff.u32(field, 4).ok_or_else(invalid)? as usize;
        if count == 0 || count > 64 {
            return Ok(vec![]);
        }
        let bytes = if count * width <= 4 {
            field[8..12].to_vec()
        } else {
            let at = tiff.absolute(tiff.u32(field, 8).ok_or_else(invalid)?)?;
            self.metadata(at, (count * width) as u64).await?
        };
        (0..count)
            .map(|i| {
                if width == 2 {
                    tiff.u16(&bytes, i * width).map(u32::from)
                } else {
                    tiff.u32(&bytes, i * width)
                }
                .ok_or_else(invalid)
            })
            .collect()
    }
    async fn index(&mut self) -> StorageResult<Index> {
        let header = self.metadata(0, 8).await?;
        let root = Tiff::new(&header, 0).ok_or_else(invalid)?;
        let root_offset = root.u32(&header, 4).ok_or_else(invalid)?;
        let mut pending = vec![(root, root_offset)];
        let mut seen = HashSet::new();
        let mut index = Index {
            orientation: Orientation::NoTransforms,
            previews: vec![],
        };
        for _ in 0..64 {
            let Some((tiff, offset)) = pending.pop() else {
                break;
            };
            if offset == 0 || !seen.insert((tiff.base, offset)) {
                continue;
            }
            let at = tiff.absolute(offset)?;
            let count_bytes = self.metadata(at, 2).await?;
            let count = tiff.u16(&count_bytes, 0).ok_or_else(invalid)? as usize;
            if count > 256 {
                return Err(invalid());
            }
            let bytes = self.metadata(at, (2 + count * 12 + 4) as u64).await?;
            let mut jpeg_offset = None;
            let mut jpeg_length = None;
            for field in bytes[2..2 + count * 12].as_chunks::<12>().0 {
                match tiff.u16(field, 0).ok_or_else(invalid)? {
                    0x0201 | 0x0202 => {
                        let value = self.values(tiff, field).await?.first().copied();
                        if tiff.u16(field, 0) == Some(0x0201) {
                            jpeg_offset = value;
                        } else {
                            jpeg_length = value;
                        }
                    }
                    0x0112 if tiff.base == 0 && offset == root_offset => {
                        if let Some(value) = self.values(tiff, field).await?.first().copied() {
                            index.orientation = u8::try_from(value)
                                .ok()
                                .and_then(Orientation::from_exif)
                                .unwrap_or(Orientation::NoTransforms);
                        }
                    }
                    0x014a | 0x8769 | 0x0011 => {
                        pending.extend(
                            self.values(tiff, field)
                                .await?
                                .into_iter()
                                .map(|n| (tiff, n)),
                        );
                    }
                    0x927c if tiff.u32(field, 4).is_some_and(|n| n >= 18) => {
                        let note = tiff.absolute(tiff.u32(field, 8).ok_or_else(invalid)?)?;
                        let header = self.metadata(note, 18).await?;
                        if header.starts_with(b"Nikon\0\x02") {
                            if let Some(inner) =
                                Tiff::new(&header[10..], note.checked_add(10).ok_or_else(invalid)?)
                            {
                                if let Some(offset) = inner.u32(&header[10..], 4) {
                                    pending.push((inner, offset));
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            if let Some(next) = tiff.u32(&bytes, 2 + count * 12).filter(|&n| n != 0) {
                pending.push((tiff, next));
            }
            if let Some((start, length)) = jpeg_offset.zip(jpeg_length) {
                let start = tiff.absolute(start)?;
                let end = start.checked_add(u64::from(length)).ok_or_else(invalid)?;
                if length >= 4
                    && u64::from(length) <= MAX_JPEG
                    && self.entry.size.is_none_or(|size| end <= size)
                {
                    index.previews.push(start..end);
                }
            }
        }
        index.previews.sort_by_key(|range| range.end - range.start);
        index.previews.dedup();
        if index.previews.is_empty() {
            return Err(invalid());
        }
        Ok(index)
    }
}

#[derive(Clone, Copy)]
struct Tiff {
    base: u64,
    little: bool,
}
impl Tiff {
    fn new(bytes: &[u8], base: u64) -> Option<Self> {
        let little = match bytes.get(..4)? {
            b"II\x2a\0" => true,
            b"MM\0\x2a" => false,
            _ => return None,
        };
        Some(Self { base, little })
    }
    fn u16(self, bytes: &[u8], at: usize) -> Option<u16> {
        let value = bytes.get(at..at.checked_add(2)?)?.try_into().ok()?;
        Some(if self.little {
            u16::from_le_bytes(value)
        } else {
            u16::from_be_bytes(value)
        })
    }
    fn u32(self, bytes: &[u8], at: usize) -> Option<u32> {
        let value = bytes.get(at..at.checked_add(4)?)?.try_into().ok()?;
        Some(if self.little {
            u32::from_le_bytes(value)
        } else {
            u32::from_be_bytes(value)
        })
    }
    fn absolute(self, offset: u32) -> StorageResult<u64> {
        self.base.checked_add(u64::from(offset)).ok_or_else(invalid)
    }
}
fn invalid() -> StorageError {
    error("无法读取 NEF 内嵌预览，请下载或使用系统应用打开")
}

pub(super) async fn load(
    backend: &dyn StorageBackend,
    entry: &StorageEntry,
    thumbnail: bool,
    cache: &Mutex<Cache>,
) -> StorageResult<(Vec<u8>, Orientation)> {
    let file = cache.lock().await.get(entry);
    let mut data = file.data.lock().await;
    let before = file.bytes.load(Ordering::Relaxed);
    let mut reader = Reader {
        backend,
        entry,
        data: &mut data,
        count: &file.bytes,
    };
    let index = match reader.data.index.clone() {
        Some(index) => index,
        None => {
            let index = reader.index().await?;
            reader.data.index = Some(index.clone());
            index
        }
    };
    // Reuse an already loaded full-size JPEG for a later thumbnail.
    let range = if thumbnail {
        index
            .previews
            .iter()
            .rev()
            .find(|r| reader.data.contains(r))
            .unwrap_or(&index.previews[0])
    } else {
        index.previews.last().unwrap()
    };
    let bytes = reader.fetch(range.clone()).await?;
    if !bytes.starts_with(b"\xff\xd8") || !bytes.ends_with(b"\xff\xd9") {
        return Err(invalid());
    }
    if file.bytes.load(Ordering::Relaxed) != before
        && !same_file(entry, &backend.stat(&entry.locator).await?)
    {
        reader.data.index = None;
        reader.data.blocks.clear();
        reader.data.metadata_bytes = 0;
        file.bytes.store(0, Ordering::Relaxed);
        return Err(error("文件已发生变化，请重新读取预览"));
    }
    drop(data);
    cache.lock().await.prune();
    Ok((bytes, index.orientation))
}

#[cfg(test)]
pub(super) fn fixture(little: bool, maker_note: bool) -> Vec<u8> {
    use std::io::Cursor;
    fn jpeg(width: u32, height: u32) -> Vec<u8> {
        let image = image::RgbImage::from_pixel(width, height, image::Rgb([220, 40, 20]));
        let mut output = Cursor::new(Vec::new());
        image
            .write_to(&mut output, image::ImageFormat::Jpeg)
            .unwrap();
        output.into_inner()
    }
    let large = jpeg(400, 200);
    let small = jpeg(40, 20);
    let mut bytes = vec![0; 4096 + large.len()];
    bytes[1024..1024 + small.len()].copy_from_slice(&small);
    bytes[4096..].copy_from_slice(&large);
    fn put16(bytes: &mut [u8], at: usize, value: u16, little: bool) {
        bytes[at..at + 2].copy_from_slice(&if little {
            value.to_le_bytes()
        } else {
            value.to_be_bytes()
        });
    }
    fn put32(bytes: &mut [u8], at: usize, value: u32, little: bool) {
        bytes[at..at + 4].copy_from_slice(&if little {
            value.to_le_bytes()
        } else {
            value.to_be_bytes()
        });
    }
    fn header(bytes: &mut [u8], base: usize, little: bool) {
        bytes[base..base + 4].copy_from_slice(if little { b"II\x2a\0" } else { b"MM\0\x2a" });
        put32(bytes, base + 4, 8, little);
    }
    fn ifd(bytes: &mut [u8], at: usize, tags: &[(u16, u16, u32, u32)], little: bool) {
        put16(bytes, at, tags.len() as u16, little);
        for (i, &(tag, format, count, value)) in tags.iter().enumerate() {
            let at = at + 2 + i * 12;
            put16(bytes, at, tag, little);
            put16(bytes, at + 2, format, little);
            put32(bytes, at + 4, count, little);
            if format == 3 && count == 1 {
                put16(bytes, at + 8, value as u16, little);
            } else {
                put32(bytes, at + 8, value, little);
            }
        }
    }
    header(&mut bytes, 0, little);
    if maker_note {
        ifd(
            &mut bytes,
            8,
            &[(0x112, 3, 1, 6), (0x8769, 4, 1, 128)],
            little,
        );
        ifd(&mut bytes, 128, &[(0x927c, 7, 128, 256)], little);
        bytes[256..266].copy_from_slice(b"Nikon\0\x02\x10\0\0");
        // MakerNote offsets and byte order are independent of the outer TIFF.
        header(&mut bytes, 266, !little);
        ifd(&mut bytes, 274, &[(0x11, 4, 1, 64)], !little);
        ifd(
            &mut bytes,
            330,
            &[(0x201, 4, 1, 4096 - 266), (0x202, 4, 1, large.len() as u32)],
            !little,
        );
    } else {
        ifd(
            &mut bytes,
            8,
            &[(0x112, 3, 1, 6), (0x14a, 4, 2, 48)],
            little,
        );
        put32(&mut bytes, 48, 128, little);
        put32(&mut bytes, 52, 256, little);
        ifd(
            &mut bytes,
            128,
            &[(0x201, 4, 1, 4096), (0x202, 4, 1, large.len() as u32)],
            little,
        );
        ifd(
            &mut bytes,
            256,
            &[(0x201, 4, 1, 1024), (0x202, 4, 1, small.len() as u32)],
            little,
        );
        // A cycle must not stop extraction from the other directories.
        put32(&mut bytes, 34, 8, little);
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use storage_provider_api::{StagedWrite, StorageReader};
    use uuid::Uuid;

    struct Backend {
        bytes: Vec<u8>,
        entry: StdMutex<StorageEntry>,
        reads: StdMutex<Vec<Range<u64>>>,
    }
    impl Backend {
        fn new(bytes: Vec<u8>) -> Self {
            Self {
                entry: StdMutex::new(StorageEntry {
                    locator: StorageLocator {
                        volume_id: Uuid::new_v4(),
                        logical_path: "photo.NEF".into(),
                        version_id: None,
                    },
                    name: "photo.NEF".into(),
                    kind: StorageEntryKind::File,
                    size: Some(bytes.len() as u64),
                    modified_at: Some("revision-1".into()),
                    etag: Some("etag-1".into()),
                    content_type: None,
                    metadata: Default::default(),
                }),
                bytes,
                reads: StdMutex::new(vec![]),
            }
        }
        fn entry(&self) -> StorageEntry {
            self.entry.lock().unwrap().clone()
        }
        fn received(&self) -> u64 {
            self.reads
                .lock()
                .unwrap()
                .iter()
                .map(|r| r.end - r.start)
                .sum()
        }
    }
    #[async_trait::async_trait]
    impl StorageBackend for Backend {
        fn volume_id(&self) -> Uuid {
            self.entry().locator.volume_id
        }
        fn capabilities(&self) -> StorageCapabilities {
            StorageCapabilities::remote(RemoteProtocol::Sftp, true)
        }
        async fn stat(&self, _: &StorageLocator) -> StorageResult<StorageEntry> {
            Ok(self.entry())
        }
        async fn read_range(
            &self,
            entry: &StorageEntry,
            range: Range<u64>,
        ) -> StorageResult<Vec<u8>> {
            storage_provider_api::read_range_length(entry, &range)?;
            self.reads.lock().unwrap().push(range.clone());
            Ok(self.bytes[range.start as usize..range.end as usize].to_vec())
        }
        async fn open_read(&self, _: &StorageLocator) -> StorageResult<StorageReader> {
            panic!("NEF must not download the full file")
        }
        async fn list(&self, _: &StorageLocator) -> StorageResult<Vec<StorageEntry>> {
            Err(invalid())
        }
        async fn create_dir(&self, _: &StorageLocator) -> StorageResult<()> {
            Err(invalid())
        }
        async fn rename(&self, _: &StorageLocator, _: &StorageLocator) -> StorageResult<()> {
            Err(invalid())
        }
        async fn delete(&self, _: &StorageLocator) -> StorageResult<()> {
            Err(invalid())
        }
        async fn stage_write(&self, _: &StorageLocator) -> StorageResult<Box<dyn StagedWrite>> {
            Err(invalid())
        }
    }

    #[tokio::test]
    async fn extracts_largest_preview_and_relative_maker_note_in_both_byte_orders() {
        for little in [true, false] {
            for maker_note in [true, false] {
                let backend = Backend::new(fixture(little, maker_note));
                let (jpeg, orientation) = load(
                    &backend,
                    &backend.entry(),
                    false,
                    &Mutex::new(Cache::default()),
                )
                .await
                .unwrap();
                let image = image::load_from_memory(&jpeg).unwrap();
                assert_eq!((image.width(), image.height()), (400, 200));
                assert_eq!(orientation, Orientation::Rotate90);
            }
        }
    }

    #[tokio::test]
    async fn rejects_invalid_data_and_out_of_bounds_offsets_without_panicking() {
        let mut invalid_files = vec![b"not a NEF".to_vec()];
        let bytes = fixture(true, false);
        for end in [0, 4, 8, 34, 128, 256, 512] {
            invalid_files.push(bytes[..end].to_vec());
        }
        let mut bytes = bytes;
        bytes[138..142].copy_from_slice(&u32::MAX.to_le_bytes());
        bytes[266..270].copy_from_slice(&u32::MAX.to_le_bytes());
        invalid_files.push(bytes.clone());
        bytes[26..30].copy_from_slice(&u32::MAX.to_le_bytes());
        invalid_files.push(bytes);
        for bytes in invalid_files {
            let backend = Backend::new(bytes);
            assert!(load(
                &backend,
                &backend.entry(),
                false,
                &Mutex::new(Cache::default())
            )
            .await
            .is_err());
        }
    }

    #[tokio::test]
    async fn remote_preview_reads_only_metadata_and_selected_jpeg_and_reuses_cache() {
        let mut bytes = fixture(true, false);
        let large_len = u32::from_le_bytes(bytes[150..154].try_into().unwrap()) as usize;
        let small_len = u32::from_le_bytes(bytes[278..282].try_into().unwrap()) as usize;
        let large = bytes[4096..4096 + large_len].to_vec();
        let small = bytes[1024..1024 + small_len].to_vec();
        // Neither JPEG is near the header, and the sensor payload extends far beyond them.
        let large_at = 16 * 1024 * 1024;
        let small_at = 8 * 1024 * 1024;
        bytes.resize(64 * 1024 * 1024, 0);
        bytes[large_at..large_at + large_len].copy_from_slice(&large);
        bytes[small_at..small_at + small_len].copy_from_slice(&small);
        bytes[138..142].copy_from_slice(&(large_at as u32).to_le_bytes());
        bytes[266..270].copy_from_slice(&(small_at as u32).to_le_bytes());
        let backend = Arc::new(Backend::new(bytes));
        let db = tempfile::tempdir().unwrap();
        let service = crate::StorageService::new(
            storage_repository::Repository::open(&db.path().join("test.sqlite"))
                .await
                .unwrap(),
        );
        let locator = backend.entry().locator;
        service
            .temporary_backends
            .lock()
            .await
            .insert(locator.volume_id, backend.clone());
        let thumb = service.preview_entry(locator.clone(), true).await.unwrap();
        assert_eq!(thumb.kind, "image");
        assert_eq!(backend.received(), PAGE_SIZE + small_len as u64);
        let preview = service.preview_entry(locator.clone(), false).await.unwrap();
        assert_eq!(preview.kind, "image");
        assert_eq!(
            backend.received(),
            PAGE_SIZE + small_len as u64 + large_len as u64
        );
        let received = backend.received();
        service.preview_entry(locator.clone(), true).await.unwrap();
        service.preview_entry(locator.clone(), false).await.unwrap();
        assert_eq!(
            backend.received(),
            received,
            "both sizes reuse cached source bytes"
        );
        backend.entry.lock().unwrap().etag = Some("etag-2".into());
        service.preview_entry(locator.clone(), false).await.unwrap();
        assert_eq!(backend.received() - received, PAGE_SIZE + large_len as u64);
        let received = backend.received();
        service.preview_entry(locator, true).await.unwrap();
        assert_eq!(
            backend.received(),
            received,
            "a loaded large JPEG serves a later thumbnail"
        );
    }

    #[tokio::test]
    async fn concurrent_requests_share_source_reads_and_cache_expiry_reloads() {
        let backend = Backend::new(fixture(true, true));
        let entry = backend.entry();
        let cache = Mutex::new(Cache::default());
        let (a, b) = tokio::join!(
            load(&backend, &entry, false, &cache),
            load(&backend, &entry, false, &cache)
        );
        assert_eq!(a.unwrap().0, b.unwrap().0);
        assert_eq!(backend.reads.lock().unwrap().len(), 1);
        cache.lock().await.files[0].created = Instant::now() - CACHE_TTL;
        load(&backend, &entry, false, &cache).await.unwrap();
        assert_eq!(backend.reads.lock().unwrap().len(), 2);
    }

    #[test]
    fn cache_evicts_oldest_files_when_byte_budget_is_exceeded() {
        let mut cache = Cache::default();
        let a = cache.get(&Backend::new(vec![]).entry());
        let b = cache.get(&Backend::new(vec![]).entry());
        a.bytes.store(CACHE_BYTES, Ordering::Relaxed);
        b.bytes.store(1, Ordering::Relaxed);
        cache.prune();
        assert_eq!(cache.files.len(), 1);
        assert!(Arc::ptr_eq(&cache.files[0].data, &b.data));
    }
}
