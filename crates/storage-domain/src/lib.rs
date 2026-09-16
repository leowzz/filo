use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    LocalFs,
    S3,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum S3Provider {
    Generic,
    Rustfs,
    Tos,
    Oss,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S3ConnectionConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<S3Provider>,
    pub endpoint: Option<String>,
    pub region: String,
    pub force_path_style: bool,
}

// Never derive Debug: credentials must not enter logs or error messages.
#[derive(Clone, Serialize, Deserialize)]
pub struct S3Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct S3StorageInput {
    pub name: String,
    pub config: S3ConnectionConfig,
    pub bucket: String,
    pub prefix: String,
    pub read_only: bool,
    /// Omit when editing to retain the saved credentials.
    pub credentials: Option<S3Credentials>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageConnection {
    pub id: Uuid,
    pub name: String,
    pub provider: ProviderKind,
    pub config: serde_json::Value,
    pub credential_ref: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VolumeRoot {
    Local { root_path: std::path::PathBuf },
    S3 { bucket: String, prefix: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageVolume {
    pub id: Uuid,
    pub connection_id: Uuid,
    pub name: String,
    pub root: VolumeRoot,
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageLocator {
    pub volume_id: Uuid,
    pub logical_path: String,
    pub version_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferKind {
    Copy,
    Move,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    #[default]
    Reject,
    Overwrite,
    Skip,
    Rename,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferState {
    Queued,
    Running,
    Verifying,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
    Skipped,
}

impl TransferState {
    pub fn active(self) -> bool {
        matches!(self, Self::Queued | Self::Running | Self::Verifying)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferJob {
    pub id: Uuid,
    pub kind: TransferKind,
    pub source: StorageLocator,
    pub destination: StorageLocator,
    pub state: TransferState,
    pub bytes_total: Option<u64>,
    pub bytes_transferred: u64,
    pub error_code: Option<StorageErrorCode>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StorageEntryKind {
    File,
    Directory,
    VirtualPrefix,
    Symlink,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeleteMode {
    Default,
    Permanent,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeleteOutcome {
    Trashed,
    PermanentlyDeleted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageEntry {
    pub locator: StorageLocator,
    pub name: String,
    pub kind: StorageEntryKind,
    pub size: Option<u64>,
    pub modified_at: Option<String>,
    pub etag: Option<String>,
    pub content_type: Option<String>,
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EntrySort {
    #[default]
    Name,
    Size,
    Modified,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct ListOptions {
    pub search: String,
    pub show_hidden: bool,
    pub folders_only: bool,
    pub sort: EntrySort,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntryPage {
    pub entries: Vec<StorageEntry>,
    pub next_cursor: Option<String>,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HierarchySemantics {
    NativeDirectory,
    VirtualPrefix,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenameSemantics {
    Atomic,
    CopyThenDelete,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageCapabilities {
    pub hierarchy: HierarchySemantics,
    pub rename: RenameSemantics,
    pub create_directory: bool,
    pub write: bool,
    pub range_read: bool,
    pub multipart_write: bool,
    pub native_copy: bool,
    pub server_side_copy: bool,
    pub recursive_delete: bool,
    pub presigned_url: bool,
    pub versioning: bool,
    pub custom_metadata: bool,
    pub tags: bool,
    pub watch_changes: bool,
    pub delete: bool,
    pub trash: bool,
    pub native_open: bool,
}

impl StorageCapabilities {
    pub fn s3(read_only: bool) -> Self {
        Self {
            hierarchy: HierarchySemantics::VirtualPrefix,
            rename: if read_only {
                RenameSemantics::Unsupported
            } else {
                RenameSemantics::CopyThenDelete
            },
            multipart_write: !read_only,
            server_side_copy: !read_only,
            trash: false,
            native_open: false,
            ..Self::local(read_only)
        }
    }
    pub fn local(read_only: bool) -> Self {
        Self {
            hierarchy: HierarchySemantics::NativeDirectory,
            rename: if read_only {
                RenameSemantics::Unsupported
            } else {
                RenameSemantics::Atomic
            },
            create_directory: !read_only,
            write: !read_only,
            range_read: true,
            multipart_write: false,
            native_copy: false,
            server_side_copy: false,
            recursive_delete: !read_only,
            presigned_url: false,
            versioning: false,
            custom_metadata: false,
            tags: false,
            watch_changes: false,
            delete: !read_only,
            trash: !read_only
                && cfg!(any(
                    target_os = "macos",
                    target_os = "linux",
                    target_os = "windows"
                )),
            native_open: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StorageErrorCode {
    AuthenticationFailed,
    Network,
    Timeout,
    TrashUnavailable,
    InvalidConfiguration,
    InvalidPath,
    AccessDenied,
    NotFound,
    AlreadyExists,
    Conflict,
    Unsupported,
    Io,
    Internal,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct StorageError {
    pub code: StorageErrorCode,
    pub message: String,
    pub retryable: bool,
}

impl StorageError {
    pub fn new(code: StorageErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
        }
    }
}

pub type StorageResult<T> = Result<T, StorageError>;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct TransferSettings {
    /// Zero means unlimited. Limits are shared by all tasks in each direction.
    pub upload_kib_per_second: u32,
    pub download_kib_per_second: u32,
}

impl TransferSettings {
    pub fn validate(&self) -> StorageResult<()> {
        if self.upload_kib_per_second > 1_048_576 || self.download_kib_per_second > 1_048_576 {
            return Err(StorageError::new(
                StorageErrorCode::InvalidConfiguration,
                "速度限制需为 0 到 1048576 KiB/s 的整数，0 表示不限速",
            ));
        }
        Ok(())
    }
}

/// Portable, relative paths. Reject traversal rather than silently resolving it.
pub fn normalize_path(path: &str) -> StorageResult<String> {
    if path.starts_with('/') || path.contains('\\') || path.contains('\0') || path.contains(':') {
        return Err(StorageError::new(
            StorageErrorCode::InvalidPath,
            "路径必须是存储空间内的相对路径",
        ));
    }
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            ".." => {
                return Err(StorageError::new(
                    StorageErrorCode::InvalidPath,
                    "不允许访问上级路径",
                ))
            }
            "" | "." => {}
            _ => parts.push(part),
        }
    }
    Ok(parts.join("/"))
}

pub fn validate_name(name: &str) -> StorageResult<()> {
    if name.trim().is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', ':', '\0'])
    {
        return Err(StorageError::new(
            StorageErrorCode::InvalidPath,
            "名称不能为空，不能包含路径分隔符或保留字符",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn s3_provider_metadata_is_optional_and_survives_round_trip() {
        let legacy = serde_json::json!({
            "endpoint": "http://localhost:9000",
            "region": "us-east-1",
            "force_path_style": true
        });
        let mut config: S3ConnectionConfig = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(config.provider, None);
        assert_eq!(serde_json::to_value(&config).unwrap(), legacy);
        for provider in [
            S3Provider::Generic,
            S3Provider::Rustfs,
            S3Provider::Tos,
            S3Provider::Oss,
        ] {
            config.provider = Some(provider.clone());
            let saved = serde_json::to_value(&config).unwrap();
            let restored: S3ConnectionConfig = serde_json::from_value(saved).unwrap();
            assert_eq!(restored.provider, Some(provider));
            assert_eq!(restored.endpoint, config.endpoint);
            assert_eq!(restored.region, config.region);
            assert_eq!(restored.force_path_style, config.force_path_style);
        }
    }

    #[test]
    fn rejects_escape_and_normalizes_relative_paths() {
        for path in [
            "../secret",
            "a/../secret",
            "/etc/passwd",
            "C:\\secret",
            "a\0b",
            "a\\b",
        ] {
            assert!(normalize_path(path).is_err(), "{path}");
        }
        assert_eq!(normalize_path("./a//b/").unwrap(), "a/b");
        assert_eq!(normalize_path("").unwrap(), "");
    }
    #[test]
    fn read_only_disables_mutations() {
        let caps = StorageCapabilities::local(true);
        assert!(!caps.create_directory && !caps.delete && !caps.native_copy);
        assert!(matches!(caps.rename, RenameSemantics::Unsupported));
    }
}
