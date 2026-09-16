use super::io_error;
use std::path::Path;
use storage_domain::*;

// OpenDAL's fs rename overwrites an existing destination. Use the OS no-replace
// primitive for this one operation so an external writer cannot defeat the preflight check.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn rename_no_replace(root: &Path, source: &str, target: &str) -> StorageResult<()> {
    use rustix::fs::{open, openat, renameat_with, Mode, OFlags, RenameFlags};
    fn parent_fd(root: &Path, logical: &str) -> StorageResult<(rustix::fd::OwnedFd, String)> {
        let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let mut fd = open(root, flags, Mode::empty()).map_err(|e| io_error(e.into()))?;
        let mut parts = logical.split('/').peekable();
        while let Some(part) = parts.next() {
            if parts.peek().is_none() {
                return Ok((fd, part.to_owned()));
            }
            fd = openat(&fd, part, flags, Mode::empty()).map_err(|e| io_error(e.into()))?;
        }
        Err(StorageError::new(
            StorageErrorCode::InvalidPath,
            "不能重命名存储根目录",
        ))
    }
    let (source_parent, source_name) = parent_fd(root, source)?;
    let (target_parent, target_name) = parent_fd(root, target)?;
    renameat_with(
        source_parent,
        source_name,
        target_parent,
        target_name,
        RenameFlags::NOREPLACE,
    )
    .map_err(|e| io_error(e.into()))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(super) fn rename_no_replace(_: &Path, _: &str, _: &str) -> StorageResult<()> {
    Err(StorageError::new(
        StorageErrorCode::Unsupported,
        "此平台暂未接入防覆盖重命名",
    ))
}
