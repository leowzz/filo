//! Disk-backed sorted snapshots keep directory enumeration and IPC memory bounded.
//! A fresh query scans once; subsequent pages never re-list the provider.
use crate::StorageService;
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use storage_domain::*;
use tokio::sync::{Mutex, Semaphore};
use uuid::Uuid;

struct Snapshot {
    connection: Mutex<SqliteConnection>,
    _directory: tempfile::TempDir,
    parent: StorageLocator,
    location: Option<(String, String)>,
    options: ListOptions,
    created: Instant,
    total: u64,
}

pub(super) struct Listings {
    snapshots: Mutex<HashMap<Uuid, Arc<Snapshot>>>,
    building: Semaphore,
}
impl Default for Listings {
    fn default() -> Self {
        Self {
            snapshots: Mutex::new(HashMap::new()),
            building: Semaphore::new(2),
        }
    }
}
fn failure(_: impl std::fmt::Display) -> StorageError {
    StorageError::new(
        StorageErrorCode::Io,
        "无法读取目录分页，请检查本机可用空间后刷新",
    )
}
fn expired() -> StorageError {
    StorageError::new(
        StorageErrorCode::Conflict,
        "目录分页已过期或位置已变化，请刷新目录",
    )
}

impl StorageService {
    pub async fn list_entries_page(
        &self,
        mut parent: StorageLocator,
        options: ListOptions,
        cursor: Option<String>,
        limit: usize,
    ) -> StorageResult<EntryPage> {
        parent.logical_path = normalize_path(&parent.logical_path)?;
        if parent.version_id.is_some() || options.search.len() > 1024 {
            return Err(StorageError::new(
                StorageErrorCode::InvalidPath,
                "无效的目录查询",
            ));
        }
        let limit = limit.clamp(1, 500);
        // Revalidate authority even for cached pages (removed or re-rooted connections).
        let _guard = self.mutation_lock.read().await;
        let backend = self.backend(parent.volume_id).await?;
        let (id, offset, snapshot) = if let Some(cursor) = cursor {
            let (id, offset) = cursor.split_once(':').ok_or_else(expired)?;
            let id = Uuid::parse_str(id).map_err(|_| expired())?;
            let offset = offset.parse::<u64>().map_err(|_| expired())?;
            let snapshot = self
                .listings
                .snapshots
                .lock()
                .await
                .get(&id)
                .cloned()
                .ok_or_else(expired)?;
            if snapshot.created.elapsed() > Duration::from_secs(1800)
                || snapshot.parent.volume_id != parent.volume_id
                || snapshot.parent.logical_path != parent.logical_path
                || snapshot.location != backend.storage_path(&parent)
                || snapshot.options != options
                || offset > snapshot.total
            {
                return Err(expired());
            }
            (id, offset, snapshot)
        } else {
            let _permit = self.listings.building.acquire().await.map_err(failure)?;
            let directory = tempfile::tempdir().map_err(failure)?;
            let mut connection = SqliteConnection::connect_with(
                &SqliteConnectOptions::new()
                    .filename(directory.path().join("entries.sqlite"))
                    .create_if_missing(true),
            )
            .await
            .map_err(failure)?;
            sqlx::query("PRAGMA cache_size = -2048")
                .execute(&mut connection)
                .await
                .map_err(failure)?;
            sqlx::query("PRAGMA temp_store = FILE")
                .execute(&mut connection)
                .await
                .map_err(failure)?;
            sqlx::query("CREATE TABLE entries (path TEXT PRIMARY KEY, name TEXT NOT NULL, directory INTEGER NOT NULL, size INTEGER NOT NULL, modified TEXT NOT NULL, value TEXT NOT NULL)").execute(&mut connection).await.map_err(failure)?;
            let mut reader = backend.open_listing(&parent).await?;
            let search = options.search.to_lowercase();
            let mut total = 0u64;
            loop {
                let batch = reader.next_batch(500).await?;
                if batch.is_empty() {
                    break;
                }
                let mut transaction = connection.begin().await.map_err(failure)?;
                for entry in batch {
                    let directory = crate::tree::directory(&entry);
                    if (!options.show_hidden && entry.name.starts_with('.'))
                        || (options.folders_only && !directory)
                        || !entry.name.to_lowercase().contains(&search)
                    {
                        continue;
                    }
                    let result = sqlx::query("INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?)")
                        .bind(&entry.locator.logical_path)
                        .bind(entry.name.to_lowercase())
                        .bind(directory)
                        .bind(entry.size.unwrap_or(0).min(i64::MAX as u64) as i64)
                        .bind(entry.modified_at.as_deref().unwrap_or(""))
                        .bind(serde_json::to_string(&entry).map_err(failure)?)
                        .execute(&mut *transaction)
                        .await;
                    if let Err(error) = result {
                        if error
                            .as_database_error()
                            .is_some_and(|error| error.is_unique_violation())
                        {
                            return Err(StorageError::new(
                                StorageErrorCode::Conflict,
                                "目录包含同名文件与文件夹，请先整理名称",
                            ));
                        }
                        return Err(failure(error));
                    }
                    total += 1;
                }
                transaction.commit().await.map_err(failure)?;
            }
            let order = order(&options.sort);
            sqlx::query(&format!("CREATE INDEX page_order ON entries ({order})"))
                .execute(&mut connection)
                .await
                .map_err(failure)?;
            let snapshot = Arc::new(Snapshot {
                connection: Mutex::new(connection),
                _directory: directory,
                parent: parent.clone(),
                location: backend.storage_path(&parent),
                options: options.clone(),
                created: Instant::now(),
                total,
            });
            let mut snapshots = self.listings.snapshots.lock().await;
            snapshots.retain(|_, snapshot| snapshot.created.elapsed() < Duration::from_secs(1800));
            while snapshots.len() >= 8 {
                let oldest = *snapshots
                    .iter()
                    .min_by_key(|(_, snapshot)| snapshot.created)
                    .unwrap()
                    .0;
                snapshots.remove(&oldest);
            }
            let id = Uuid::new_v4();
            snapshots.insert(id, snapshot.clone());
            (id, 0, snapshot)
        };
        let rows = sqlx::query(&format!(
            "SELECT value FROM entries ORDER BY {} LIMIT ? OFFSET ?",
            order(&options.sort)
        ))
        .bind(limit as i64)
        .bind(offset as i64)
        .fetch_all(&mut *snapshot.connection.lock().await)
        .await
        .map_err(failure)?;
        let entries: Vec<StorageEntry> = rows
            .into_iter()
            .map(|row| serde_json::from_str(row.get("value")).map_err(failure))
            .collect::<StorageResult<_>>()?;
        let next = offset + entries.len() as u64;
        Ok(EntryPage {
            entries,
            total: snapshot.total,
            next_cursor: (next < snapshot.total).then(|| format!("{id}:{next}")),
        })
    }
}

