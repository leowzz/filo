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
    let bytes = backend.read_range(entry, 0..size).await?;
    Ok(parse(&bytes))
}

fn parse(bytes: &[u8]) -> Metadata {
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
                break;
            };
            if marker == 0xe1 && segment.starts_with(b"Exif\0\0") {
                found = Some(&segment[6..]);
                break;
            }
            at += len + 2;
        }
        let Some(found) = found else {
            return Metadata::default();
        };
        found
    } else {
        bytes
    };
    let little = match tiff.get(..4) {
        Some(b"II\x2a\0") => true,
        Some(b"MM\0\x2a") => false,
        _ => return Metadata::default(),
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
    let mut pending = vec![u32_at(4).unwrap_or(0) as usize];
    let mut seen = HashSet::new();
    for _ in 0..32 {
        let Some(at) = pending.pop() else {
            break;
        };
        if at == 0 || !seen.insert(at) {
            continue;
        }
        let Some(count) = u16_at(at).filter(|c| *c <= 256) else {
            continue;
        };
        for index in 0..count as usize {
            let at = at + 2 + index * 12;
            let (Some(tag), Some(kind), Some(count), Some(value)) =
                (u16_at(at), u16_at(at + 2), u32_at(at + 4), u32_at(at + 8))
            else {
                continue;
            };
            if tag == 0x8769 && kind == 4 && count == 1 {
                pending.push(value as usize);
            }
            if kind != 2 || count == 0 || count > 256 {
                continue;
            }
            let start = if count <= 4 { at + 8 } else { value as usize };
            let Some(value) = tiff
                .get(start..start + count as usize)
                .and_then(|b| std::str::from_utf8(b).ok())
            else {
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
    result
}

pub(super) fn date(time: &str) -> String {
    time[..10].replace(':', "-")
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert_eq!(date(&parse(&bytes).time.unwrap()), "2026-10-19");
        bytes[37..39].copy_from_slice(b"99");
        assert!(parse(&bytes).time.is_none());
        for end in 0..32 {
            parse(&bytes[..end]);
        }
    }
}
