use super::{error, invalid, OpenDalS3Backend};
use opendal::{Operator, Writer};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use storage_domain::*;
use storage_provider_api::{StagedWrite, StorageReader, TransferLimits};
use tokio::io::AsyncReadExt;
use tokio_util::compat::FuturesAsyncReadCompatExt;
use uuid::Uuid;

pub(super) async fn reader(
    operator: &Operator,
    path: &str,
    limits: &TransferLimits,
) -> StorageResult<StorageReader> {
    let meta = operator.stat(path).await.map_err(error)?;
    let mut read = operator.reader_with(path);
    if let Some(etag) = meta.etag() {
        read = read.if_match(etag);
    }
    Ok(limits.download.reader(Box::pin(
        read.await
            .map_err(error)?
            .into_futures_async_read(..)
            .await
            .map_err(error)?
            .compat(),
    )))
}
pub(super) async fn digest(mut source: StorageReader) -> StorageResult<(u64, Vec<u8>)> {
    let mut hash = Sha256::new();
    let mut size = 0;
    let mut buffer = vec![0; 256 * 1024];
    loop {
        let n = source
            .read(&mut buffer)
            .await
            .map_err(|_| StorageError::new(StorageErrorCode::Network, "S3 内容校验读取失败"))?;
        if n == 0 {
            return Ok((size, hash.finalize().to_vec()));
        }
        size += n as u64;
        hash.update(&buffer[..n]);
    }
}

impl OpenDalS3Backend {
    pub(super) async fn prepare_write(
        &self,
        locator: &StorageLocator,
    ) -> StorageResult<Box<dyn StagedWrite>> {
        let target = self.path(locator, true)?;
        self.absent(&target).await?;
        let parent = target
            .rsplit_once('/')
            .map(|(p, _)| format!("{p}/"))
            .unwrap_or_default();
        let temporary = format!("{parent}.filo-transfer-{}", Uuid::new_v4());
        let writer = self
            .operator
            .writer_with(&temporary)
            .chunk(8 * 1024 * 1024)
            .if_not_exists(true)
            .await
            .map_err(error)?;
        Ok(Box::new(S3StagedWrite {
            operator: self.operator.clone(),
            temporary,
            target,
            writer: Some(writer),
            size: 0,
            limits: self.limits.clone(),
        }))
    }
}

/// CopyObject is limited to 5 GiB. Larger files are streamed with conditional multipart completion.
pub(super) async fn publish(
    operator: &Operator,
    from: &str,
    to: &str,
    size: u64,
    limits: &TransferLimits,
) -> StorageResult<()> {
    if size <= 5 * 1024 * 1024 * 1024 {
        operator
            .copy_with(from, to)
            .if_not_exists(true)
            .await
            .map(|_| ())
            .map_err(error)
    } else {
        let mut source = reader(operator, from, limits).await?;
        let mut target = operator
            .writer_with(to)
            .chunk(16 * 1024 * 1024)
            .if_not_exists(true)
            .await
            .map_err(error)?;
        let result = async {
            let mut buffer = vec![0; 256 * 1024];
            loop {
                let n = source.read(&mut buffer).await.map_err(|_| {
                    StorageError::new(
                        StorageErrorCode::Network,
                        "发布目标时读取失败，源对象已保留",
                    )
                })?;
                if n == 0 {
                    break;
                }
                let mut offset = 0;
                while offset < n {
                    let count = limits.upload.acquire(n - offset).await;
                    target
                        .write(buffer[offset..offset + count].to_vec())
                        .await
                        .map_err(error)?;
                    offset += count;
                }
            }
            target.close().await.map_err(error)?;
            Ok(())
        }
        .await;
        if result.is_err() {
            let _ = target.abort().await;
        }
        result
    }
}

struct S3StagedWrite {
    operator: Operator,
    temporary: String,
    target: String,
    writer: Option<Writer>,
    size: u64,
    limits: Arc<TransferLimits>,
}
#[async_trait::async_trait]
impl StagedWrite for S3StagedWrite {
    async fn write(&mut self, bytes: &[u8]) -> StorageResult<()> {
        let writer = self
            .writer
            .as_mut()
            .ok_or_else(|| invalid("写入已经结束"))?;
        let mut offset = 0;
        while offset < bytes.len() {
            let count = self.limits.upload.acquire(bytes.len() - offset).await;
            writer
                .write(bytes[offset..offset + count].to_vec())
                .await
                .map_err(error)?;
            offset += count;
        }
        self.size += bytes.len() as u64;
        Ok(())
    }
    async fn reader(&mut self) -> StorageResult<StorageReader> {
        if let Some(writer) = self.writer.as_mut() {
            writer.close().await.map_err(error)?;
        }
        self.writer = None;
        reader(&self.operator, &self.temporary, &self.limits).await
    }
    async fn commit(mut self: Box<Self>) -> StorageResult<()> {
        let expected = digest(self.reader().await?).await?;
        publish(
            &self.operator,
            &self.temporary,
            &self.target,
            self.size,
            &self.limits,
        )
        .await?;
        let verified = digest(reader(&self.operator, &self.target, &self.limits).await?).await?;
        if expected != verified {
            return Err(StorageError::new(
                StorageErrorCode::Io,
                "目标已发布但内容校验失败，源文件已保留",
            ));
        }
        Ok(()) // Drop removes only this uniquely named temporary object.
    }
}
impl Drop for S3StagedWrite {
    fn drop(&mut self) {
        let operator = self.operator.clone();
        let temporary = self.temporary.clone();
        let writer = self.writer.take();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                if let Some(mut writer) = writer {
                    let _ = writer.abort().await;
                }
                let _ = operator.delete(&temporary).await;
            });
        }
    }
}
