use std::collections::HashSet;
use storage_domain::*;
use storage_provider_api::StorageBackend;
use tokio_util::sync::CancellationToken;

pub(crate) fn directory(entry: &StorageEntry) -> bool {
    matches!(
        entry.kind,
        StorageEntryKind::Directory | StorageEntryKind::VirtualPrefix
    )
}

pub(crate) fn check_cancel(token: &CancellationToken) -> StorageResult<()> {
    if token.is_cancelled() {
        Err(StorageError::new(StorageErrorCode::Cancelled, "操作已取消"))
    } else {
        Ok(())
    }
}

/// Take a complete inventory before creating or removing anything. Parent first.
pub(crate) async fn inventory(
    backend: &dyn StorageBackend,
    root: &StorageLocator,
    token: &CancellationToken,
) -> StorageResult<Vec<StorageEntry>> {
    let mut result = vec![backend.stat(root).await?];
    let mut seen = HashSet::from([root.logical_path.clone()]);
    let mut index = 0;
    while index < result.len() {
        check_cancel(token)?;
        let entry = result[index].clone();
        if directory(&entry) {
            for child in backend.list_for_mutation(&entry.locator).await? {
                let path = &child.locator.logical_path;
                if child.locator.volume_id != root.volume_id
                    || path.rsplit_once('/').map(|(parent, _)| parent)
                        != Some(entry.locator.logical_path.as_str())
                    || normalize_path(path)? != *path
                    || !seen.insert(path.clone())
                {
                    return Err(StorageError::new(
                        StorageErrorCode::InvalidPath,
                        "文件夹包含无效或重复的路径",
                    ));
                }
                if child.kind == StorageEntryKind::Symlink {
                    return Err(StorageError::new(
                        StorageErrorCode::Unsupported,
                        format!("文件夹包含符号链接 {}，请先移出链接后重试", child.name),
                    ));
                }
                // Listing metadata may omit ETags and sizes.
                result.push(backend.stat(&child.locator).await?);
                if result.len() > 100_000 {
                    return Err(StorageError::new(
                        StorageErrorCode::Unsupported,
                        "文件夹超过十万项，请分批操作",
                    ));
                }
            }
        } else if entry.kind != StorageEntryKind::File {
            return Err(StorageError::new(
                StorageErrorCode::Unsupported,
                "此项目不支持递归操作",
            ));
        }
        index += 1;
    }
    Ok(result)
}

pub(crate) fn unchanged(before: &StorageEntry, after: &StorageEntry) -> StorageResult<()> {
    if before.kind != after.kind
        || before.size != after.size
        || before.modified_at != after.modified_at
        || before.etag != after.etag
    {
        Err(StorageError::new(
            StorageErrorCode::Conflict,
            "源内容发生变化，操作已停止",
        ))
    } else {
        Ok(())
    }
}

/// Only removes inventoried entries; newly added children make directory removal fail.
pub(crate) async fn remove_inventory(
    backend: &dyn StorageBackend,
    entries: &[StorageEntry],
) -> StorageResult<()> {
    for entry in entries.iter().rev() {
        if directory(entry) {
            match backend.stat(&entry.locator).await {
                Ok(current) if directory(&current) => {}
                Ok(_) => {
                    return Err(StorageError::new(
                        StorageErrorCode::Conflict,
                        "源文件夹已被替换，未删除替换后的项目",
                    ))
                }
                Err(error) if error.code == StorageErrorCode::NotFound => continue,
                Err(error) => return Err(error),
            }
        } else {
            unchanged(entry, &backend.stat(&entry.locator).await?)?;
        }
        match backend.delete(&entry.locator).await {
            // Implicit S3 prefixes disappear with their last child.
            Err(error) if directory(entry) && error.code == StorageErrorCode::NotFound => {}
            result => result?,
        }
    }
    Ok(())
}

pub(crate) fn check_overlap(
    source: &dyn StorageBackend,
    destination: &dyn StorageBackend,
    from: &StorageLocator,
    to: &StorageLocator,
) -> StorageResult<()> {
    let logical_overlap = from.volume_id == to.volume_id
        && (from.logical_path == to.logical_path
            || to
                .logical_path
                .starts_with(&format!("{}/", from.logical_path)));
    let physical_overlap = match (source.storage_path(from), destination.storage_path(to)) {
        (Some((a, from)), Some((b, to))) => {
            a == b && (from == to || to.starts_with(&format!("{from}/")))
        }
        _ => false,
    };
    if logical_overlap || physical_overlap {
        Err(StorageError::new(
            StorageErrorCode::InvalidPath,
            "目标不能是源项目本身或源文件夹内部的位置",
        ))
    } else {
        Ok(())
    }
}
