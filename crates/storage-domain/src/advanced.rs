use crate::*;
use std::collections::BTreeMap;

#[derive(Clone, Serialize, Deserialize)]
pub struct Preview {
    pub kind: String,
    pub mime: String,
    pub content: String,
    pub truncated: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub entry: StorageEntry,
    pub line: u64,
    pub snippet: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct ContentSearch {
    pub id: Uuid,
    pub hits: Vec<SearchHit>,
    pub scanned: u64,
    pub skipped: u64,
    pub errors: Vec<String>,
    pub done: bool,
    pub cancelled: bool,
    pub limited: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct ObjectVersion {
    pub key: String,
    pub version_id: String,
    pub latest: bool,
    pub delete_marker: bool,
    pub size: i64,
    pub modified: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct VersionPage {
    pub versions: Vec<ObjectVersion>,
    pub next_key: Option<String>,
    pub next_version: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct ObjectProperties {
    pub etag: String,
    pub content_type: String,
    pub metadata: BTreeMap<String, String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum S3Action {
    BucketStatus,
    CreateBucket {
        name: String,
    },
    DeleteBucket {
        confirmation: String,
    },
    SetVersioning {
        enabled: bool,
        confirmation: String,
    },
    Versions {
        #[serde(default)]
        exact: bool,
        key_marker: Option<String>,
        version_marker: Option<String>,
    },
    DeleteVersion {
        version: String,
        confirmation: String,
    },
    RestoreVersion {
        version: String,
        confirmation: String,
    },
    Share {
        expires: u64,
        version: Option<String>,
    },
    Properties,
    SetMetadata {
        etag: String,
        content_type: String,
        metadata: BTreeMap<String, String>,
    },
    Tags,
    SetTags {
        tags: BTreeMap<String, String>,
    },
    Acl,
    SetAcl {
        acl: String,
        confirmation: String,
    },
}
impl S3Action {
    pub fn writes(&self) -> bool {
        matches!(
            self,
            Self::CreateBucket { .. }
                | Self::DeleteBucket { .. }
                | Self::SetVersioning { .. }
                | Self::DeleteVersion { .. }
                | Self::RestoreVersion { .. }
                | Self::SetMetadata { .. }
                | Self::SetTags { .. }
                | Self::SetAcl { .. }
        )
    }
}
