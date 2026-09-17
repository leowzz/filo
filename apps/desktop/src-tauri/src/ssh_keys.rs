use std::{
    fs::{self, File},
    io::{self, Read},
    path::Path,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use storage_domain::{StorageError, StorageErrorCode, StorageResult};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const MAX_PRIVATE_KEY_BYTES: u64 = 1024 * 1024;
const DEFAULT_PRIVATE_KEY_NAMES: [&str; 3] = ["id_ed25519", "id_ecdsa", "id_rsa"];
const PRIVATE_KEY_ENVELOPES: [(&str, &str, bool); 6] = [
    (
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "-----END OPENSSH PRIVATE KEY-----",
        false,
    ),
    (
        "-----BEGIN RSA PRIVATE KEY-----",
        "-----END RSA PRIVATE KEY-----",
        true,
    ),
    (
        "-----BEGIN EC PRIVATE KEY-----",
        "-----END EC PRIVATE KEY-----",
        true,
    ),
    (
        "-----BEGIN DSA PRIVATE KEY-----",
        "-----END DSA PRIVATE KEY-----",
        true,
    ),
    (
        "-----BEGIN PRIVATE KEY-----",
        "-----END PRIVATE KEY-----",
        false,
    ),
    (
        "-----BEGIN ENCRYPTED PRIVATE KEY-----",
        "-----END ENCRYPTED PRIVATE KEY-----",
        false,
    ),
];

/// A private key selected for SFTP authentication.
///
/// This type intentionally does not implement `Debug`: `private_key` is secret material.
#[derive(serde::Serialize)]
pub struct LoadedSftpPrivateKey {
    pub path: String,
    pub private_key: String,
}

fn key_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "所选文件".to_owned())
}

fn io_reason(kind: io::ErrorKind) -> &'static str {
    match kind {
        io::ErrorKind::NotFound => "文件不存在",
        io::ErrorKind::PermissionDenied => "没有访问权限",
        io::ErrorKind::InvalidData => "文件数据无效",
        io::ErrorKind::UnexpectedEof => "文件内容不完整",
        _ => "文件读取失败",
    }
}

fn file_error(path: &Path, error: io::Error) -> StorageError {
    let code = match error.kind() {
        io::ErrorKind::NotFound => StorageErrorCode::NotFound,
        io::ErrorKind::PermissionDenied => StorageErrorCode::AccessDenied,
        _ => StorageErrorCode::Io,
    };
    StorageError::new(
        code,
        format!(
            "无法读取 SFTP 私钥文件 {}：{}",
            key_name(path),
            io_reason(error.kind())
        ),
    )
}

fn read_private_key_file(path: &Path) -> StorageResult<LoadedSftpPrivateKey> {
    let metadata = fs::symlink_metadata(path).map_err(|error| file_error(path, error))?;
    if !metadata.file_type().is_file() {
        return Err(StorageError::new(
            StorageErrorCode::InvalidConfiguration,
            format!("SFTP 私钥 {} 不是普通文件", key_name(path)),
        ));
    }
    if metadata.len() > MAX_PRIVATE_KEY_BYTES {
        return Err(StorageError::new(
            StorageErrorCode::InvalidConfiguration,
            format!("SFTP 私钥 {} 超过 1 MiB 大小限制", key_name(path)),
        ));
    }

    let file = File::open(path).map_err(|error| file_error(path, error))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize + 1);
    file.take(MAX_PRIVATE_KEY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| file_error(path, error))?;
    if bytes.len() as u64 > MAX_PRIVATE_KEY_BYTES {
        return Err(StorageError::new(
            StorageErrorCode::InvalidConfiguration,
            format!("SFTP 私钥 {} 超过 1 MiB 大小限制", key_name(path)),
        ));
    }

    let private_key = String::from_utf8(bytes).map_err(|_| {
        StorageError::new(
            StorageErrorCode::InvalidConfiguration,
            format!("SFTP 私钥 {} 必须是 UTF-8 文本", key_name(path)),
        )
    })?;
    validate_private_key_text(&private_key).map_err(|message| {
        StorageError::new(
            StorageErrorCode::InvalidConfiguration,
            format!("SFTP 私钥 {}：{message}", key_name(path)),
        )
    })?;

    Ok(LoadedSftpPrivateKey {
        path: path.to_string_lossy().into_owned(),
        private_key,
    })
}

