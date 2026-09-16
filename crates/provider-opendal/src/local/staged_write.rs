use super::{io_error, OpenDalLocalBackend};
use storage_domain::*;
use storage_provider_api::{StagedWrite, StorageBackend, StorageReader};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use uuid::Uuid;

struct LocalStagedWrite {
    temporary: tempfile::NamedTempFile,
    writer: tokio::fs::File,
    volume: StorageVolume,
    target: StorageLocator,
    expected: Option<StorageEntry>,
}

#[async_trait::async_trait]
impl StagedWrite for LocalStagedWrite {
    async fn write(&mut self, bytes: &[u8]) -> StorageResult<()> {
        self.writer.write_all(bytes).await.map_err(io_error)
    }

    async fn reader(&mut self) -> StorageResult<StorageReader> {
        self.writer.flush().await.map_err(io_error)?;
        self.writer.sync_all().await.map_err(io_error)?;
        let mut reader = self.writer.try_clone().await.map_err(io_error)?;
        reader
            .seek(std::io::SeekFrom::Start(0))
            .await
            .map_err(io_error)?;
        Ok(Box::pin(reader))
    }

    async fn commit(self: Box<Self>) -> StorageResult<()> {
        let backend = OpenDalLocalBackend::new(&self.volume).await?;
        let logical = backend.check_locator(&self.target)?;
        if let Some(expected) = &self.expected {
            let current = backend.stat(&self.target).await?;
            if current.kind != StorageEntryKind::File
                || current.size != expected.size
                || current.modified_at != expected.modified_at
            {
                return Err(StorageError::new(
                    StorageErrorCode::Conflict,
                    "目标文件已变化，未覆盖，请重新确认",
                ));
            }
        } else {
            backend.require_absent(&logical).await?;
        }
        let target = backend.checked_path(&logical, true).await?;
        let replace = self.expected.is_some();
        let Self {
            temporary, writer, ..
        } = *self;
        drop(writer);
        tokio::task::spawn_blocking(move || {
            (if replace {
                temporary.persist(target)
            } else {
                temporary.persist_noclobber(target)
            })
            .map(|_| ())
            .map_err(|error| io_error(error.error))
        })
        .await
        .map_err(|_| StorageError::new(StorageErrorCode::Internal, "保存文件任务意外中断"))?
    }
}

impl OpenDalLocalBackend {
    pub(super) async fn prepare_write(
        &self,
        locator: &StorageLocator,
    ) -> StorageResult<Box<dyn StagedWrite>> {
        self.prepare_write_mode(locator, None).await
    }

    pub(super) async fn prepare_write_mode(
        &self,
        locator: &StorageLocator,
        expected: Option<StorageEntry>,
    ) -> StorageResult<Box<dyn StagedWrite>> {
        let logical = self.check_locator(locator)?;
        self.writable(&logical)?;
        if let Some(entry) = &expected {
            if entry.kind != StorageEntryKind::File {
                return Err(StorageError::new(
                    StorageErrorCode::Conflict,
                    "仅能用文件覆盖同名文件",
                ));
            }
        } else {
            self.require_absent(&logical).await?;
        }
        let path = self.checked_path(&logical, true).await?;
        let parent = path
            .parent()
            .ok_or_else(|| StorageError::new(StorageErrorCode::InvalidPath, "无效的目标目录"))?
            .to_path_buf();
        let temporary = tokio::task::spawn_blocking(move || {
            tempfile::Builder::new()
                .prefix(".filo-transfer-")
                .tempfile_in(parent)
        })
        .await
        .map_err(|_| StorageError::new(StorageErrorCode::Internal, "无法创建传输任务"))?
        .map_err(io_error)?;
        let writer = tokio::fs::File::from_std(temporary.reopen().map_err(io_error)?);
        Ok(Box::new(LocalStagedWrite {
            temporary,
            writer,
            expected,
            target: locator.clone(),
            volume: StorageVolume {
                id: self.volume_id,
                connection_id: Uuid::nil(),
                name: String::new(),
                root: VolumeRoot::Local {
                    root_path: self.root.clone(),
                },
                read_only: self.read_only,
            },
        }))
    }
}
