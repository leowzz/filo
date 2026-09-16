use crate::*;
impl StorageService {
    pub async fn manage_s3(
        &self,
        locator: StorageLocator,
        action: S3Action,
    ) -> StorageResult<serde_json::Value> {
        if locator.version_id.is_some() {
            return Err(StorageError::new(
                StorageErrorCode::InvalidPath,
                "请使用版本操作选择版本",
            ));
        }
        let _read = if !action.writes() {
            Some(self.mutation_lock.read().await)
        } else {
            None
        };
        let _write = if action.writes() {
            Some(self.mutation_lock.write().await)
        } else {
            None
        };
        let _idle = if action.writes() {
            Some(self.idle_volume(locator.volume_id).await?)
        } else {
            None
        };
        let volume = self
            .repository
            .list_volumes()
            .await?
            .into_iter()
            .find(|v| v.id == locator.volume_id)
            .ok_or_else(|| StorageError::new(StorageErrorCode::NotFound, "连接已移除"))?;
        let connection = self.connection(volume.connection_id).await?;
        let config = serde_json::from_value(connection.config).map_err(|_| {
            StorageError::new(StorageErrorCode::InvalidConfiguration, "S3 配置无效")
        })?;
        let credentials = self.load_credentials(connection.credential_ref).await?;
        provider_opendal::S3Admin::new(&volume, &config, &credentials)?
            .run(&locator.logical_path, action)
            .await
    }
}