fn load_default_private_key(ssh_dir: &Path) -> StorageResult<Option<LoadedSftpPrivateKey>> {
    let mut failures = Vec::new();
    let mut first_code = None;
    for name in DEFAULT_PRIVATE_KEY_NAMES {
        let path = ssh_dir.join(name);
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                let failure = file_error(&path, error);
                first_code.get_or_insert(failure.code.clone());
                failures.push(format!("{name}：{}", failure.message));
            }
            Ok(_) => match read_private_key_file(&path) {
                Ok(key) => return Ok(Some(key)),
                Err(error) => {
                    first_code.get_or_insert(error.code.clone());
                    failures.push(format!("{name}：{}", error.message));
                }
            },
        }
    }
    if failures.is_empty() {
        Ok(None)
    } else {
        Err(StorageError::new(
            first_code.unwrap_or(StorageErrorCode::InvalidConfiguration),
            format!("默认 SFTP 私钥均不可用：{}", failures.join("；")),
        ))
    }
}

fn validate_private_key_text(value: &str) -> Result<(), &'static str> {
    let mut lines = value.lines().map(str::trim);
    let header = lines.next().ok_or("文件为空，缺少私钥头")?;
    let (_, footer, accepts_legacy_headers) = PRIVATE_KEY_ENVELOPES
        .iter()
        .find(|(candidate, _, _)| *candidate == header)
        .copied()
        .ok_or("缺少受支持的私钥头")?;

    let mut payload = String::new();
    let mut saw_footer = false;
    for line in lines {
        if line == footer {
            if saw_footer {
                return Err("私钥尾部重复");
            }
            saw_footer = true;
            continue;
        }
        if saw_footer {
            if !line.is_empty() {
                return Err("私钥尾部后包含额外内容");
            }
            continue;
        }
        if line.is_empty() {
            continue;
        }
        if accepts_legacy_headers
            && (line == "Proc-Type: 4,ENCRYPTED" || line.starts_with("DEK-Info: "))
        {
            continue;
        }
        if line.contains(':') {
            return Err("私钥内容不是有效的 Base64 数据");
        }
        payload.push_str(line);
    }

    if !saw_footer {
        return Err("缺少私钥尾");
    }
    if payload.is_empty() {
        return Err("私钥内容为空");
    }
    STANDARD
        .decode(payload.as_bytes())
        .map(|_| ())
        .map_err(|_| "私钥内容不是有效的 Base64 数据")
}

