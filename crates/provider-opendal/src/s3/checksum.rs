use md5::{Digest, Md5};
use opendal::Metadata;
use storage_domain::*;

pub(super) const PART_SIZE: usize = 8 * 1024 * 1024;

/// Match S3 single-PUT MD5 and multipart MD5-of-part-MD5s separately.
/// Bounded state regardless of file size; chunk boundaries match our writer.
#[derive(Clone, Default)]
pub(super) struct UploadChecksum {
    whole: Md5,
    part: Md5,
    parts: Md5,
    part_bytes: usize,
    part_count: u64,
    size: u64,
}
impl UploadChecksum {
    pub(super) fn update(&mut self, mut bytes: &[u8]) {
        self.whole.update(bytes);
        self.size += bytes.len() as u64;
        while !bytes.is_empty() {
            let n = bytes.len().min(PART_SIZE - self.part_bytes);
            self.part.update(&bytes[..n]);
            self.part_bytes += n;
            bytes = &bytes[n..];
            if self.part_bytes == PART_SIZE {
                self.finish_part();
            }
        }
    }
    fn finish_part(&mut self) {
        self.parts.update(std::mem::take(&mut self.part).finalize());
        self.part_bytes = 0;
        self.part_count += 1;
    }
    fn etags(&self) -> (String, String) {
        let mut state = self.clone();
        if state.part_bytes > 0 || state.part_count == 0 {
            state.finish_part();
        }
        (
            format!("{:x}", self.whole.clone().finalize()),
            format!("{:x}-{}", state.parts.finalize(), state.part_count),
        )
    }
    pub(super) fn verify(&self, meta: &Metadata) -> StorageResult<()> {
        let etag = meta
            .etag()
            .unwrap_or("")
            .trim_matches('"')
            .to_ascii_lowercase();
        let hash = etag.split('-').next().unwrap_or("");
        if hash.len() != 32 || !hash.bytes().all(|v| v.is_ascii_hexdigit()) {
            return Err(StorageError::new(
                StorageErrorCode::Unsupported,
                "存储服务未返回可比较的内容校验值，无法确认上传完整性；源文件已保留",
            ));
        }
        let (whole, multipart) = self.etags();
        if meta.content_length() != self.size || (etag != whole && etag != multipart) {
            return Err(StorageError::new(
                StorageErrorCode::Io,
                "存储服务返回的内容校验值不匹配，源文件已保留",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn multipart_hash_uses_exact_parts_even_across_write_boundaries() {
        let data = vec![42; PART_SIZE + 37];
        let mut checksum = UploadChecksum::default();
        for chunk in data.chunks(71_111) {
            checksum.update(chunk);
        }
        let mut combined = Md5::new();
        combined.update(Md5::digest(&data[..PART_SIZE]));
        combined.update(Md5::digest(&data[PART_SIZE..]));
        let expected = format!("{:x}-2", combined.finalize());
        let meta = Metadata::new(opendal::EntryMode::FILE)
            .with_content_length(data.len() as u64)
            .with_etag(expected);
        checksum.verify(&meta).unwrap();
        let bad = meta.with_etag(format!("{:x}-2", Md5::digest(&data)));
        assert!(checksum.verify(&bad).is_err());
    }
    #[test]
    fn empty_files_and_missing_or_opaque_hashes() {
        let checksum = UploadChecksum::default();
        let meta = Metadata::new(opendal::EntryMode::FILE).with_content_length(0);
        assert_eq!(
            checksum.verify(&meta).unwrap_err().code,
            StorageErrorCode::Unsupported
        );
        checksum
            .verify(&meta.with_etag("\"d41d8cd98f00b204e9800998ecf8427e\"".into()))
            .unwrap();
    }
}
