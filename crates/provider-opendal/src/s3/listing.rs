use super::*;
use aws_sdk_s3::{
    config::{BehaviorVersion, Credentials, Region},
    Client,
};
use std::{
    collections::{HashSet, VecDeque},
    time::Duration,
};
use storage_provider_api::DirectoryReader;

#[cfg(test)]
mod tests;

pub(super) fn client(config: &S3ConnectionConfig, credentials: &S3Credentials) -> Client {
    let mut builder = aws_sdk_s3::config::Builder::new()
        .behavior_version(BehaviorVersion::latest())
        .region(Region::new(config.region.clone()))
        .credentials_provider(Credentials::new(
            &credentials.access_key_id,
            &credentials.secret_access_key,
            credentials.session_token.clone(),
            None,
            "filo",
        ))
        .force_path_style(config.force_path_style)
        .timeout_config(
            aws_sdk_s3::config::timeout::TimeoutConfig::builder()
                .operation_timeout(Duration::from_secs(60))
                .build(),
        );
    if let Some(endpoint) = config.endpoint.as_ref().filter(|v| !v.is_empty()) {
        builder = builder.endpoint_url(endpoint);
    }
    Client::from_conf(builder.build())
}

struct S3Directory {
    backend: OpenDalS3Backend,
    root: String,
    prefix: String,
    token: Option<String>,
    done: bool,
    pending: VecDeque<StorageEntry>,
    strict: bool,
}

impl OpenDalS3Backend {
    fn listing(&self, parent: &StorageLocator, strict: bool) -> StorageResult<S3Directory> {
        let path = self.path(parent, false)?;
        let root = if self.prefix.is_empty() {
            String::new()
        } else {
            format!("{}/", self.prefix)
        };
        let prefix = if path.is_empty() {
            root.clone()
        } else {
            format!("{root}{path}/")
        };
        Ok(S3Directory {
            backend: self.clone(),
            root,
            prefix,
            token: None,
            done: false,
            pending: VecDeque::new(),
            strict,
        })
    }

    pub(super) async fn directory_reader(
        &self,
        parent: &StorageLocator,
    ) -> StorageResult<Box<dyn DirectoryReader>> {
        Ok(Box::new(self.listing(parent, false)?))
    }

    pub(super) async fn list_checked(
        &self,
        parent: &StorageLocator,
        strict: bool,
    ) -> StorageResult<Vec<StorageEntry>> {
        let mut reader = self.listing(parent, strict)?;
        let mut entries = Vec::new();
        let mut paths = HashSet::new();
        loop {
            let batch = reader.next_batch(500).await?;
            if batch.is_empty() {
                return Ok(entries);
            }
            for entry in batch {
                if !paths.insert(entry.locator.logical_path.clone()) {
                    return Err(StorageError::new(
                        StorageErrorCode::Unsupported,
                        "此 Prefix 包含同名文件和目录，需在 S3 控制台整理后浏览",
                    ));
                }
                entries.push(entry);
            }
        }
    }
}

impl S3Directory {
    fn unsupported(&self) -> StorageResult<Option<StorageEntry>> {
        if self.strict {
            Err(StorageError::new(
                StorageErrorCode::Unsupported,
                "文件夹包含不支持的 S3 对象名称，操作已停止",
            ))
        } else {
            Ok(None)
        }
    }

    fn entry(&self, key: &str, directory: bool) -> StorageResult<Option<StorageEntry>> {
        // Check the original key before stripping separators. Never turn `/file`
        // into `file`, or normalize `a/../b` into another object we could mutate.
        if directory && !key.is_empty() && key == self.prefix {
            return Ok(None);
        }
        let Some(child) = key.strip_prefix(&self.prefix) else {
            return self.unsupported();
        };
        let Some(path) = key.strip_prefix(&self.root) else {
            return self.unsupported();
        };
        let (child, path) = if directory {
            let (Some(child), Some(path)) = (child.strip_suffix('/'), path.strip_suffix('/'))
            else {
                return self.unsupported();
            };
            (child, path)
        } else {
            (child, path)
        };
        if child.is_empty()
            || child.contains('/')
            || path.is_empty()
            || !normalize_path(path).is_ok_and(|normal| normal == path)
        {
            return self.unsupported();
        }
        Ok(Some(StorageEntry {
            locator: StorageLocator {
                volume_id: self.backend.volume_id,
                logical_path: path.into(),
                version_id: None,
            },
            name: child.into(),
            kind: if directory {
                StorageEntryKind::VirtualPrefix
            } else {
                StorageEntryKind::File
            },
            size: None,
            modified_at: None,
            etag: None,
            content_type: None,
            metadata: serde_json::json!({}),
        }))
    }

    async fn fetch_page(&mut self) -> StorageResult<()> {
        let page = self
            .backend
            .s3_client
            .list_objects_v2()
            .bucket(&self.backend.bucket)
            .prefix(&self.prefix)
            .delimiter("/")
            .max_keys(500)
            .set_continuation_token(self.token.clone())
            .send()
            .await
            .map_err(crate::s3_admin::failure)?;
        let next = page
            .next_continuation_token()
            .filter(|token| !token.is_empty());
        let more = page.is_truncated().unwrap_or(next.is_some());
        if more && (next.is_none() || next == self.token.as_deref()) {
            return Err(StorageError::new(
                StorageErrorCode::Network,
                "S3 返回了无效的目录分页信息，请重试",
            ));
        }
        // Validate a whole page before committing cursor state, including strict traversal.
        let mut entries = VecDeque::new();
        for prefix in page.common_prefixes() {
            if let Some(entry) = self.entry(prefix.prefix().unwrap_or(""), true)? {
                entries.push_back(entry);
            }
        }
        for object in page.contents() {
            let key = object.key().unwrap_or("");
            let directory = key.ends_with('/');
            if let Some(mut entry) = self.entry(key, directory)? {
                entry.size = if directory {
                    None
                } else {
                    object.size().and_then(|size| u64::try_from(size).ok())
                };
                entry.modified_at = object.last_modified().map(ToString::to_string);
                entry.etag = object.e_tag().map(str::to_owned);
                entries.push_back(entry);
            }
        }
        self.pending = entries;
        self.token = next.map(str::to_owned);
        self.done = !more;
        Ok(())
    }
}

#[async_trait::async_trait]
impl DirectoryReader for S3Directory {
    async fn next_batch(&mut self, limit: usize) -> StorageResult<Vec<StorageEntry>> {
        let limit = limit.clamp(1, 500);
        let mut entries = Vec::new();
        while entries.len() < limit {
            if let Some(entry) = self.pending.pop_front() {
                entries.push(entry);
            } else if self.done {
                break;
            } else {
                self.fetch_page().await?;
            }
        }
        Ok(entries)
    }
}
