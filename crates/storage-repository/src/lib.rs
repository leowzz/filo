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
}

#[cfg(test)]
mod tests {
    use super::*;
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