fn order(sort: &EntrySort) -> &'static str {
    match sort {
        EntrySort::Name => "directory DESC, name ASC, path ASC",
        EntrySort::Size => "directory DESC, size DESC, name ASC, path ASC",
        EntrySort::Modified => "directory DESC, modified DESC, name ASC, path ASC",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use storage_repository::Repository;
    #[tokio::test]
    async fn pages_are_bounded_sorted_filter_entire_directory_and_revalidate_cursors() {
        let files = tempfile::tempdir().unwrap();
        let database = tempfile::tempdir().unwrap();
        for i in 0..1203 {
            std::fs::write(
                files.path().join(format!("file-{i:04}.txt")),
                vec![0; i % 20],
            )
            .unwrap();
        }
        std::fs::create_dir(files.path().join("a-folder")).unwrap();
        std::fs::write(files.path().join(".hidden"), []).unwrap();
        let service = StorageService::new(
            Repository::open(&database.path().join("test.sqlite"))
                .await
                .unwrap(),
        );
        let volume = service
            .add_selected_directory(files.path().into(), false)
            .await
            .unwrap();
        let parent = StorageLocator {
            volume_id: volume.id,
            logical_path: String::new(),
            version_id: None,
        };
        let options = ListOptions::default();
        let first = service
            .list_entries_page(parent.clone(), options.clone(), None, 200)
            .await
            .unwrap();
        assert_eq!(first.total, 1204);
        assert_eq!(first.entries.len(), 200);
        assert_eq!(first.entries[0].name, "a-folder");
        let mut names = std::collections::HashSet::new();
        names.extend(first.entries.iter().map(|entry| entry.name.clone()));
        let mut cursor = first.next_cursor.clone();
        while cursor.is_some() {
            let page = service
                .list_entries_page(parent.clone(), options.clone(), cursor, 200)
                .await
                .unwrap();
            assert!(page.entries.len() <= 200);
            for entry in &page.entries {
                assert!(names.insert(entry.name.clone()));
            }
            cursor = page.next_cursor;
        }
        assert_eq!(names.len(), 1204);
        let search = ListOptions {
            search: "file-1202".into(),
            ..options.clone()
        };
        let result = service
            .list_entries_page(parent.clone(), search.clone(), None, 200)
            .await
            .unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.entries[0].name, "file-1202.txt");
        assert!(service
            .list_entries_page(parent.clone(), search, first.next_cursor.clone(), 200)
            .await
            .is_err());
        let sizes = service
            .list_entries_page(
                parent.clone(),
                ListOptions {
                    sort: EntrySort::Size,
                    ..options.clone()
                },
                None,
                20,
            )
            .await
            .unwrap();
        assert_eq!(sizes.entries[1].size, Some(19));
        let folders = service
            .list_entries_page(
                parent.clone(),
                ListOptions {
                    folders_only: true,
                    ..options.clone()
                },
                None,
                20,
            )
            .await
            .unwrap();
        assert_eq!(folders.total, 1);
        let hidden = service
            .list_entries_page(
                parent.clone(),
                ListOptions {
                    show_hidden: true,
                    ..options.clone()
                },
                None,
                20,
            )
            .await
            .unwrap();
        assert_eq!(hidden.total, 1205);
        // A snapshot remains stable across external changes; refresh starts a new one.
        std::fs::write(files.path().join("new-file"), []).unwrap();
        let cached = service
            .list_entries_page(
                parent.clone(),
                options.clone(),
                first.next_cursor.clone(),
                200,
            )
            .await
            .unwrap();
        assert_eq!(cached.total, 1204);
        assert_eq!(
            service
                .list_entries_page(parent.clone(), options.clone(), None, 200)
                .await
                .unwrap()
                .total,
            1205
        );
        service.remove_local_storage(volume.id, true).await.unwrap();
        assert!(service
            .list_entries_page(parent, options, first.next_cursor, 200)
            .await
            .is_err());
    }
}
