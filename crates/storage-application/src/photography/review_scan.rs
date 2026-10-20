use super::*;
use std::{future::Future, time::Duration};

pub(super) struct ReviewScan {
    token: CancellationToken,
    observer: Arc<dyn Fn(PhotoReviewProgress) + Send + Sync>,
}

impl ReviewScan {
    pub fn check(&self) -> StorageResult<()> {
        if self.token.is_cancelled() {
            return Err(StorageError::new(
                StorageErrorCode::Cancelled,
                "已取消打开审图",
            ));
        }
        Ok(())
    }

    // Only wrap reads. Once publishing starts, finish the durable checkpoint.
    pub async fn read<T>(
        &self,
        future: impl Future<Output = StorageResult<T>>,
    ) -> StorageResult<T> {
        tokio::select! {
            biased;
            _ = self.token.cancelled() => Err(StorageError::new(StorageErrorCode::Cancelled, "已取消打开审图")),
            result = tokio::time::timeout(Duration::from_secs(30), future) => {
                result.map_err(|_| StorageError::new(StorageErrorCode::Io, "读取照片目录超时，请检查存储连接后重试"))?
            }
        }
    }

    pub fn progress(
        &self,
        stage: PhotoReviewStage,
        found: usize,
        completed: usize,
        total: Option<usize>,
        path: &str,
    ) {
        (self.observer)(PhotoReviewProgress {
            stage,
            found,
            completed,
            total,
            path: path.into(),
        });
    }
}

impl StorageService {
    pub async fn photo_cancel_review_scan(&self, request_id: Uuid) -> StorageResult<()> {
        if let Some(token) = self.photo_review_scans.lock().await.get(&request_id) {
            token.cancel();
        }
        Ok(())
    }

    pub async fn photo_scan_review(
        &self,
        request_id: Uuid,
        mut input: PhotoReviewInput,
        observer: Arc<dyn Fn(PhotoReviewProgress) + Send + Sync>,
    ) -> StorageResult<PhotoSession> {
        if input.directory {
            if input.jpg.version_id.is_some() {
                return Err(invalid("请从当前目录进入审图，不支持历史版本"));
            }
            input.jpg.logical_path = normalize_path(&input.jpg.logical_path)?;
            input.raw = None;
        }
        let token = CancellationToken::new();
        {
            let mut scans = self.photo_review_scans.lock().await;
            if scans.contains_key(&request_id) {
                return Err(conflict("此审图目录正在打开"));
            }
            scans.insert(request_id, token.clone());
        }
        let scan = ReviewScan { token, observer };
        scan.progress(
            PhotoReviewStage::Connecting,
            0,
            0,
            None,
            &input.jpg.logical_path,
        );
        let result = self
            .open_review(input.name, input.jpg, input.raw, input.directory, &scan)
            .await;
        self.photo_review_scans.lock().await.remove(&request_id);
        result
    }
}

#[cfg(test)]
#[path = "review_scan_tests.rs"]
mod tests;
