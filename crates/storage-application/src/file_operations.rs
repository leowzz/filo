use storage_domain::*;
use storage_provider_api::StorageBackend;

pub async fn delete(
    backend: &dyn StorageBackend,
    locator: &StorageLocator,
    mode: DeleteMode,
) -> StorageResult<DeleteOutcome> {
    let capabilities = backend.capabilities();
    if !capabilities.delete {
        return Err(StorageError::new(
            StorageErrorCode::AccessDenied,
            "该存储空间不允许删除",
        ));
    }
    if mode == DeleteMode::Default && capabilities.trash {
        // A failed trash operation must never silently become permanent deletion.
        backend.trash(locator).await?;
        Ok(DeleteOutcome::Trashed)
    } else {
        backend.delete(locator).await?;
        Ok(DeleteOutcome::PermanentlyDeleted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use storage_provider_api::{StagedWrite, StorageReader};
    use uuid::Uuid;

    struct Backend {
        supports_trash: bool,
        writable: bool,
        trash_fails: bool,
        calls: Mutex<Vec<&'static str>>,
    }
    #[async_trait::async_trait]
    impl StorageBackend for Backend {
        fn volume_id(&self) -> Uuid {
            Uuid::nil()
        }
        fn capabilities(&self) -> StorageCapabilities {
            let mut caps = StorageCapabilities::local(!self.writable);
            caps.trash = self.supports_trash;
            caps
        }
        async fn delete(&self, _: &StorageLocator) -> StorageResult<()> {
            self.calls.lock().unwrap().push("delete");
            Ok(())
        }
        async fn trash(&self, _: &StorageLocator) -> StorageResult<()> {
            self.calls.lock().unwrap().push("trash");
            if self.trash_fails {
                Err(StorageError::new(
                    StorageErrorCode::TrashUnavailable,
                    "trash failed",
                ))
            } else {
                Ok(())
            }
        }
        async fn list(&self, _: &StorageLocator) -> StorageResult<Vec<StorageEntry>> {
            unreachable!()
        }
        async fn stat(&self, _: &StorageLocator) -> StorageResult<StorageEntry> {
            unreachable!()
        }
        async fn create_dir(&self, _: &StorageLocator) -> StorageResult<()> {
            unreachable!()
        }
        async fn rename(&self, _: &StorageLocator, _: &StorageLocator) -> StorageResult<()> {
            unreachable!()
        }
        async fn open_read(&self, _: &StorageLocator) -> StorageResult<StorageReader> {
            unreachable!()
        }
        async fn stage_write(&self, _: &StorageLocator) -> StorageResult<Box<dyn StagedWrite>> {
            unreachable!()
        }
    }
    #[tokio::test]
    async fn deletion_policy_prefers_trash_and_never_falls_back_on_failure() {
        let locator = StorageLocator {
            volume_id: Uuid::nil(),
            logical_path: "file".into(),
            version_id: None,
        };
        for (mode, supports_trash, writable, trash_fails, expected, calls) in [
            (
                DeleteMode::Default,
                true,
                true,
                false,
                Ok(DeleteOutcome::Trashed),
                vec!["trash"],
            ),
            (
                DeleteMode::Permanent,
                true,
                true,
                false,
                Ok(DeleteOutcome::PermanentlyDeleted),
                vec!["delete"],
            ),
            (
                DeleteMode::Default,
                false,
                true,
                false,
                Ok(DeleteOutcome::PermanentlyDeleted),
                vec!["delete"],
            ),
            (
                DeleteMode::Default,
                true,
                true,
                true,
                Err(StorageErrorCode::TrashUnavailable),
                vec!["trash"],
            ),
            (
                DeleteMode::Default,
                true,
                false,
                false,
                Err(StorageErrorCode::AccessDenied),
                vec![],
            ),
            (
                DeleteMode::Permanent,
                true,
                false,
                false,
                Err(StorageErrorCode::AccessDenied),
                vec![],
            ),
        ] {
            let backend = Backend {
                supports_trash,
                writable,
                trash_fails,
                calls: Mutex::new(vec![]),
            };
            assert_eq!(
                delete(&backend, &locator, mode)
                    .await
                    .map_err(|error| error.code),
                expected
            );
            assert_eq!(*backend.calls.lock().unwrap(), calls);
        }
    }

    #[tokio::test]
    async fn unavailable_trash_requires_a_separate_permanent_request() {
        let backend = Backend {
            supports_trash: true,
            writable: true,
            trash_fails: true,
            calls: Mutex::new(vec![]),
        };
        let locator = StorageLocator {
            volume_id: Uuid::nil(),
            logical_path: "file".into(),
            version_id: None,
        };
        assert_eq!(
            delete(&backend, &locator, DeleteMode::Default)
                .await
                .unwrap_err()
                .code,
            StorageErrorCode::TrashUnavailable
        );
        assert_eq!(*backend.calls.lock().unwrap(), vec!["trash"]);
        assert_eq!(
            delete(&backend, &locator, DeleteMode::Permanent)
                .await
                .unwrap(),
            DeleteOutcome::PermanentlyDeleted
        );
        assert_eq!(*backend.calls.lock().unwrap(), vec!["trash", "delete"]);
    }
}
