use crate::StorageReader;
use std::{
    future::Future,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use storage_domain::TransferSettings;
use tokio::{
    io::{AsyncRead, ReadBuf},
    sync::{watch, Mutex},
    time::Instant,
};

/// One shared budget per direction. A small bucket bounds bursts; waiters use
/// the same FIFO mutex so parallel jobs cannot each consume the full limit.
pub struct RateLimit {
    rate: watch::Sender<u64>,
    budget: Mutex<Budget>,
}

struct Budget {
    rate: u64,
    tokens: f64,
    updated: Instant,
}

impl Default for RateLimit {
    fn default() -> Self {
        Self {
            rate: watch::channel(0).0,
            budget: Mutex::new(Budget {
                rate: 0,
                tokens: 0.0,
                updated: Instant::now(),
            }),
        }
    }
}

impl RateLimit {
    pub fn chunk_size(&self, maximum: usize) -> usize {
        let rate = *self.rate.borrow();
        if rate == 0 {
            maximum
        } else {
            maximum.min((rate / 10).clamp(1, 64 * 1024) as usize)
        }
    }
    pub fn set_bytes_per_second(&self, rate: u64) {
        self.rate.send_if_modified(|current| {
            if *current == rate {
                return false;
            }
            *current = rate;
            true
        });
    }

    /// Reserve at most `maximum` bytes, cancellable by dropping this future.
    /// No future bandwidth is reserved, so cancellation leaves no debt behind.
    pub async fn acquire(&self, maximum: usize) -> usize {
        if maximum == 0 {
            return 0;
        }
        let mut changes = self.rate.subscribe();
        let mut budget = self.budget.lock().await;
        loop {
            let rate = *changes.borrow_and_update();
            let now = Instant::now();
            if rate != budget.rate {
                budget.rate = rate;
                budget.tokens = 0.0;
                budget.updated = now;
            }
            if rate == 0 {
                return maximum;
            }
            let capacity = (rate / 10).clamp(1, 64 * 1024) as usize;
            let amount = maximum.min(capacity);
            budget.tokens = (budget.tokens
                + now.duration_since(budget.updated).as_secs_f64() * rate as f64)
                .min(capacity as f64);
            budget.updated = now;
            if budget.tokens >= amount as f64 {
                budget.tokens -= amount as f64;
                return amount;
            }
            let delay = Duration::from_secs_f64((amount as f64 - budget.tokens) / rate as f64);
            tokio::select! {
                _ = tokio::time::sleep(delay) => {},
                _ = changes.changed() => {},
            }
        }
    }

    pub fn reader(self: &Arc<Self>, inner: StorageReader) -> StorageReader {
        Box::pin(LimitedReader {
            inner,
            limit: self.clone(),
            pending: None,
            allowance: 0,
        })
    }
}

#[derive(Default)]
pub struct TransferLimits {
    pub upload: Arc<RateLimit>,
    pub download: Arc<RateLimit>,
}

impl TransferLimits {
    /// Keep progress reports responsive even at very low configured speeds.
    pub fn chunk_size(&self, maximum: usize, upload: bool, download: bool) -> usize {
        let size = if upload {
            self.upload.chunk_size(maximum)
        } else {
            maximum
        };
        if download {
            self.download.chunk_size(size)
        } else {
            size
        }
    }
    pub fn update(&self, settings: TransferSettings) {
        self.upload
            .set_bytes_per_second(u64::from(settings.upload_kib_per_second) * 1024);
        self.download
            .set_bytes_per_second(u64::from(settings.download_kib_per_second) * 1024);
    }
}

struct LimitedReader {
    inner: StorageReader,
    limit: Arc<RateLimit>,
    pending: Option<Pin<Box<dyn Future<Output = usize> + Send>>>,
    allowance: usize,
}

impl AsyncRead for LimitedReader {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        output: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        if output.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        if this.allowance == 0 {
            let limit = this.limit.clone();
            let maximum = output.remaining();
            let pending = this
                .pending
                .get_or_insert_with(|| Box::pin(async move { limit.acquire(maximum).await }));
            this.allowance = std::task::ready!(pending.as_mut().poll(cx));
            this.pending = None;
        }
        let amount = this.allowance.min(output.remaining());
        let mut buffer = ReadBuf::new(&mut output.initialize_unfilled()[..amount]);
        match this.inner.as_mut().poll_read(cx, &mut buffer) {
            Poll::Ready(Ok(())) => {
                let read = buffer.filled().len();
                this.allowance -= read;
                output.advance(read);
                Poll::Ready(Ok(()))
            }
            other => other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[tokio::test(start_paused = true)]
    async fn unlimited_is_immediate_and_concurrent_calls_share_one_budget() {
        let limit = RateLimit::default();
        let start = Instant::now();
        assert_eq!(limit.acquire(1_000_000).await, 1_000_000);
        assert_eq!(start.elapsed(), Duration::ZERO);
        limit.set_bytes_per_second(1000);
        let (first, second, third) =
            tokio::join!(limit.acquire(100), limit.acquire(100), limit.acquire(100));
        assert_eq!((first, second, third), (100, 100, 100));
        assert!(start.elapsed() >= Duration::from_millis(300));
        assert!(start.elapsed() < Duration::from_millis(310));
    }

    #[tokio::test(start_paused = true)]
    async fn directions_are_independent_and_changes_wake_existing_waiters() {
        let limits = TransferLimits::default();
        limits.upload.set_bytes_per_second(1000);
        limits.download.set_bytes_per_second(1000);
        assert_eq!(limits.chunk_size(256 * 1024, true, false), 100);
        assert_eq!(limits.chunk_size(256 * 1024, false, false), 256 * 1024);
        let start = Instant::now();
        tokio::join!(limits.upload.acquire(100), limits.download.acquire(100));
        assert!(start.elapsed() < Duration::from_millis(110));
        limits.upload.set_bytes_per_second(1);
        let upload = limits.upload.clone();
        let pending = tokio::spawn(async move { upload.acquire(1000).await });
        tokio::task::yield_now().await;
        let changed = Instant::now();
        limits.upload.set_bytes_per_second(0);
        assert_eq!(pending.await.unwrap(), 1000);
        assert_eq!(changed.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn dropping_waiters_does_not_reserve_future_bandwidth() {
        let limit = Arc::new(RateLimit::default());
        limit.set_bytes_per_second(10);
        let pending_limit = limit.clone();
        let pending = tokio::spawn(async move { pending_limit.acquire(1000).await });
        tokio::task::yield_now().await;
        pending.abort();
        assert!(pending.await.unwrap_err().is_cancelled());
        let start = Instant::now();
        assert_eq!(limit.acquire(1).await, 1);
        assert!(start.elapsed() < Duration::from_millis(110));
    }

    #[tokio::test(start_paused = true)]
    async fn limited_reader_preserves_content_and_obeys_download_budget() {
        let limit = Arc::new(RateLimit::default());
        limit.set_bytes_per_second(1000);
        let data = vec![42; 600];
        let mut reader = limit.reader(Box::pin(std::io::Cursor::new(data.clone())));
        let mut result = Vec::new();
        let start = Instant::now();
        reader.read_to_end(&mut result).await.unwrap();
        assert_eq!(result, data);
        assert!(start.elapsed() >= Duration::from_millis(600));
        assert!(start.elapsed() < Duration::from_secs(1));
    }
}
