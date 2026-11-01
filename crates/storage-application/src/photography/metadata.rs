//! Bounded EXIF reads. Camera timestamps stay naive; OS time zones never alter them.
use super::*;
use std::collections::HashSet;

#[derive(Default, Debug)]
pub(super) struct Metadata {
    pub time: Option<String>,
    pub camera: Option<String>,
}

pub(super) async fn read(
    backend: &dyn StorageBackend,
    entry: &StorageEntry,
) -> StorageResult<Metadata> {
    let size = entry.size.unwrap_or(0).min(1024 * 1024);
    if size < 8 {
        return Ok(Metadata::default());
    }
    // Most camera EXIF fits in the first 64 KiB. Reading 1 MiB from every
    // member of a large JPG/RAW folder otherwise transfers gigabytes before
    // the first photo can be shown. Preserve the old bound for distant IFDs.
    let prefix = size.min(64 * 1024);
    let mut bytes = backend.read_range(entry, 0..prefix).await?;
    let (metadata, complete) = parse(&bytes);
    if complete || prefix == size {
        return Ok(metadata);
    }
    bytes.extend(backend.read_range(entry, prefix..size).await?);
    Ok(parse(&bytes).0)
}

// `complete` means additional bytes cannot change this parser's result.
// Truncated EXIF segments, IFDs and string values require the bounded fallback.
fn parse(bytes: &[u8]) -> (Metadata, bool) {
    let tiff = if bytes.starts_with(b"\xff\xd8") {
        let mut at = 2;
        let mut found = None;
        while at + 4 <= bytes.len() {
            if bytes[at] != 0xff {
                break;
            }
            let marker = bytes[at + 1];
            if marker == 0xda || marker == 0xd9 {
                break;
            }
            let len = u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]) as usize;
            if len < 2 {
                break;
            }
            let Some(segment) = bytes.get(at + 4..at + 2 + len) else {
                return (Metadata::default(), false);
            };
            if marker == 0xe1 && segment.starts_with(b"Exif\0\0") {
                found = Some(&segment[6..]);
                break;
            }
            at += len + 2;
        }
        let Some(found) = found else {
            return (Metadata::default(), at + 4 <= bytes.len());
        };
        found
    } else {
        bytes
    };
    let little = match tiff.get(..4) {
        Some(b"II\x2a\0") => true,
        Some(b"MM\0\x2a") => false,
        _ => return (Metadata::default(), true),
    };
    let u16_at = |at| -> Option<u16> {
        let b = tiff.get(at..at + 2)?.try_into().ok()?;
        Some(if little {
            u16::from_le_bytes(b)
        } else {
            u16::from_be_bytes(b)
        })
    };
    let u32_at = |at| -> Option<u32> {
        let b = tiff.get(at..at + 4)?.try_into().ok()?;
        Some(if little {
            u32::from_le_bytes(b)
        } else {
            u32::from_be_bytes(b)
        })
    };
    let mut result = Metadata::default();
    let mut complete = u32_at(4).is_some();
    let mut pending = vec![u32_at(4).unwrap_or(0) as usize];
    let mut seen = HashSet::new();
    for _ in 0..32 {
        let Some(at) = pending.pop() else {
            break;
        };
        if at == 0 || !seen.insert(at) {
            continue;
        }
        let Some(count) = u16_at(at) else {
            complete = false;
            continue;
        };
        if count > 256 {
            continue;
        }
        for index in 0..count as usize {
            let at = at + 2 + index * 12;
            let (Some(tag), Some(kind), Some(count), Some(value)) =
                (u16_at(at), u16_at(at + 2), u32_at(at + 4), u32_at(at + 8))
            else {
                complete = false;
                continue;
            };
            if tag == 0x8769 && kind == 4 && count == 1 {
                pending.push(value as usize);
            }
            if kind != 2 || count == 0 || count > 256 {
                continue;
            }
            let start = if count <= 4 { at + 8 } else { value as usize };
            let Some(value) = tiff.get(start..start + count as usize) else {
                complete = false;
                continue;
            };
            let Ok(value) = std::str::from_utf8(value) else {
                continue;
            };
            let value = value.trim_matches('\0').trim();
            if matches!(tag, 0x9003 | 0x9004)
                && result.time.is_none()
                && chrono::NaiveDateTime::parse_from_str(value, "%Y:%m:%d %H:%M:%S").is_ok()
            {
                result.time = Some(value.to_string());
            }
            if tag == 0x0110 && !value.is_empty() {
                result.camera = Some(value.to_string());
            }
        }
    }
    (result, complete)
}

pub(super) fn date(time: &str) -> String {
    time[..10].replace(':', "-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jpeg_exif_after_a_large_segment_requires_the_remaining_header() {
        let mut tiff = vec![0u8; 96];
        tiff[..8].copy_from_slice(b"II\x2a\0\x08\0\0\0");
        tiff[8..10].copy_from_slice(&1u16.to_le_bytes());
        tiff[10..12].copy_from_slice(&0x9003u16.to_le_bytes());
        tiff[12..14].copy_from_slice(&2u16.to_le_bytes());
        tiff[14..18].copy_from_slice(&20u32.to_le_bytes());
        tiff[18..22].copy_from_slice(&32u32.to_le_bytes());
        tiff[32..52].copy_from_slice(b"2026:10:19 23:59:00\0");
        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe2];
        jpeg.extend(65500u16.to_be_bytes());
        jpeg.resize(65504, 0);
        jpeg.extend([0xff, 0xe1]);
        jpeg.extend(((tiff.len() + 8) as u16).to_be_bytes());
        jpeg.extend(b"Exif\0\0");
        jpeg.extend(tiff);
        let (partial, complete) = parse(&jpeg[..64 * 1024]);
        assert!(!complete);
        assert!(partial.time.is_none());
        let (full, complete) = parse(&jpeg);
        assert!(complete);
        assert_eq!(full.time.as_deref(), Some("2026:10:19 23:59:00"));
        // An image whose scan starts before EXIF has nothing more to inspect.
        assert!(parse(&[0xff, 0xd8, 0xff, 0xda, 0, 2]).1);
    }

    #[test]
    fn reads_camera_date_without_timezone_and_rejects_invalid_dates() {
        let mut bytes = vec![0u8; 96];
        bytes[..8].copy_from_slice(b"II\x2a\0\x08\0\0\0");
        bytes[8..10].copy_from_slice(&1u16.to_le_bytes());
        bytes[10..12].copy_from_slice(&0x9003u16.to_le_bytes());
        bytes[12..14].copy_from_slice(&2u16.to_le_bytes());
        bytes[14..18].copy_from_slice(&20u32.to_le_bytes());
        bytes[18..22].copy_from_slice(&32u32.to_le_bytes());
        bytes[32..52].copy_from_slice(b"2026:10:19 23:59:00\0");
        assert_eq!(date(&parse(&bytes).0.time.unwrap()), "2026-10-19");
        bytes[37..39].copy_from_slice(b"99");
        assert!(parse(&bytes).0.time.is_none());
        for end in 0..32 {
            parse(&bytes[..end]);
        }
    }
}