crate::errors::commands! {
    pub async fn load_default_sftp_private_key(
        app: tauri::AppHandle,
    ) -> StorageResult<Option<LoadedSftpPrivateKey>> {
        let home_dir = app.path().home_dir().map_err(|_| {
            StorageError::new(StorageErrorCode::Internal, "无法确定用户主目录")
        })?;
        let ssh_dir = home_dir.join(".ssh");
        tauri::async_runtime::spawn_blocking(move || load_default_private_key(&ssh_dir))
            .await
            .map_err(|_| StorageError::new(StorageErrorCode::Internal, "无法读取默认 SFTP 私钥"))?
    }

    pub async fn pick_sftp_private_key(
        app: tauri::AppHandle,
    ) -> StorageResult<Option<LoadedSftpPrivateKey>> {
        let home_dir = app.path().home_dir().map_err(|_| {
            StorageError::new(StorageErrorCode::Internal, "无法确定用户主目录")
        })?;
        let ssh_dir = home_dir.join(".ssh");
        let selected = tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
                .file()
                .set_title("选择 SFTP 私钥")
                .set_directory(ssh_dir)
                .blocking_pick_file()
        })
        .await
        .map_err(|_| StorageError::new(StorageErrorCode::Internal, "无法打开文件选择器"))?;
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|_| {
            StorageError::new(StorageErrorCode::InvalidPath, "无法读取所选私钥路径")
        })?;
        tauri::async_runtime::spawn_blocking(move || read_private_key_file(&path))
            .await
            .map_err(|_| StorageError::new(StorageErrorCode::Internal, "无法读取所选 SFTP 私钥"))?
            .map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn encode_base64(bytes: &[u8]) -> String {
        STANDARD.encode(bytes)
    }

    fn openssh_key() -> String {
        format!(
            "-----BEGIN OPENSSH PRIVATE KEY-----\n{}\n-----END OPENSSH PRIVATE KEY-----\n",
            encode_base64(b"synthetic key")
        )
    }

    fn encrypted_pkcs8_key() -> String {
        format!(
            "-----BEGIN ENCRYPTED PRIVATE KEY-----\n{}\n-----END ENCRYPTED PRIVATE KEY-----\n",
            encode_base64(b"synthetic encrypted key")
        )
    }

    #[test]
    fn default_candidates_use_priority_and_skip_invalid_files() {
        let temp = tempfile::tempdir().unwrap();
        let ssh_dir = temp.path().join(".ssh");
        fs::create_dir(&ssh_dir).unwrap();
        fs::write(ssh_dir.join("id_ed25519"), "ordinary text").unwrap();
        let expected = openssh_key();
        fs::write(ssh_dir.join("id_ecdsa"), &expected).unwrap();
        fs::write(ssh_dir.join("id_rsa"), encrypted_pkcs8_key()).unwrap();

        let result = load_default_private_key(&ssh_dir).unwrap().unwrap();
        assert_eq!(result.path, ssh_dir.join("id_ecdsa").to_string_lossy());
        assert_eq!(result.private_key, expected);
    }

    #[test]
    fn default_candidates_return_none_when_all_are_missing() {
        let temp = tempfile::tempdir().unwrap();
        assert!(load_default_private_key(temp.path()).unwrap().is_none());
    }

    #[test]
    fn default_candidates_skip_oversized_and_invalid_utf8_files() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("id_ed25519"),
            vec![b'a'; MAX_PRIVATE_KEY_BYTES as usize + 1],
        )
        .unwrap();
        fs::write(temp.path().join("id_ecdsa"), [0xff, 0xfe, 0xfd]).unwrap();
        let expected = openssh_key();
        fs::write(temp.path().join("id_rsa"), &expected).unwrap();

        let result = load_default_private_key(temp.path()).unwrap().unwrap();
        assert_eq!(result.path, temp.path().join("id_rsa").to_string_lossy());
        assert_eq!(result.private_key, expected);
    }

    #[test]
    fn encrypted_pkcs8_is_accepted_without_decryption() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("encrypted");
        let expected = encrypted_pkcs8_key();
        fs::write(&path, &expected).unwrap();

        let result = read_private_key_file(&path).unwrap();
        assert_eq!(result.private_key, expected);
    }

    #[test]
    fn public_keys_and_plain_text_are_rejected_without_leaking_content() {
        for value in ["ssh-ed25519 AAAA", "ordinary text"] {
            let error = validate_private_key_text(value).expect_err("must reject");
            assert!(!error.contains(value));
        }
    }

    #[test]
    fn malformed_private_key_envelope_is_rejected() {
        let value =
            "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-base64\n-----END RSA PRIVATE KEY-----";
        assert!(validate_private_key_text(value).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn special_files_are_rejected_before_reading_and_later_candidates_are_considered() {
        use std::process::Command;

        let temp = tempfile::tempdir().unwrap();
        let fifo = temp.path().join("id_ed25519");
        assert!(Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        let expected = openssh_key();
        fs::write(temp.path().join("id_ecdsa"), &expected).unwrap();

        let result = load_default_private_key(temp.path()).unwrap().unwrap();
        assert_eq!(result.path, temp.path().join("id_ecdsa").to_string_lossy());
        assert_eq!(result.private_key, expected);
    }

    #[cfg(unix)]
    #[test]
    fn all_special_candidates_return_a_useful_error() {
        use std::process::Command;

        let temp = tempfile::tempdir().unwrap();
        for name in DEFAULT_PRIVATE_KEY_NAMES {
            let path = temp.path().join(name);
            assert!(Command::new("mkfifo")
                .arg(&path)
                .status()
                .unwrap()
                .success());
        }
        let error = load_default_private_key(temp.path())
            .err()
            .expect("must fail");
        assert!(error.message.contains("不是普通文件"));
    }
}
