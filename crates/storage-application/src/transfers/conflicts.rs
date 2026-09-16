use storage_domain::*;
use storage_provider_api::StorageBackend;

pub(super) async fn existing(
    backend: &dyn StorageBackend,
    target: &StorageLocator,
) -> StorageResult<Option<StorageEntry>> {
    match backend.stat(target).await {
        Ok(entry) => Ok(Some(entry)),
        Err(error) if error.code == StorageErrorCode::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub(super) async fn available_name(
    backend: &dyn StorageBackend,
    target: &StorageLocator,
    directory: bool,
) -> StorageResult<StorageLocator> {
    let (parent, name) = target
        .logical_path
        .rsplit_once('/')
        .unwrap_or(("", &target.logical_path));
    let (stem, extension) = if directory {
        (name, String::new())
    } else {
        match name.rsplit_once('.') {
            Some((stem, ext)) if !stem.is_empty() => (stem, format!(".{ext}")),
            _ => (name, String::new()),
        }
    };
    for number in 1..=10_000 {
        let name = format!("{stem} ({number}){extension}");
        let locator = StorageLocator {
            logical_path: if parent.is_empty() {
                name
            } else {
                format!("{parent}/{name}")
            },
            ..target.clone()
        };
        if existing(backend, &locator).await?.is_none() {
            return Ok(locator);
        }
    }
    Err(StorageError::new(
        StorageErrorCode::Conflict,
        "同名副本过多，请自行修改目标名称",
    ))
}

pub(super) async fn directory(
    backend: &dyn StorageBackend,
    target: &StorageLocator,
    policy: ConflictPolicy,
) -> StorageResult<()> {
    if policy == ConflictPolicy::Overwrite {
        if let Some(entry) = existing(backend, target).await? {
            if crate::tree::directory(&entry) {
                return Ok(());
            }
            return Err(StorageError::new(
                StorageErrorCode::Conflict,
                "文件与文件夹不能互相覆盖，请改名后重试",
            ));
        }
    }
    backend.create_dir(target).await
}
