use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
    Row, SqlitePool,
};
use std::path::Path;
use storage_domain::*;
use uuid::Uuid;

#[derive(Clone)]
pub struct Repository {
    pool: SqlitePool,
}

fn database_error(_: impl std::fmt::Display) -> StorageError {
    StorageError::new(StorageErrorCode::Internal, "无法读取或保存本地配置数据库")
}

impl Repository {
    pub async fn transfer_settings(&self) -> StorageResult<TransferSettings> {
        let row = sqlx::query("SELECT upload_kib_per_second, download_kib_per_second FROM transfer_settings WHERE id = 1")
            .fetch_one(&self.pool).await.map_err(database_error)?;
        Ok(TransferSettings {
            upload_kib_per_second: row.get::<i64, _>("upload_kib_per_second") as u32,
            download_kib_per_second: row.get::<i64, _>("download_kib_per_second") as u32,
        })
    }

    pub async fn save_transfer_settings(&self, settings: TransferSettings) -> StorageResult<()> {
        settings.validate()?;
        sqlx::query("UPDATE transfer_settings SET upload_kib_per_second = ?, download_kib_per_second = ? WHERE id = 1")
            .bind(i64::from(settings.upload_kib_per_second)).bind(i64::from(settings.download_kib_per_second))
            .execute(&self.pool).await.map_err(database_error)?;
        Ok(())
    }
    pub async fn open(path: &Path) -> StorageResult<Self> {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal);
        let pool = SqlitePoolOptions::new()
            .max_connections(3)
            .connect_with(options)
            .await
            .map_err(database_error)?;
        sqlx::migrate!("../../migrations")
            .run(&pool)
            .await
            .map_err(database_error)?;
        sqlx::query("UPDATE transfer_jobs SET state = 'interrupted' WHERE state IN ('running', 'verifying', 'queued')")
            .execute(&pool).await.map_err(database_error)?;
        Ok(Self { pool })
    }

    pub async fn list_connections(&self) -> StorageResult<Vec<StorageConnection>> {
        let rows = sqlx::query("SELECT * FROM connections ORDER BY created_at, id")
            .fetch_all(&self.pool)
            .await
            .map_err(database_error)?;
        rows.into_iter()
            .map(|row| {
                Ok(StorageConnection {
                    id: Uuid::parse_str(row.get("id")).map_err(database_error)?,
                    name: row.get("name"),
                    provider: serde_json::from_value(serde_json::Value::String(
                        row.get("provider"),
                    ))
                    .map_err(database_error)?,
                    config: serde_json::from_str(row.get("config_json")).map_err(database_error)?,
                    credential_ref: row.get("credential_ref"),
                    enabled: row.get("enabled"),
                })
            })
            .collect()
    }

    pub async fn save_transfer(&self, job: &TransferJob) -> StorageResult<()> {
        sqlx::query("INSERT INTO transfer_jobs (id, kind, source_json, destination_json, state, bytes_total, bytes_transferred, error_code, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET destination_json = excluded.destination_json, state = excluded.state, bytes_total = excluded.bytes_total, bytes_transferred = excluded.bytes_transferred, error_code = excluded.error_code, error_message = excluded.error_message, updated_at = excluded.updated_at")
            .bind(job.id.to_string())
            .bind(serde_json::to_value(job.kind).map_err(database_error)?.as_str().unwrap_or_default())
            .bind(serde_json::to_string(&job.source).map_err(database_error)?)
            .bind(serde_json::to_string(&job.destination).map_err(database_error)?)
            .bind(serde_json::to_value(job.state).map_err(database_error)?.as_str().unwrap_or_default())
            .bind(job.bytes_total.map(|size| size as i64)).bind(job.bytes_transferred as i64)
            .bind(job.error_code.as_ref().map(serde_json::to_string).transpose().map_err(database_error)?)
            .bind(&job.error_message).bind(&job.created_at).bind(&job.updated_at)
            .execute(&self.pool).await.map_err(database_error)?;
        Ok(())
    }

    pub async fn list_transfers(&self) -> StorageResult<Vec<TransferJob>> {
        let rows =
            sqlx::query("SELECT * FROM transfer_jobs ORDER BY created_at DESC, id DESC LIMIT 200")
                .fetch_all(&self.pool)
                .await
                .map_err(database_error)?;
        rows.into_iter()
            .map(|row| {
                Ok(TransferJob {
                    id: Uuid::parse_str(row.get("id")).map_err(database_error)?,
                    kind: serde_json::from_value(serde_json::Value::String(row.get("kind")))
                        .map_err(database_error)?,
                    source: serde_json::from_str(row.get("source_json")).map_err(database_error)?,
                    destination: serde_json::from_str(row.get("destination_json"))
                        .map_err(database_error)?,
                    state: serde_json::from_value(serde_json::Value::String(row.get("state")))
                        .map_err(database_error)?,
                    bytes_total: row
                        .get::<Option<i64>, _>("bytes_total")
                        .map(|size| size as u64),
                    bytes_transferred: row.get::<i64, _>("bytes_transferred") as u64,
                    error_code: row
                        .get::<Option<String>, _>("error_code")
                        .map(|value| serde_json::from_str(&value))
                        .transpose()
                        .map_err(database_error)?,
                    error_message: row.get("error_message"),
                    created_at: row.get("created_at"),
                    updated_at: row.get("updated_at"),
                })
            })
            .collect()
    }

    pub async fn list_volumes(&self) -> StorageResult<Vec<StorageVolume>> {
        let rows = sqlx::query("SELECT * FROM volumes ORDER BY created_at, id")
            .fetch_all(&self.pool)
            .await
            .map_err(database_error)?;
        rows.into_iter()
            .map(|row| {
                Ok(StorageVolume {
                    id: Uuid::parse_str(row.get("id")).map_err(database_error)?,
                    connection_id: Uuid::parse_str(row.get("connection_id"))
                        .map_err(database_error)?,
                    name: row.get("name"),
                    root: serde_json::from_str(row.get("root_json")).map_err(database_error)?,
                    read_only: row.get("read_only"),
                })
            })
            .collect()
    }

    pub async fn add_local(
        &self,
        root_path: &Path,
        read_only: bool,
    ) -> StorageResult<StorageVolume> {
        if let Some(volume) = self.list_volumes().await?.into_iter().find(|volume| matches!(&volume.root, VolumeRoot::Local { root_path: saved } if saved == root_path)) {
            return Ok(volume);
        }
        let name = root_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Local disk".into());
        let volume = StorageVolume {
            id: Uuid::new_v4(),
            connection_id: Uuid::new_v4(),
            name,
            root: VolumeRoot::Local {
                root_path: root_path.to_path_buf(),
            },
            read_only,
        };
        let mut tx = self.pool.begin().await.map_err(database_error)?;
        sqlx::query("INSERT INTO connections (id, name, provider, config_json) VALUES (?, ?, 'local_fs', '{}')")
            .bind(volume.connection_id.to_string()).bind(&volume.name).execute(&mut *tx).await.map_err(database_error)?;
        sqlx::query("INSERT INTO volumes (id, connection_id, name, root_json, read_only) VALUES (?, ?, ?, ?, ?)")
            .bind(volume.id.to_string()).bind(volume.connection_id.to_string()).bind(&volume.name)
            .bind(serde_json::to_string(&volume.root).map_err(database_error)?).bind(read_only)
            .execute(&mut *tx).await.map_err(database_error)?;
        tx.commit().await.map_err(database_error)?;
        Ok(volume)
    }

    pub async fn save_s3(
        &self,
        connection: &StorageConnection,
        volume: &StorageVolume,
    ) -> StorageResult<()> {
        let mut tx = self.pool.begin().await.map_err(database_error)?;
        sqlx::query("INSERT INTO connections (id, name, provider, config_json, credential_ref) VALUES (?, ?, 's3', ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, config_json=excluded.config_json, credential_ref=excluded.credential_ref, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')")
            .bind(connection.id.to_string()).bind(&connection.name)
            .bind(serde_json::to_string(&connection.config).map_err(database_error)?)
            .bind(&connection.credential_ref).execute(&mut *tx).await.map_err(database_error)?;
        sqlx::query("INSERT INTO volumes (id, connection_id, name, root_json, read_only) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, root_json=excluded.root_json, read_only=excluded.read_only, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')")
            .bind(volume.id.to_string()).bind(volume.connection_id.to_string()).bind(&volume.name)
            .bind(serde_json::to_string(&volume.root).map_err(database_error)?).bind(volume.read_only)
            .execute(&mut *tx).await.map_err(database_error)?;
        tx.commit().await.map_err(database_error)
    }

    /// Removes saved configuration only; never touches the local filesystem.
    pub async fn remove_local(&self, volume_id: Uuid) -> StorageResult<()> {
        let mut tx = self.pool.begin().await.map_err(database_error)?;
        let connection_id: Option<String> =
            sqlx::query_scalar("DELETE FROM volumes WHERE id = ? RETURNING connection_id")
                .bind(volume_id.to_string())
                .fetch_optional(&mut *tx)
                .await
                .map_err(database_error)?;
        let Some(connection_id) = connection_id else {
            return Err(StorageError::new(
                StorageErrorCode::NotFound,
                "未找到该位置",
            ));
        };
        sqlx::query("DELETE FROM connections WHERE id = ? AND NOT EXISTS (SELECT 1 FROM volumes WHERE connection_id = ?)")
            .bind(&connection_id).bind(&connection_id).execute(&mut *tx).await.map_err(database_error)?;
        tx.commit().await.map_err(database_error)
    }

    /// A local connection has one volume. Persist its display name, root and
    /// access mode together so a failed root change cannot partially save.
    pub async fn update_local(&self, volume: &StorageVolume) -> StorageResult<()> {
        let mut tx = self.pool.begin().await.map_err(database_error)?;
        let connection = sqlx::query("UPDATE connections SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND provider = 'local_fs'")
            .bind(&volume.name).bind(volume.connection_id.to_string())
            .execute(&mut *tx).await.map_err(database_error)?;
        if connection.rows_affected() != 1 {
            return Err(StorageError::new(
                StorageErrorCode::NotFound,
                "未找到本地连接",
            ));
        }
        let result = sqlx::query("UPDATE volumes SET name = ?, root_json = ?, read_only = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND connection_id = ?")
            .bind(&volume.name)
            .bind(serde_json::to_string(&volume.root).map_err(database_error)?)
            .bind(volume.read_only).bind(volume.id.to_string()).bind(volume.connection_id.to_string())
            .execute(&mut *tx).await.map_err(|error| {
                if error.as_database_error().is_some_and(|error| error.is_unique_violation()) {
                    StorageError::new(StorageErrorCode::AlreadyExists, "该目录已添加为其他位置，请选择另一个目录")
                } else { database_error(error) }
            })?;
        if result.rows_affected() != 1 {
            return Err(StorageError::new(
                StorageErrorCode::NotFound,
                "未找到该存储空间",
            ));
        }
        tx.commit().await.map_err(database_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn transfer_limits_default_to_unlimited_and_survive_reopening() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("limits.db");
        let repo = Repository::open(&path).await.unwrap();
        assert_eq!(
            repo.transfer_settings().await.unwrap(),
            TransferSettings::default()
        );
        let settings = TransferSettings {
            upload_kib_per_second: 1024,
            download_kib_per_second: 2048,
        };
        repo.save_transfer_settings(settings).await.unwrap();
        assert!(repo
            .save_transfer_settings(TransferSettings {
                upload_kib_per_second: u32::MAX,
                ..settings
            })
            .await
            .is_err());
        repo.pool.close().await;
        let repo = Repository::open(&path).await.unwrap();
        assert_eq!(repo.transfer_settings().await.unwrap(), settings);
        repo.save_transfer_settings(TransferSettings::default())
            .await
            .unwrap();
        assert_eq!(
            repo.transfer_settings().await.unwrap(),
            TransferSettings::default()
        );
    }
    #[tokio::test]
    async fn reopening_marks_unfinished_transfers_interrupted() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("filo.db");
        let repo = Repository::open(&db).await.unwrap();
        for state in [
            TransferState::Queued,
            TransferState::Running,
            TransferState::Verifying,
            TransferState::Completed,
        ] {
            repo.save_transfer(&TransferJob {
                id: Uuid::new_v4(),
                kind: TransferKind::Copy,
                source: StorageLocator {
                    volume_id: Uuid::new_v4(),
                    logical_path: "source".into(),
                    version_id: None,
                },
                destination: StorageLocator {
                    volume_id: Uuid::new_v4(),
                    logical_path: "destination".into(),
                    version_id: None,
                },
                state,
                bytes_total: Some(100),
                bytes_transferred: 50,
                error_code: None,
                error_message: None,
                created_at: "2026-09-16T00:00:00Z".into(),
                updated_at: "2026-09-16T00:00:00Z".into(),
            })
            .await
            .unwrap();
        }
        repo.pool.close().await;
        let reopened = Repository::open(&db).await.unwrap();
        let jobs = reopened.list_transfers().await.unwrap();
        assert_eq!(jobs.len(), 4);
        assert_eq!(
            jobs.iter()
                .filter(|job| job.state == TransferState::Interrupted)
                .count(),
            3
        );
        assert_eq!(
            jobs.iter()
                .filter(|job| job.state == TransferState::Completed)
                .count(),
            1
        );
        assert!(jobs
            .iter()
            .all(|job| job.bytes_transferred == 50 && job.source.logical_path == "source"));
    }
    #[tokio::test]
    async fn editing_local_storage_is_persistent_and_atomic() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("filo.db");
        let repo = Repository::open(&db).await.unwrap();
        let mut first = repo
            .add_local(&dir.path().join("first"), true)
            .await
            .unwrap();
        let second = repo
            .add_local(&dir.path().join("second"), true)
            .await
            .unwrap();
        first.name = "工作文件".into();
        first.read_only = false;
        first.root = VolumeRoot::Local {
            root_path: dir.path().join("changed"),
        };
        repo.update_local(&first).await.unwrap();
        repo.pool.close().await;
        let repo = Repository::open(&db).await.unwrap();
        let saved = repo
            .list_volumes()
            .await
            .unwrap()
            .into_iter()
            .find(|v| v.id == first.id)
            .unwrap();
        assert_eq!(saved.name, "工作文件");
        assert!(!saved.read_only);
        assert!(
            matches!(saved.root, VolumeRoot::Local { root_path } if root_path == dir.path().join("changed"))
        );
        first.name = "不能部分保存".into();
        first.read_only = true;
        first.root = second.root;
        assert_eq!(
            repo.update_local(&first).await.unwrap_err().code,
            StorageErrorCode::AlreadyExists
        );
        let saved = repo
            .list_volumes()
            .await
            .unwrap()
            .into_iter()
            .find(|v| v.id == first.id)
            .unwrap();
        assert_eq!(saved.name, "工作文件");
        assert!(!saved.read_only);
        let connection = repo
            .list_connections()
            .await
            .unwrap()
            .into_iter()
            .find(|c| c.id == first.connection_id)
            .unwrap();
        assert_eq!(connection.name, "工作文件");
    }
    #[tokio::test]
    async fn retains_connections_and_volumes_on_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("filo.db");
        let repo = Repository::open(&db).await.unwrap();
        let first = repo.add_local(dir.path(), true).await.unwrap();
        assert_eq!(
            repo.add_local(dir.path(), false).await.unwrap().id,
            first.id
        );
        repo.pool.close().await;
        let reopened = Repository::open(&db).await.unwrap();
        let volumes = reopened.list_volumes().await.unwrap();
        assert_eq!(volumes.len(), 1);
        assert_eq!(volumes[0].id, first.id);
        assert!(volumes[0].read_only);
        assert_eq!(reopened.list_connections().await.unwrap().len(), 1);
    }
}
