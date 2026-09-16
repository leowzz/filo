use std::path::Path;
use storage_domain::*;

// OpenDAL's fs rename overwrites an existing destination. Use the OS no-replace
// primitive for this one operation so an external writer cannot defeat the preflight check.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn rename_no_replace(root: &Path, source: &str, target: &str) -> StorageResult<()> {
    use super::io_error;
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

#[cfg(target_os = "windows")]
pub(super) fn rename_no_replace(root: &Path, source: &str, target: &str) -> StorageResult<()> {
    use super::io_error;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    fn wide_path(root: &Path, logical: &str) -> StorageResult<Vec<u16>> {
        // Use path components to retain canonical Windows verbatim-path semantics.
        let mut path = root.to_path_buf();
        for part in logical.split('/') {
            path.push(part);
        }
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        if wide.contains(&0) {
            return Err(StorageError::new(
                StorageErrorCode::InvalidPath,
                "路径不能包含空字符",
            ));
        }
        wide.push(0);
        Ok(wide)
    }

    // Callers already validate both paths and forbid symlinks/root operations.
    let source = wide_path(root, source)?;
    let target = wide_path(root, target)?;
    // SAFETY: both paths are NUL-terminated UTF-16 buffers, live for the call.
    // Flags 0 deliberately excludes REPLACE_EXISTING and COPY_ALLOWED: a late
    // destination must fail, and a cross-volume move must not become copy/delete.
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0) } == 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub(super) fn rename_no_replace(_: &Path, _: &str, _: &str) -> StorageResult<()> {
    Err(StorageError::new(
        StorageErrorCode::Unsupported,
        "此平台暂未接入防覆盖重命名",
    ))
}
