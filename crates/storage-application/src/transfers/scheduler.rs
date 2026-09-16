use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use storage_domain::StorageLocator;
use storage_provider_api::StorageBackend;
use tokio::sync::Notify;
use uuid::Uuid;

pub(crate) const MAX_PARALLEL_TRANSFERS: usize = 3;

pub(super) struct Access {
    namespace: String,
    path: String,
    write: bool,
}

impl Access {
    pub(super) fn new(backend: &dyn StorageBackend, locator: &StorageLocator, write: bool) -> Self {
        let (namespace, path) = backend
            .storage_path(locator)
            .unwrap_or_else(|| (locator.volume_id.to_string(), locator.logical_path.clone()));
        Self {
            namespace,
            path: path.trim_end_matches('/').into(),
            write,
        }
    }

    fn conflicts(&self, other: &Self) -> bool {
        self.namespace == other.namespace
            && (self.write || other.write)
            && (self.path.is_empty()
                || other.path.is_empty()
                || self.path == other.path
                || self.path.starts_with(&format!("{}/", other.path))
                || other.path.starts_with(&format!("{}/", self.path)))
    }
}

/// Reserve both ends together, so overlapping trees cannot race or deadlock.
/// Waiting for a conflicting path does not occupy a concurrency slot.
#[derive(Default)]
pub(crate) struct TransferScheduler {
    active: Mutex<HashMap<Uuid, Vec<Access>>>,
    changed: Notify,
}

impl TransferScheduler {
    pub(super) async fn acquire(self: &Arc<Self>, accesses: Vec<Access>) -> TransferPermit {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            {
                let mut active = self.active.lock().unwrap();
                if active.len() < MAX_PARALLEL_TRANSFERS
                    && !active
                        .values()
                        .flatten()
                        .any(|held| accesses.iter().any(|next| next.conflicts(held)))
                {
                    let id = Uuid::new_v4();
                    active.insert(id, accesses);
                    return TransferPermit {
                        scheduler: self.clone(),
                        id,
                    };
                }
            }
            changed.await;
        }
    }
}

pub(super) struct TransferPermit {
    scheduler: Arc<TransferScheduler>,
    id: Uuid,
}

impl Drop for TransferPermit {
    fn drop(&mut self) {
        self.scheduler.active.lock().unwrap().remove(&self.id);
        self.scheduler.changed.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn access(path: &str, write: bool) -> Vec<Access> {
        vec![Access {
            namespace: "local".into(),
            path: path.into(),
            write,
        }]
    }

    #[tokio::test]
    async fn caps_concurrency_and_releases_slots() {
        let scheduler = Arc::new(TransferScheduler::default());
        let mut permits = Vec::new();
        for i in 0..MAX_PARALLEL_TRANSFERS {
            permits.push(scheduler.acquire(access(&format!("/file-{i}"), true)).await);
        }
        let waiting = scheduler.clone();
        let mut next = tokio::spawn(async move { waiting.acquire(access("/next", true)).await });
        assert!(tokio::time::timeout(Duration::from_millis(30), &mut next)
            .await
            .is_err());
        permits.pop();
        let _next = tokio::time::timeout(Duration::from_secs(1), next)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn protects_overlapping_trees_and_allows_shared_reads() {
        let scheduler = Arc::new(TransferScheduler::default());
        let first = scheduler.acquire(access("/folder", false)).await;
        let second = scheduler.acquire(access("/folder/child", false)).await;
        assert!(tokio::time::timeout(
            Duration::from_millis(30),
            scheduler.acquire(access("/folder/child", true))
        )
        .await
        .is_err());
        // A blocked conflicting task leaves room for unrelated work.
        let _unrelated = scheduler.acquire(access("/folder-other", true)).await;
        drop(first);
        drop(second);
        let _writer = tokio::time::timeout(
            Duration::from_secs(1),
            scheduler.acquire(access("/folder", true)),
        )
        .await
        .unwrap();
    }
}
