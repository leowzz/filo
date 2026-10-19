use super::*;

impl Repository {
    pub async fn photo_catalog(&self) -> StorageResult<(i64, serde_json::Value)> {
        let row = sqlx::query("SELECT revision, document FROM photo_catalog WHERE id = 1")
            .fetch_one(&self.pool)
            .await
            .map_err(database_error)?;
        Ok((
            row.get("revision"),
            serde_json::from_str(row.get("document")).map_err(database_error)?,
        ))
    }

    pub async fn save_photo_catalog(
        &self,
        revision: i64,
        document: serde_json::Value,
    ) -> StorageResult<()> {
        let changed = sqlx::query("UPDATE photo_catalog SET revision = revision + 1, document = ? WHERE id = 1 AND revision = ?")
            .bind(document.to_string()).bind(revision).execute(&self.pool).await.map_err(database_error)?;
        if changed.rows_affected() != 1 {
            return Err(StorageError::new(
                StorageErrorCode::Conflict,
                "摄影记录已被其他操作更新，请重试",
            ));
        }
        Ok(())
    }
}
