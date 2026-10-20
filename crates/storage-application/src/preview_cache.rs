use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};
use storage_domain::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviewCacheSettings {
    pub max_bytes: u64,
    pub max_age_days: u32,
}

impl Default for PreviewCacheSettings {
    fn default() -> Self {
        Self {
            max_bytes: 1024 * 1024 * 1024,
            max_age_days: 30,
        }
    }
}

impl PreviewCacheSettings {
    fn validate(self) -> StorageResult<()> {
        if self.max_bytes == 0
            || self.max_bytes > 1024 * 1024 * 1024 * 1024
            || !(1..=3650).contains(&self.max_age_days)
        {
            return Err(StorageError::new(
                StorageErrorCode::InvalidConfiguration,
                "缓存空间须大于 0 且不超过 1024 GB，保留时间须为 1 到 3650 天",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
pub struct PreviewCacheInfo {
    pub settings: PreviewCacheSettings,
    pub used_bytes: u64,
    pub directory: String,
}

#[derive(Clone)]
pub struct PreviewCache(Arc<Mutex<Cache>>);

struct Entry {
    size: u64,
    accessed: SystemTime,
}

struct Cache {
    root: PathBuf,
    config: PathBuf,
    settings: PreviewCacheSettings,
    entries: HashMap<String, Entry>,
}

fn cache_error(_: impl std::fmt::Display) -> StorageError {
    StorageError::new(
        StorageErrorCode::Internal,
        "无法读取或保存预览缓存，请检查应用缓存目录权限",
    )
}

// Do not cache sources that cannot expose a revision. Keys contain no readable
// source paths, and distinguish renderer versions and all preview variants.
pub(crate) fn key(entry: &StorageEntry, variant: &str) -> Option<String> {
    if entry.etag.is_none() && entry.modified_at.is_none() && entry.locator.version_id.is_none() {
        return None;
    }
    let source = serde_json::to_vec(&(
        "preview-v1",
        variant,
        &entry.locator,
        entry.size,
        &entry.modified_at,
        &entry.etag,
    ))
    .ok()?;
    Some(format!("{:x}", Sha256::digest(source)))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().expect("cache paths have parents");
    fs::create_dir_all(parent)?;
    let mut file = tempfile::Builder::new()
        .prefix(".preview-")
        .tempfile_in(parent)?;
    file.write_all(bytes)?;
    file.persist(path).map_err(|error| error.error)?;
    Ok(())
}

impl Cache {
    fn used(&self) -> u64 {
        self.entries.values().map(|entry| entry.size).sum()
    }

    fn remove(&mut self, key: &str) -> std::io::Result<()> {
        match fs::remove_file(self.root.join(format!("{key}.cache"))) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        self.entries.remove(key);
        Ok(())
    }

    fn prune(&mut self, now: SystemTime, limit: u64) -> std::io::Result<()> {
        let age = Duration::from_secs(u64::from(self.settings.max_age_days) * 86400);
        let expired: Vec<_> = self
            .entries
            .iter()
            .filter(|(_, entry)| now.duration_since(entry.accessed).unwrap_or_default() >= age)
            .map(|(key, _)| key.clone())
            .collect();
        for key in expired {
            self.remove(&key)?;
        }
        let mut used = self.used();
        if used > limit {
            let mut oldest: Vec<_> = self
                .entries
                .iter()
                .map(|(key, entry)| (entry.accessed, key.clone(), entry.size))
                .collect();
            oldest.sort_unstable();
            for (_, key, size) in oldest {
                if used <= limit {
                    break;
                }
                self.remove(&key)?;
                used -= size;
            }
        }
        Ok(())
    }

    fn info(&self) -> PreviewCacheInfo {
        PreviewCacheInfo {
            settings: self.settings,
            used_bytes: self.used(),
            directory: self.root.to_string_lossy().into_owned(),
        }
    }
}

impl PreviewCache {
    pub async fn open(root: PathBuf, config: PathBuf) -> StorageResult<Self> {
        tokio::task::spawn_blocking(move || {
            let settings = match fs::read(&config) {
                Ok(bytes) => {
                    serde_json::from_slice::<PreviewCacheSettings>(&bytes).map_err(cache_error)?
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    PreviewCacheSettings::default()
                }
                Err(error) => return Err(cache_error(error)),
            };
            settings.validate()?;
            fs::create_dir_all(&root).map_err(cache_error)?;
            let mut cache = Cache {
                root,
                config,
                settings,
                entries: HashMap::new(),
            };
            for entry in fs::read_dir(&cache.root).map_err(cache_error)? {
                let entry = entry.map_err(cache_error)?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with(".preview-") {
                    let _ = fs::remove_file(entry.path());
                    continue;
                }
                let Some(key) = name.strip_suffix(".cache").filter(|key| {
                    key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit())
                }) else {
                    continue;
                };
                let metadata = entry.metadata().map_err(cache_error)?;
                if !metadata.is_file() {
                    continue;
                }
                cache.entries.insert(
                    key.into(),
                    Entry {
                        size: metadata.len(),
                        accessed: metadata.modified().map_err(cache_error)?,
                    },
                );
            }
            cache
                .prune(SystemTime::now(), settings.max_bytes)
                .map_err(cache_error)?;
            Ok(Self(Arc::new(Mutex::new(cache))))
        })
        .await
        .map_err(cache_error)?
    }

    pub(crate) async fn get<T: DeserializeOwned + Send + 'static>(&self, key: &str) -> Option<T> {
        let cache = self.clone();
        let key = key.to_owned();
        tokio::task::spawn_blocking(move || {
            let mut cache = cache.0.lock().ok()?;
            let now = SystemTime::now();
            let limit = cache.settings.max_bytes;
            cache.prune(now, limit).ok()?;
            if !cache.entries.contains_key(&key) {
                return None;
            }
            let path = cache.root.join(format!("{key}.cache"));
            let value = fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok());
            if value.is_none() {
                let _ = cache.remove(&key);
                return None;
            }
            // mtime records LRU access across restarts; the expiry is sliding.
            // Windows requires a writable handle to update file timestamps.
            fs::File::options()
                .write(true)
                .open(path)
                .ok()?
                .set_modified(now)
                .ok()?;
            cache.entries.get_mut(&key)?.accessed = now;
            value
        })
        .await
        .ok()
        .flatten()
    }

    pub(crate) async fn put<T: Serialize + Send + 'static>(&self, key: String, value: T) {
        let cache = self.clone();
        // Cache I/O is best effort. Source preview failures still propagate normally.
        let _ = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            let bytes = serde_json::to_vec(&value)?;
            let mut cache = cache
                .0
                .lock()
                .map_err(|_| std::io::Error::other("cache lock"))?;
            if bytes.len() as u64 > cache.settings.max_bytes {
                return Ok(());
            }
            cache.remove(&key)?;
            let available = cache.settings.max_bytes - bytes.len() as u64;
            cache.prune(SystemTime::now(), available)?;
            atomic_write(&cache.root.join(format!("{key}.cache")), &bytes)?;
            cache.entries.insert(
                key,
                Entry {
                    size: bytes.len() as u64,
                    accessed: SystemTime::now(),
                },
            );
            Ok(())
        })
        .await;
    }

    pub async fn info(&self) -> StorageResult<PreviewCacheInfo> {
        let cache = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut cache = cache.0.lock().map_err(cache_error)?;
            let limit = cache.settings.max_bytes;
            cache.prune(SystemTime::now(), limit).map_err(cache_error)?;
            Ok(cache.info())
        })
        .await
        .map_err(cache_error)?
    }

    pub async fn configure(
        &self,
        settings: PreviewCacheSettings,
    ) -> StorageResult<PreviewCacheInfo> {
        settings.validate()?;
        let cache = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut cache = cache.0.lock().map_err(cache_error)?;
            atomic_write(
                &cache.config,
                &serde_json::to_vec(&settings).map_err(cache_error)?,
            )
            .map_err(cache_error)?;
            cache.settings = settings;
            cache
                .prune(SystemTime::now(), settings.max_bytes)
                .map_err(cache_error)?;
            Ok(cache.info())
        })
        .await
        .map_err(cache_error)?
    }

    pub async fn clear(&self) -> StorageResult<PreviewCacheInfo> {
        let cache = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut cache = cache.0.lock().map_err(cache_error)?;
            let keys: Vec<_> = cache.entries.keys().cloned().collect();
            for key in keys {
                cache.remove(&key).map_err(cache_error)?;
            }
            Ok(cache.info())
        })
        .await
        .map_err(cache_error)?
    }
}

impl crate::StorageService {
    pub fn with_preview_cache(mut self, cache: PreviewCache) -> Self {
        self.preview_cache = Some(cache);
        self
    }

    fn disk_cache(&self) -> StorageResult<&PreviewCache> {
        self.preview_cache
            .as_ref()
            .ok_or_else(|| StorageError::new(StorageErrorCode::Unsupported, "预览缓存尚未启用"))
    }

    pub async fn preview_cache_info(&self) -> StorageResult<PreviewCacheInfo> {
        self.disk_cache()?.info().await
    }
    pub async fn configure_preview_cache(
        &self,
        settings: PreviewCacheSettings,
    ) -> StorageResult<PreviewCacheInfo> {
        self.disk_cache()?.configure(settings).await
    }
    pub async fn clear_preview_cache(&self) -> StorageResult<PreviewCacheInfo> {
        self.disk_cache()?.clear().await
    }
}

#[cfg(test)]
#[path = "preview_cache_tests.rs"]
mod tests;
