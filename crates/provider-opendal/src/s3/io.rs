use super::checksum::{UploadChecksum, PART_SIZE};
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
        self.prepare_write_mode(locator, None).await
    }
    pub(super) async fn prepare_write_mode(
        &self,
        locator: &StorageLocator,
        expected: Option<&StorageEntry>,
    ) -> StorageResult<Box<dyn StagedWrite>> {
        let target = self.path(locator, true)?;
        let replace_etag = if let Some(entry) = expected {
            if entry.kind != StorageEntryKind::File {
                return Err(StorageError::new(
                    StorageErrorCode::Conflict,
                    "仅能用文件覆盖同名文件",
                ));
            }
            Some(
                entry
                    .etag
                    .clone()
                    .ok_or_else(|| invalid("目标缺少 ETag，无法安全覆盖"))?,
            )
        } else {
            self.absent(&target).await?;
            None
        };
        let parent = target
            .rsplit_once('/')
            .map(|(p, _)| format!("{p}/"))
            .unwrap_or_default();
        let temporary = format!("{parent}.filo-transfer-{}", Uuid::new_v4());
        let writer = self
            .operator
            .writer_with(&temporary)
            .chunk(PART_SIZE)
            .if_not_exists(true)
            .await
            .map_err(error)?;
        Ok(Box::new(S3StagedWrite {
            operator: self.operator.clone(),
            temporary,
            target,
            writer: Some(writer),
            size: 0,
            hash: UploadChecksum::default(),
            replace_etag,
            limits: self.limits.clone(),
        }))
    }
}

/// CopyObject for small objects, server-side UploadPartCopy for large ones.
pub(super) async fn publish(
    operator: &Operator,
    from: &str,
    to: &str,
    size: u64,
    _limits: &TransferLimits,
) -> StorageResult<()> {
    publish_conditionally(operator, from, to, size, None).await
}

async fn publish_conditionally(
    operator: &Operator,
    from: &str,
    to: &str,
    size: u64,
    expected: Option<&str>,
) -> StorageResult<()> {
    let mut copy = operator.copy_with(from, to);
    copy = if let Some(etag) = expected {
        copy.if_match(etag)
    } else {
        copy.if_not_exists(true)
    };
    if size > 5 * 1024 * 1024 * 1024 {
        copy = copy.chunk(PART_SIZE);
    }
    copy.await.map(|_| ()).map_err(error)
}

struct S3StagedWrite {
    operator: Operator,
    temporary: String,
    target: String,
    writer: Option<Writer>,
    size: u64,
    hash: UploadChecksum,
    limits: Arc<TransferLimits>,
    replace_etag: Option<String>,
}
#[async_trait::async_trait]
impl StagedWrite for S3StagedWrite {
    fn verifies_on_commit(&self) -> bool {
        true
    }
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
        self.hash.update(bytes);
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
        if let Some(writer) = self.writer.as_mut() {
            writer.close().await.map_err(error)?;
        }
        self.writer = None;
        // Verify provider-generated ETags via HEAD before publication, including
        // replacements. Never trust user metadata or reread object content.
        self.hash
            .verify(&self.operator.stat(&self.temporary).await.map_err(error)?)?;
        publish_conditionally(
            &self.operator,
            &self.temporary,
            &self.target,
            self.size,
            self.replace_etag.as_deref(),
        )
        .await?;
        self.hash
            .verify(&self.operator.stat(&self.target).await.map_err(error)?)?;
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
