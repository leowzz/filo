use storage_domain::*;

#[derive(Debug, PartialEq, Eq)]
pub enum OperationPlan {
    /// Same-volume move uses the provider's advertised rename semantics:
    /// local atomic rename, or S3 copy/verify/delete.
    ProviderRename,
    StreamCopy {
        delete_source: bool,
    },
}

pub fn plan(
    kind: TransferKind,
    source: &StorageLocator,
    destination: &StorageLocator,
) -> StorageResult<OperationPlan> {
    if source.volume_id == destination.volume_id && source.logical_path == destination.logical_path
    {
        return Err(StorageError::new(
            StorageErrorCode::Conflict,
            "源文件和目标文件不能相同",
        ));
    }
    Ok(
        if kind == TransferKind::Move && source.volume_id == destination.volume_id {
            OperationPlan::ProviderRename
        } else {
            OperationPlan::StreamCopy {
                delete_source: kind == TransferKind::Move,
            }
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_strategies() {
        let source = StorageLocator {
            volume_id: uuid::Uuid::new_v4(),
            logical_path: "a".into(),
            version_id: None,
        };
        let mut target = StorageLocator {
            logical_path: "b".into(),
            ..source.clone()
        };
        assert_eq!(
            plan(TransferKind::Move, &source, &target).unwrap(),
            OperationPlan::ProviderRename
        );
        assert_eq!(
            plan(TransferKind::Copy, &source, &target).unwrap(),
            OperationPlan::StreamCopy {
                delete_source: false
            }
        );
        target.volume_id = uuid::Uuid::new_v4();
        assert_eq!(
            plan(TransferKind::Move, &source, &target).unwrap(),
            OperationPlan::StreamCopy {
                delete_source: true
            }
        );
        assert!(plan(TransferKind::Copy, &source, &source).is_err());
    }
}
