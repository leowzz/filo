use futures::FutureExt;
use std::{future::Future, panic::AssertUnwindSafe};
use storage_domain::{StorageError, StorageErrorCode, StorageResult};

/// Catch unwinding at an operation boundary so callers can finish their error/cleanup path.
/// The desktop panic hook reports diagnostics; never expose the panic payload to the UI.
pub async fn catch_panic<T>(operation: impl Future<Output = StorageResult<T>>) -> StorageResult<T> {
    AssertUnwindSafe(operation)
        .catch_unwind()
        .await
        .unwrap_or_else(|_| {
            Err(StorageError::new(
                StorageErrorCode::Internal,
                "操作发生内部异常，无法确认是否完成。请检查结果后重试",
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn panic_after_yield_returns_error_and_releases_locks() {
        let lock = tokio::sync::Mutex::new(());
        let result: StorageResult<()> = catch_panic(async {
            let _guard = lock.lock().await;
            tokio::task::yield_now().await;
            panic!("sensitive panic payload");
        })
        .await;
        let error = result.unwrap_err();
        assert_eq!(error.code, StorageErrorCode::Internal);
        assert!(!error.message.contains("sensitive"));
        assert!(!error.retryable);
        assert!(lock.try_lock().is_ok());
        assert_eq!(catch_panic(async { Ok(42) }).await.unwrap(), 42);
        let error = catch_panic::<()>(async {
            Err(StorageError::new(StorageErrorCode::AccessDenied, "denied"))
        })
        .await
        .unwrap_err();
        assert_eq!(error.code, StorageErrorCode::AccessDenied);
        assert_eq!(error.message, "denied");
    }
}
