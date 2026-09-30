//! Provider-order browsing reads only the next batch. Disk-cached pages make
//! retries idempotent without keeping every loaded entry in backend memory.
use super::*;
use sqlx::sqlite::{SqliteJournalMode, SqliteSynchronous};
use storage_provider_api::{DirectoryReader, StorageBackend};

pub(super) struct Stream {
    parent: StorageLocator,
    location: Option<(String, String)>,
    options: ListOptions,
    limit: usize,
    created: Instant,
    state: Mutex<StreamState>,
}

struct StreamState {
    connection: SqliteConnection,
    _directory: tempfile::TempDir,
    reader: Box<dyn DirectoryReader>,
    pending: Option<Vec<StorageEntry>>,
    page: u64,
    total: u64,
    done: bool,
}

impl StorageService {
    pub(super) async fn stream_entries_page(
        &self,
        backend: Arc<dyn StorageBackend>,
        parent: StorageLocator,
        options: ListOptions,
        cursor: Option<String>,
        limit: usize,
    ) -> StorageResult<EntryPage> {
        let (id, page, stream) = if let Some(cursor) = cursor {
            let mut parts = cursor.split(':');
            if parts.next() != Some("stream") {
                return Err(expired());
            }
            let id = parts
                .next()
                .ok_or_else(expired)?
                .parse::<Uuid>()
                .map_err(|_| expired())?;
            let page = parts
                .next()
                .ok_or_else(expired)?
                .parse::<u64>()
                .map_err(|_| expired())?;
            if parts.next().is_some() {
                return Err(expired());
            }
            let stream = self
                .listings
                .streams
                .lock()
                .await
                .get(&id)
                .cloned()
                .ok_or_else(expired)?;
            if stream.created.elapsed() > Duration::from_secs(1800)
                || stream.parent != parent
                || stream.location != backend.storage_path(&parent)
                || stream.options != options
                || stream.limit != limit
            {
                return Err(expired());
            }
            (id, page, stream)
        } else {
            let directory = tempfile::tempdir().map_err(failure)?;
            let mut connection = SqliteConnection::connect_with(
                &SqliteConnectOptions::new()
                    .filename(directory.path().join("pages.sqlite"))
                    .create_if_missing(true)
                    // This cache is disposable; crash durability is unnecessary.
                    .journal_mode(SqliteJournalMode::Memory)
                    .synchronous(SqliteSynchronous::Off),
            )
            .await
            .map_err(failure)?;
            sqlx::query("CREATE TABLE pages (page INTEGER PRIMARY KEY, value TEXT NOT NULL)")
                .execute(&mut connection)
                .await
                .map_err(failure)?;
            sqlx::query("CREATE TABLE paths (path TEXT PRIMARY KEY)")
                .execute(&mut connection)
                .await
                .map_err(failure)?;
            let reader = backend.open_listing(&parent).await?;
            let stream = Arc::new(Stream {
                location: backend.storage_path(&parent),
                parent,
                options: options.clone(),
                limit,
                created: Instant::now(),
                state: Mutex::new(StreamState {
                    connection,
                    _directory: directory,
                    reader,
                    pending: None,
                    page: 0,
                    total: 0,
                    done: false,
                }),
            });
            let mut streams = self.listings.streams.lock().await;
            streams.retain(|_, stream| stream.created.elapsed() < Duration::from_secs(1800));
            while streams.len() >= 8 {
                let oldest = *streams
                    .iter()
                    .min_by_key(|(_, stream)| stream.created)
                    .unwrap()
                    .0;
                streams.remove(&oldest);
            }
            let id = Uuid::new_v4();
            streams.insert(id, stream.clone());
            (id, 0, stream)
        };
        let mut state = stream.state.lock().await;
        if let Some(row) = sqlx::query("SELECT value FROM pages WHERE page = ?")
            .bind(page as i64)
            .fetch_optional(&mut state.connection)
            .await
            .map_err(failure)?
        {
            return serde_json::from_str(row.get("value")).map_err(failure);
        }
        if page != state.page || state.done {
            return Err(expired());
        }
        if state.pending.is_none() {
            state.pending = Some(state.reader.next_batch(limit).await?);
        }
        let batch = state.pending.as_ref().unwrap();
        let done = batch.is_empty() || state.reader.is_exhausted();
        let entries = batch
            .iter()
            .filter(|entry| {
                (options.show_hidden || !entry.name.starts_with('.'))
                    && (!options.folders_only || crate::tree::directory(entry))
            })
            .cloned()
            .collect::<Vec<_>>();
        let response = EntryPage {
            total: state.total + entries.len() as u64,
            total_is_exact: done,
            next_cursor: (!done).then(|| format!("stream:{id}:{}", page + 1)),
            entries,
        };
        let mut transaction = state.connection.begin().await.map_err(failure)?;
        if !response.entries.is_empty() {
            let mut insert = QueryBuilder::new("INSERT INTO paths (path) ");
            insert.push_values(&response.entries, |mut row, entry| {
                row.push_bind(&entry.locator.logical_path);
            });
            if let Err(error) = insert.build().execute(&mut *transaction).await {
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
        }
        sqlx::query("INSERT INTO pages VALUES (?, ?)")
            .bind(page as i64)
            .bind(serde_json::to_string(&response).map_err(failure)?)
            .execute(&mut *transaction)
            .await
            .map_err(failure)?;
        transaction.commit().await.map_err(failure)?;
        state.pending = None;
        state.page += 1;
        state.total = response.total;
        state.done = done;
        Ok(response)
    }
}

#[cfg(test)]
mod tests;
