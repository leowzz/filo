use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use storage_domain::{StorageError, StorageErrorCode, StorageResult};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RemovableVolume {
    pub id: String,
    pub drive_letter: String,
    pub path: String,
    pub label: String,
    pub file_system: String,
    pub volume_serial: String,
    pub size: u64,
}

#[derive(Clone, Debug, Deserialize)]
struct WindowsLogicalDisk {
    #[serde(rename = "DeviceID")]
    device_id: Option<String>,
    #[serde(rename = "VolumeName")]
    volume_name: Option<String>,
    #[serde(rename = "VolumeSerialNumber")]
    volume_serial_number: Option<String>,
    #[serde(rename = "FileSystem")]
    file_system: Option<String>,
    #[serde(rename = "Size")]
    size: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct CopyDirectoryResult {
    pub files: u64,
    pub bytes: u64,
}

pub async fn list_removable_volumes() -> StorageResult<Vec<RemovableVolume>> {
    #[cfg(target_os = "windows")]
    {
        let output = tokio::task::spawn_blocking(|| {
            std::process::Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    r#"$items = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2' | Select-Object DeviceID,VolumeName,VolumeSerialNumber,FileSystem,Size; if ($items) { $items | ConvertTo-Json -Compress }"#,
                ])
                .output()
        })
        .await
        .map_err(|_| StorageError::new(StorageErrorCode::Internal, "读取可移动磁盘时任务中断"))?
        .map_err(|_| StorageError::new(StorageErrorCode::Io, "无法读取可移动磁盘"))?;
        if !output.status.success() {
            return Err(StorageError::new(StorageErrorCode::Io, "无法读取可移动磁盘"));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let trimmed = stdout.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        let value: serde_json::Value = serde_json::from_str(trimmed)
            .map_err(|_| StorageError::new(StorageErrorCode::Io, "可移动磁盘信息格式无效"))?;
        let items: Vec<WindowsLogicalDisk> = match value {
            serde_json::Value::Array(values) => values
                .into_iter()
                .map(|value| serde_json::from_value(value).map_err(|_| ()))
                .collect::<Result<_, _>>()
                .map_err(|_| StorageError::new(StorageErrorCode::Io, "可移动磁盘信息格式无效"))?,
            value => vec![serde_json::from_value(value)
                .map_err(|_| StorageError::new(StorageErrorCode::Io, "可移动磁盘信息格式无效"))?],
        };
        let mut volumes = items
            .into_iter()
            .filter_map(|item| {
                let device_id = item.device_id?.trim().trim_end_matches(':').to_owned();
                let size = item.size?;
                let serial = item.volume_serial_number?.trim().to_ascii_uppercase();
                if device_id.is_empty() || serial.is_empty() || size == 0 {
                    return None;
                }
                let path = format!("{device_id}:\\");
                Some(RemovableVolume {
                    id: format!("{serial}:{size}"),
                    drive_letter: device_id,
                    path,
                    label: item.volume_name.unwrap_or_default().trim().to_owned(),
                    file_system: item.file_system.unwrap_or_default(),
                    volume_serial: serial,
                    size,
                })
            })
            .collect::<Vec<_>>();
        volumes.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(volumes)
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
}

pub async fn copy_local_directory(
    source: String,
    destination: String,
) -> StorageResult<CopyDirectoryResult> {
    tokio::task::spawn_blocking(move || copy_directory(Path::new(&source), Path::new(&destination)))
        .await
        .map_err(|_| StorageError::new(StorageErrorCode::Internal, "拷卡任务中断"))?
}

fn copy_directory(source: &Path, destination: &Path) -> StorageResult<CopyDirectoryResult> {
    let source = std::fs::canonicalize(source)
        .map_err(|_| StorageError::new(StorageErrorCode::AccessDenied, "无法访问源目录"))?;
    if !source.is_dir() {
        return Err(StorageError::new(StorageErrorCode::InvalidPath, "源路径不是目录"));
    }

    let destination = if destination.exists() {
        std::fs::canonicalize(destination)
            .map_err(|_| StorageError::new(StorageErrorCode::AccessDenied, "无法访问目标目录"))?
    } else {
        destination.to_path_buf()
    };
    if destination.starts_with(&source) {
        return Err(StorageError::new(
            StorageErrorCode::InvalidPath,
            "目标目录不能位于源目录内部",
        ));
    }
    std::fs::create_dir_all(&destination)
        .map_err(|_| StorageError::new(StorageErrorCode::AccessDenied, "无法创建目标目录"))?;

    let mut result = CopyDirectoryResult { files: 0, bytes: 0 };
    copy_entries(&source, &destination, &mut result).map_err(|error| {
        StorageError::new(StorageErrorCode::Io, format!("拷贝文件失败：{error}"))
    })?;
    Ok(result)
}

fn copy_entries(
    source: &Path,
    destination: &Path,
    result: &mut CopyDirectoryResult,
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let path = entry.path();
        let target = destination.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            std::fs::create_dir_all(&target)?;
            copy_entries(&path, &target, result)?;
        } else if file_type.is_file() {
            let bytes = std::fs::copy(&path, &target)?;
            result.files += 1;
            result.bytes += bytes;
        }
    }
    Ok(())
}
