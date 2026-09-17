use std::{io, path::Path};

use provider_opendal::SftpHostKeyInspection;
use storage_domain::{StorageError, StorageErrorCode, StorageResult};
use tauri::Manager;

fn known_hosts_error(path: &Path, error: io::Error) -> StorageError {
    let code = match error.kind() {
        io::ErrorKind::PermissionDenied => StorageErrorCode::AccessDenied,
        io::ErrorKind::NotFound => StorageErrorCode::NotFound,
        _ => StorageErrorCode::Io,
    };
    StorageError::new(
        code,
        format!("无法读取 SSH known_hosts 文件：{}", path.display()),
    )
}

fn read_known_hosts(path: &Path) -> StorageResult<String> {
    match std::fs::read_to_string(path) {
        Ok(contents) => Ok(contents),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            // A dangling symlink (or another path that exists but cannot be
            // read) must not be mistaken for an absent known_hosts file.
            match std::fs::symlink_metadata(path) {
                Err(metadata_error) if metadata_error.kind() == io::ErrorKind::NotFound => {
                    Ok(String::new())
                }
                Err(metadata_error) => Err(known_hosts_error(path, metadata_error)),
                Ok(_) => Err(known_hosts_error(path, error)),
            }
        }
        Err(error) => Err(known_hosts_error(path, error)),
    }
}

crate::errors::commands! {
    pub async fn inspect_sftp_host_key(
        app: tauri::AppHandle,
        host: String,
        port: u16,
        known_hosts: String,
    ) -> StorageResult<SftpHostKeyInspection> {
        let local_known_hosts = if known_hosts.trim().is_empty() {
            let home_dir = app.path().home_dir().map_err(|_| {
                StorageError::new(StorageErrorCode::Internal, "无法确定用户主目录")
            })?;
            let path = home_dir.join(".ssh").join("known_hosts");
            tauri::async_runtime::spawn_blocking(move || read_known_hosts(&path))
                .await
                .map_err(|_| {
                    StorageError::new(StorageErrorCode::Internal, "无法读取 SSH known_hosts 文件")
                })??
        } else {
            String::new()
        };

        provider_opendal::inspect_sftp_host_key(
            &host,
            port,
            &known_hosts,
            &local_known_hosts,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs::File, path::PathBuf};

    #[test]
    fn missing_known_hosts_is_allowed() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join(".ssh").join("known_hosts");
        assert_eq!(read_known_hosts(&path).expect("missing file is okay"), "");
    }

    #[test]
    fn existing_known_hosts_is_read_without_modification() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let ssh = directory.path().join(".ssh");
        std::fs::create_dir(&ssh).expect("ssh directory");
        let path = ssh.join("known_hosts");
        std::fs::write(&path, "fixture\n").expect("known_hosts");
        assert_eq!(
            read_known_hosts(&path).expect("known_hosts is readable"),
            "fixture\n"
        );
        let _ = File::open(path).expect("read test does not remove known_hosts");
    }

    #[test]
    fn path_is_not_created_for_missing_file() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = PathBuf::from(directory.path())
            .join(".ssh")
            .join("known_hosts");
        let _ = read_known_hosts(&path).expect("missing file is okay");
        assert!(!path.exists());
    }

    #[test]
    fn invalid_utf8_is_an_error_instead_of_unknown() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("known_hosts");
        std::fs::write(&path, [0xff, 0xfe]).expect("known_hosts");
        let error = read_known_hosts(&path).expect_err("invalid UTF-8 must fail");
        assert_eq!(error.code, StorageErrorCode::Io);
    }

    #[test]
    fn directory_at_known_hosts_path_is_an_error() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("known_hosts");
        std::fs::create_dir(&path).expect("known_hosts directory");
        let error = read_known_hosts(&path).expect_err("directory must fail");
        assert_eq!(error.code, StorageErrorCode::Io);
    }
}
