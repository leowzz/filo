use serde::{Deserialize, Serialize};
use storage_domain::StorageLocator;
use uuid::Uuid;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PhotoCatalog {
    pub archives: Vec<PhotoArchive>,
    pub sessions: Vec<PhotoSession>,
    pub photos: Vec<Photo>,
    pub preset: Option<PhotoPlanInput>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PhotoArchive {
    pub id: Uuid,
    pub jpg: StorageLocator,
    pub raw: StorageLocator,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PhotoLayout {
    Date,
    Batch,
    Original,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PhotoPlanInput {
    pub name: String,
    pub card_name: String,
    pub source: StorageLocator,
    pub jpg: StorageLocator,
    pub raw: StorageLocator,
    pub layout: PhotoLayout,
    pub keep_hierarchy: bool,
    pub date_override: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PhotoReviewPosition {
    pub current: Option<Uuid>,
    pub sort: PhotoSort,
    pub filter: String,
    pub minimum_rating: u8,
    pub auto_advance: bool,
    pub raw_only: bool,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PhotoSort {
    #[default]
    NameAsc,
    NameDesc,
    CaptureAsc,
    CaptureDesc,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PhotoSession {
    pub id: Uuid,
    pub archive_id: Uuid,
    pub name: String,
    pub card_name: String,
    pub created_at: String,
    /// Local binding only. Portable manifests contain relative source paths.
    pub source: Option<StorageLocator>,
    /// Folder-backed reviews persist their progress beside the photographs.
    #[serde(default)]
    pub directory: Option<StorageLocator>,
    pub layout: PhotoLayout,
    pub keep_hierarchy: bool,
    pub photo_ids: Vec<Uuid>,
    pub sources: Vec<PhotoSource>,
    pub revision: u64,
    pub synced_revision: u64,
    pub nas_hash: Option<String>,
    pub sync_error: Option<String>,
    pub handed_off: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_export: Option<PhotoExport>,
    pub position: PhotoReviewPosition,
    pub undo: Vec<PhotoUndo>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PhotoSource {
    pub file_id: Uuid,
    pub path: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PhotoFileKind {
    Raw,
    Jpg,
    Xmp,
    Acr,
}
impl PhotoFileKind {
    pub fn root(self) -> &'static str {
        if self == Self::Jpg {
            "jpg"
        } else {
            "raw"
        }
    }
    pub fn primary(self) -> bool {
        matches!(self, Self::Raw | Self::Jpg)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PhotoFile {
    pub id: Uuid,
    pub kind: PhotoFileKind,
    pub original_name: String,
    pub path: String,
    pub sha256: String,
    pub size: u64,
    pub verified: bool,
    pub error: Option<String>,
    #[serde(default)]
    pub observed_revision: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PhotoFlag {
    #[default]
    None,
    Pick,
    Reject,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Photo {
    pub id: Uuid,
    pub archive_id: Uuid,
    pub original_path: String,
    pub capture_date: Option<String>,
    #[serde(default)]
    pub capture_time: Option<String>,
    #[serde(default)]
    pub capture_time_loaded: bool,
    pub issues: Vec<String>,
    pub files: Vec<PhotoFile>,
    pub rating: u8,
    pub flag: PhotoFlag,
    pub excluded: bool,
    pub revision: u64,
    /// None means no sidecar was observed when the photo was planned.
    pub xmp_hash: Option<String>,
    pub xmp_synced_revision: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PhotoCaptureTime {
    pub id: Uuid,
    pub capture_time: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PhotoMark {
    pub rating: u8,
    pub flag: PhotoFlag,
}
impl From<&Photo> for PhotoMark {
    fn from(photo: &Photo) -> Self {
        Self {
            rating: photo.rating,
            flag: photo.flag,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PhotoUndo {
    pub photo_id: Uuid,
    pub before: PhotoMark,
    pub after: PhotoMark,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PhotoProgress {
    pub session_id: Uuid,
    pub completed: usize,
    pub total: usize,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PhotoReviewInput {
    pub name: String,
    pub jpg: StorageLocator,
    pub raw: Option<StorageLocator>,
    pub directory: bool,
    #[serde(default)]
    pub raw_only: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PhotoReviewStage {
    Connecting,
    Listing,
    Pairing,
    Saving,
}

#[derive(Clone, Debug, Serialize)]
pub struct PhotoReviewProgress {
    pub stage: PhotoReviewStage,
    pub found: usize,
    pub completed: usize,
    pub total: Option<usize>,
    pub path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PhotoPreview {
    pub mime: String,
    pub content: String,
    pub width: u32,
    pub height: u32,
    pub embedded: bool,
}

/// Focus area in normalized, display-oriented image coordinates.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct PhotoFocus {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct PhotoHandoff {
    pub directories: Vec<String>,
    pub failures: Vec<String>,
    pub jpg_only: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PhotoExport {
    pub directory: String,
    pub exported_at: String,
    #[serde(default)]
    pub filter: PhotoExportFilter,
    pub total: usize,
    pub copied: usize,
    pub skipped: usize,
    pub failures: Vec<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PhotoRatingFilter {
    Any,
    AtLeast,
    Exactly,
    AtMost,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct PhotoExportFilter {
    pub rating_mode: PhotoRatingFilter,
    pub rating: u8,
    pub flag: Option<PhotoFlag>,
}

impl Default for PhotoExportFilter {
    fn default() -> Self {
        Self {
            rating_mode: PhotoRatingFilter::AtLeast,
            rating: 3,
            flag: None,
        }
    }
}
