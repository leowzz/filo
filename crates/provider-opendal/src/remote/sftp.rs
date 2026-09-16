//! SFTP storage backend built on russh and the SFTP v3 client.
//!
//! The backend keeps the SSH transport and one SFTP subsystem alive for the
//! lifetime of a connected volume.  Every path is checked with `lstat` before
//! it is used, so a remote symlink cannot turn a configured root into an
//! escape hatch.  Writes go to an exclusive, same-directory temporary file;
//! the transfer engine verifies that remote temporary file and publication is
//! a standard SFTP rename.

use super::{
    child_path, denied, invalid, join_root, locator_path, normalize_remote_root, unsupported,
};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use russh::{
    client,
    keys::{self, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate},
};
use russh_sftp::{
    client::{
        error::Error as SftpError,
        fs::{File as SftpFile, Metadata},
        Config as SftpConfig, SftpSession,
    },
    protocol::{OpenFlags, StatusCode},
};
use std::{future::Future, net::IpAddr, sync::Arc, time::Duration};
use storage_domain::*;
use storage_provider_api::{StagedWrite, StorageBackend, StorageReader};
use tokio::{io::AsyncWriteExt, sync::Mutex};
use uuid::Uuid;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const OPERATION_TIMEOUT: Duration = Duration::from_secs(30);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);

/// The server key verifier is deliberately constructed from exact
/// `known_hosts` entries.  Wildcards, hashed names and an empty list are not
/// accepted, so a first connection can never silently trust an unknown key.
struct HostKeyVerifier {
    keys: Vec<PublicKey>,
}

impl client::Handler for HostKeyVerifier {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let actual = server_public_key.public_key();
        Ok(self
            .keys
            .iter()
            .any(|expected| expected.algorithm() == actual.algorithm() && expected == &actual))
    }
}

struct SftpConnection {
    sftp: Arc<SftpSession>,
    // The SSH handle owns russh's event loop.  SftpSession owns the subsystem
    // channel, but dropping this handle would detach the transport while the
    // subsystem still has outstanding requests.
    _ssh: Mutex<russh::client::Handle<HostKeyVerifier>>,
}

/// A connected SFTP volume.
#[derive(Clone)]
pub struct SftpBackend {
    connection: Arc<SftpConnection>,
    volume_id: Uuid,
    root: String,
    read_only: bool,
    namespace: String,
}

fn timed_out() -> StorageError {
    let mut error = StorageError::new(StorageErrorCode::Timeout, "SFTP 请求超时，请稍后重试");
    error.retryable = true;
    error
}

fn ssh_error(error: russh::Error) -> StorageError {
    let (code, message, retryable) = match error {
        russh::Error::UnknownKey | russh::Error::KeyChanged { .. } => (
            StorageErrorCode::AuthenticationFailed,
            "SFTP 主机密钥校验失败，请检查 known_hosts",
            false,
        ),
        russh::Error::CouldNotReadKey
        | russh::Error::Keys(_)
        | russh::Error::SshKey(_)
        | russh::Error::SshEncoding(_) => (
            StorageErrorCode::InvalidConfiguration,
            "SFTP 私钥或 SSH 配置无效",
            false,
        ),
        russh::Error::ConnectionTimeout | russh::Error::KeepaliveTimeout => {
            (StorageErrorCode::Timeout, "SFTP 连接超时，请检查网络", true)
        }
        russh::Error::Disconnect | russh::Error::HUP | russh::Error::IO(_) => (
            StorageErrorCode::Network,
            "SFTP 连接已断开，请检查网络",
            true,
        ),
        _ => (
            StorageErrorCode::Network,
            "SFTP 连接失败，请检查网络和服务状态",
            true,
        ),
    };
    let mut result = StorageError::new(code, message);
    result.retryable = retryable;
    result
}

fn sftp_error(error: SftpError) -> StorageError {
    let (code, message, retryable) = match error {
        SftpError::Status(status) => match status.status_code {
            StatusCode::NoSuchFile => (StorageErrorCode::NotFound, "SFTP 文件或目录不存在", false),
            StatusCode::PermissionDenied => (
                StorageErrorCode::AccessDenied,
                "SFTP 服务端拒绝访问，请检查权限",
                false,
            ),
            StatusCode::OpUnsupported => (
                StorageErrorCode::Unsupported,
                "SFTP 服务端不支持此操作",
                false,
            ),
            StatusCode::NoConnection | StatusCode::ConnectionLost => (
                StorageErrorCode::Network,
                "SFTP 连接已断开，请检查网络",
                true,
            ),
            _ => (StorageErrorCode::Io, "SFTP 服务端操作失败", false),
        },
        SftpError::Timeout => (StorageErrorCode::Timeout, "SFTP 请求超时，请稍后重试", true),
        SftpError::IO(_) => (
            StorageErrorCode::Network,
            "SFTP 网络操作失败，请稍后重试",
            true,
        ),
        _ => (
            StorageErrorCode::Io,
            "SFTP 服务端返回了无法识别的结果",
            false,
        ),
    };
    let mut result = StorageError::new(code, message);
    result.retryable = retryable;
    result
}

fn io_error(error: std::io::Error) -> StorageError {
    let code = if error.kind() == std::io::ErrorKind::TimedOut {
        StorageErrorCode::Timeout
    } else {
        StorageErrorCode::Io
    };
    let retryable = matches!(code, StorageErrorCode::Timeout);
    let mut result = StorageError::new(code, "SFTP 文件流操作失败");
    result.retryable = retryable;
    result
}

async fn timeout_sftp<T, F>(future: F) -> StorageResult<T>
where
    F: Future<Output = Result<T, SftpError>>,
{
    tokio::time::timeout(OPERATION_TIMEOUT, future)
        .await
        .map_err(|_| timed_out())?
        .map_err(sftp_error)
}

async fn timeout_io<T, F>(future: F) -> StorageResult<T>
where
    F: Future<Output = Result<T, std::io::Error>>,
{
    tokio::time::timeout(OPERATION_TIMEOUT, future)
        .await
        .map_err(|_| timed_out())?
        .map_err(io_error)
}

fn normalized_host(host: &str, port: u16) -> StorageResult<String> {
    let host = if host.starts_with('[') && host.ends_with(']') {
        &host[1..host.len() - 1]
    } else {
        host
    };
    if host.is_empty()
        || host.trim() != host
        || host.chars().any(char::is_whitespace)
        || host.contains(['/', '\\', '\0', '[', ']'])
    {
        return Err(invalid("请填写不含端口的 SFTP 服务器地址"));
    }
    if port == 0 {
        return Err(invalid("SFTP 端口必须在 1 到 65535 之间"));
    }
    match host.matches(':').count() {
        0 => {}
        1 => return Err(invalid("服务器地址和端口需分别填写")),
        _ if host.parse::<IpAddr>().is_err() => {
            return Err(invalid("IPv6 SFTP 服务器地址格式无效"));
        }
        _ => {}
    }
    Ok(host.to_owned())
}

fn host_pattern(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_owned()
    } else {
        format!("[{host}]:{port}")
    }
}

fn parse_known_hosts(host: &str, port: u16, text: &str) -> StorageResult<Vec<PublicKey>> {
    if text.trim().is_empty() {
        return Err(invalid("SFTP 连接必须提供匹配主机和端口的 known_hosts"));
    }
    let expected_host = host_pattern(host, port);
    let mut keys = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 3 {
            continue;
        }
        let hosts = fields[0];
        let exact_match = hosts.split(',').any(|entry| entry == expected_host);
        if !exact_match {
            continue;
        }
        if hosts.split(',').any(|entry| {
            entry.starts_with('!')
                || entry.starts_with('|')
                || entry.contains('*')
                || entry.contains('?')
        }) {
            return Err(invalid("known_hosts 只能使用精确的主机和端口条目"));
        }
        let key = keys::parse_public_key_base64(fields[2])
            .map_err(|_| invalid("known_hosts 中的主机密钥格式无效"))?;
        if key.algorithm().as_str() != fields[1] {
            return Err(invalid("known_hosts 主机密钥类型与内容不一致"));
        }
        keys.push(key);
    }
    if keys.is_empty() {
        return Err(invalid("known_hosts 中没有匹配当前 SFTP 主机和端口的密钥"));
    }
    Ok(keys)
}

fn validate_logical_path(path: &str) -> StorageResult<String> {
    let logical = normalize_path(path)?;
    if logical.chars().any(char::is_control) {
        return Err(StorageError::new(
            StorageErrorCode::InvalidPath,
            "路径不能包含控制字符",
        ));
    }
    for component in logical.split('/').filter(|component| !component.is_empty()) {
        validate_name(component)?;
    }
    Ok(logical)
}

fn path_prefixes(path: &str) -> Vec<String> {
    if path == "." || path == "/" {
        return vec![path.to_owned()];
    }
    let absolute = path.starts_with('/');
    let mut current = if absolute {
        "/".to_owned()
    } else {
        String::new()
    };
    let mut prefixes = if absolute {
        vec!["/".to_owned()]
    } else {
        Vec::new()
    };
    for component in path.split('/').filter(|component| !component.is_empty()) {
        if component == "." {
            continue;
        }
        if current.is_empty() || current == "/" {
            current.push_str(component);
        } else {
            current.push('/');
            current.push_str(component);
        }
        prefixes.push(current.clone());
    }
    if prefixes.is_empty() {
        prefixes.push(".".to_owned());
    }
    prefixes
}

/// Lstat every component.  A missing final component is allowed for create
/// operations; a missing ancestor, non-directory ancestor, or symlink is not.
async fn lstat_no_symlink(
    sftp: &SftpSession,
    path: &str,
    allow_missing_final: bool,
    allow_final_symlink: bool,
) -> StorageResult<Option<Metadata>> {
    let prefixes = path_prefixes(path);
    for (index, prefix) in prefixes.iter().enumerate() {
        let attrs = match timeout_sftp(sftp.symlink_metadata(prefix.clone())).await {
            Ok(attrs) => attrs,
            Err(error)
                if allow_missing_final
                    && index + 1 == prefixes.len()
                    && error.code == StorageErrorCode::NotFound =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        if attrs.is_symlink() && !(allow_final_symlink && index + 1 == prefixes.len()) {
            return Err(denied("SFTP 路径包含符号链接，已拒绝访问"));
        }
        if index + 1 < prefixes.len() && !attrs.is_dir() {
            return Err(StorageError::new(
                StorageErrorCode::InvalidPath,
                "SFTP 路径中的上级对象不是目录",
            ));
        }
        if index + 1 == prefixes.len() {
            return Ok(Some(attrs));
        }
    }
    Ok(None)
}

fn modified_at(metadata: &Metadata) -> Option<String> {
    metadata
        .mtime
        .and_then(|seconds| DateTime::<Utc>::from_timestamp(seconds as i64, 0))
        .map(|time| time.to_rfc3339())
}

fn etag(metadata: &Metadata) -> String {
    format!(
        "{}-{}",
        metadata.size.unwrap_or_default(),
        metadata.mtime.unwrap_or_default()
    )
}

fn entry_from_metadata(
    volume_id: Uuid,
    logical: &str,
    metadata: &Metadata,
) -> StorageResult<StorageEntry> {
    let kind = if metadata.is_symlink() {
        StorageEntryKind::Symlink
    } else if metadata.is_dir() {
        StorageEntryKind::Directory
    } else if metadata.is_regular() {
        StorageEntryKind::File
    } else {
        return Err(unsupported("SFTP 不支持特殊文件类型"));
    };
    let is_file = matches!(&kind, StorageEntryKind::File);
    Ok(StorageEntry {
        locator: StorageLocator {
            volume_id,
            logical_path: logical.to_owned(),
            version_id: None,
        },
        name: logical.rsplit('/').next().unwrap_or_default().to_owned(),
        kind,
        size: is_file.then_some(metadata.len()),
        modified_at: modified_at(metadata),
        etag: Some(etag(metadata)),
        content_type: None,
        metadata: serde_json::json!({}),
    })
}

fn temporary_path(target: &str) -> String {
    let name = format!(".filo-transfer-{}", Uuid::new_v4());
    target
        .rsplit_once('/')
        .map(|(parent, _)| format!("{parent}/{name}"))
        .unwrap_or(name)
}

async fn remove_temporary(sftp: &SftpSession, path: &str) -> StorageResult<()> {
    match timeout_sftp(sftp.remove_file(path.to_owned())).await {
        Ok(()) => Ok(()),
        Err(error) if error.code == StorageErrorCode::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

async fn open_read_file(sftp: &SftpSession, path: &str) -> StorageResult<StorageReader> {
    let file = timeout_sftp(sftp.open(path.to_owned())).await?;
    Ok(Box::pin(file))
}

impl SftpBackend {
    pub(crate) async fn new(
        volume: &StorageVolume,
        config: &RemoteConnectionConfig,
        credentials: &RemoteCredentials,
    ) -> StorageResult<Self> {
        let VolumeRoot::Remote { path } = &volume.root else {
            return Err(invalid("需要 SFTP 远程存储空间"));
        };
        if config.protocol != RemoteProtocol::Sftp {
            return Err(invalid("SFTP provider 收到了错误的协议类型"));
        }
        let root = normalize_remote_root(path, RemoteProtocol::Sftp)?;
        let normalized_host = normalized_host(&config.host, config.port)?;
        let known_keys = parse_known_hosts(&normalized_host, config.port, &config.known_hosts)?;
        if credentials.username.trim().is_empty() {
            return Err(invalid("SFTP 连接需要用户名"));
        }
        let has_password = !credentials.password.is_empty();
        let has_private_key = !credentials.private_key.trim().is_empty();
        if has_password == has_private_key {
            return Err(invalid("SFTP 请选择密码或私钥认证方式"));
        }
        let private_key = if has_private_key {
            let passphrase =
                (!credentials.passphrase.is_empty()).then_some(credentials.passphrase.as_str());
            Some(
                russh::keys::decode_secret_key(&credentials.private_key, passphrase)
                    .map_err(|_| invalid("SFTP 私钥或口令无效"))?,
            )
        } else {
            None
        };

        let host = normalized_host.clone();
        let port = config.port;
        let username = credentials.username.clone();
        let password = credentials.password.clone();
        let ssh_config = russh::client::Config {
            keepalive_interval: Some(KEEPALIVE_INTERVAL),
            keepalive_max: 3,
            nodelay: true,
            ..Default::default()
        };
        let (ssh, sftp) = tokio::time::timeout(CONNECT_TIMEOUT, async move {
            let mut ssh = russh::client::connect(
                Arc::new(ssh_config),
                (host.as_str(), port),
                HostKeyVerifier { keys: known_keys },
            )
            .await
            .map_err(ssh_error)?;
            let auth = if let Some(private_key) = private_key {
                // russh defaults RSA signatures to the legacy `ssh-rsa` SHA-1
                // algorithm when no hash is supplied. Modern OpenSSH servers
                // commonly disable that algorithm, so negotiate the server's
                // strongest rsa-sha2 variant before signing.
                let rsa_hash = ssh
                    .best_supported_rsa_hash()
                    .await
                    .map_err(ssh_error)?
                    .flatten();
                let key = PrivateKeyWithHashAlg::new(Arc::new(private_key), rsa_hash);
                ssh.authenticate_publickey(username.clone(), key)
                    .await
                    .map_err(ssh_error)?
            } else {
                ssh.authenticate_password(username.clone(), password)
                    .await
                    .map_err(ssh_error)?
            };
            if !auth.success() {
                return Err(StorageError::new(
                    StorageErrorCode::AuthenticationFailed,
                    "SFTP 用户名或密码/私钥认证失败",
                ));
            }
            let channel = ssh.channel_open_session().await.map_err(ssh_error)?;
            channel
                .request_subsystem(true, "sftp")
                .await
                .map_err(ssh_error)?;
            let sftp_config = SftpConfig {
                request_timeout_secs: OPERATION_TIMEOUT.as_secs(),
                ..Default::default()
            };
            let sftp = SftpSession::new_with_config(channel.into_stream(), sftp_config)
                .await
                .map_err(sftp_error)?;
            Ok::<_, StorageError>((ssh, Arc::new(sftp)))
        })
        .await
        .map_err(|_| timed_out())??;
        sftp.set_timeout(OPERATION_TIMEOUT.as_secs());
        let sftp = Arc::new(SftpConnection {
            sftp,
            _ssh: Mutex::new(ssh),
        });
        let root_path = join_root(&root, "");
        let root_metadata = lstat_no_symlink(&sftp.sftp, &root_path, false, false)
            .await?
            .ok_or_else(|| StorageError::new(StorageErrorCode::NotFound, "SFTP 根目录不存在"))?;
        if !root_metadata.is_dir() {
            return Err(StorageError::new(
                StorageErrorCode::InvalidPath,
                "SFTP 根路径不是目录",
            ));
        }
        let namespace_host = if normalized_host.contains(':') {
            format!("[{normalized_host}]:{}", config.port)
        } else {
            format!("{normalized_host}:{}", config.port)
        };
        Ok(Self {
            connection: sftp,
            volume_id: volume.id,
            root,
            read_only: volume.read_only,
            namespace: format!("sftp://{namespace_host}"),
        })
    }

    pub(crate) async fn test_connection(&self) -> StorageResult<()> {
        let root_path = join_root(&self.root, "");
        let metadata = lstat_no_symlink(&self.connection.sftp, &root_path, false, false)
            .await?
            .ok_or_else(|| StorageError::new(StorageErrorCode::NotFound, "SFTP 根目录不存在"))?;
        if metadata.is_dir() {
            Ok(())
        } else {
            Err(StorageError::new(
                StorageErrorCode::InvalidPath,
                "SFTP 根路径不是目录",
            ))
        }
    }

    fn logical_path(&self, locator: &StorageLocator) -> StorageResult<String> {
        let logical = locator_path(locator, self.volume_id)?;
        validate_logical_path(&logical)
    }

    fn writable_path(&self, locator: &StorageLocator) -> StorageResult<String> {
        let logical = self.logical_path(locator)?;
        if self.read_only {
            return Err(denied("该 SFTP 存储空间为只读"));
        }
        if logical.is_empty() {
            return Err(StorageError::new(
                StorageErrorCode::InvalidPath,
                "不能修改 SFTP 存储根目录",
            ));
        }
        Ok(logical)
    }

    fn remote_path(&self, logical: &str) -> String {
        join_root(&self.root, logical)
    }

    async fn ensure_absent(&self, path: &str) -> StorageResult<()> {
        if lstat_no_symlink(&self.connection.sftp, path, true, false)
            .await?
            .is_some()
        {
            return Err(StorageError::new(
                StorageErrorCode::AlreadyExists,
                "同名项目已存在，不会覆盖",
            ));
        }
        Ok(())
    }

    async fn prepare_write(&self, locator: &StorageLocator) -> StorageResult<Box<dyn StagedWrite>> {
        let logical = self.writable_path(locator)?;
        let target = self.remote_path(&logical);
        self.ensure_absent(&target).await?;
        let temporary = temporary_path(&target);
        let file = timeout_sftp(self.connection.sftp.open_with_flags(
            temporary.clone(),
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
        ))
        .await?;
        Ok(Box::new(SftpStagedWrite {
            sftp: Arc::clone(&self.connection.sftp),
            temporary,
            target,
            file: Some(file),
            published: false,
        }))
    }
}

#[async_trait]
impl StorageBackend for SftpBackend {
    fn is_remote(&self) -> bool {
        true
    }

    fn volume_id(&self) -> Uuid {
        self.volume_id
    }

    fn capabilities(&self) -> StorageCapabilities {
        StorageCapabilities::remote(RemoteProtocol::Sftp, self.read_only)
    }

    fn storage_path(&self, locator: &StorageLocator) -> Option<(String, String)> {
        let logical = self.logical_path(locator).ok()?;
        Some((self.namespace.clone(), self.remote_path(&logical)))
    }

    async fn list(&self, parent: &StorageLocator) -> StorageResult<Vec<StorageEntry>> {
        let logical = self.logical_path(parent)?;
        let path = self.remote_path(&logical);
        let metadata = lstat_no_symlink(&self.connection.sftp, &path, false, false)
            .await?
            .ok_or_else(|| StorageError::new(StorageErrorCode::NotFound, "SFTP 目录不存在"))?;
        if !metadata.is_dir() {
            return Err(StorageError::new(
                StorageErrorCode::InvalidPath,
                "该位置不是 SFTP 目录",
            ));
        }
        let directory = timeout_sftp(self.connection.sftp.read_dir(path)).await?;
        let mut result = Vec::new();
        for entry in directory {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            validate_name(&name)?;
            let child_logical = child_path(&logical, &name);
            let child_path = self.remote_path(&child_logical);
            let child_metadata = lstat_no_symlink(&self.connection.sftp, &child_path, false, true)
                .await?
                .ok_or_else(|| {
                    StorageError::new(StorageErrorCode::NotFound, "SFTP 目录项已消失")
                })?;
            result.push(entry_from_metadata(
                self.volume_id,
                &child_logical,
                &child_metadata,
            )?);
        }
        Ok(result)
    }

    async fn list_for_mutation(&self, parent: &StorageLocator) -> StorageResult<Vec<StorageEntry>> {
        self.list(parent).await
    }

    async fn stat(&self, locator: &StorageLocator) -> StorageResult<StorageEntry> {
        let logical = self.logical_path(locator)?;
        let path = self.remote_path(&logical);
        let metadata = lstat_no_symlink(&self.connection.sftp, &path, false, false)
            .await?
            .ok_or_else(|| {
                StorageError::new(StorageErrorCode::NotFound, "SFTP 文件或目录不存在")
            })?;
        entry_from_metadata(self.volume_id, &logical, &metadata)
    }

    async fn create_dir(&self, locator: &StorageLocator) -> StorageResult<()> {
        let logical = self.writable_path(locator)?;
        let path = self.remote_path(&logical);
        self.ensure_absent(&path).await?;
        timeout_sftp(self.connection.sftp.create_dir(path)).await
    }

    async fn rename(&self, source: &StorageLocator, target: &StorageLocator) -> StorageResult<()> {
        let source_logical = self.writable_path(source)?;
        let target_logical = self.writable_path(target)?;
        if source_logical == target_logical {
            return Err(StorageError::new(
                StorageErrorCode::Conflict,
                "源对象和目标对象相同",
            ));
        }
        let source_path = self.remote_path(&source_logical);
        let target_path = self.remote_path(&target_logical);
        let source_metadata = lstat_no_symlink(&self.connection.sftp, &source_path, false, false)
            .await?
            .ok_or_else(|| StorageError::new(StorageErrorCode::NotFound, "SFTP 源对象不存在"))?;
        if !source_metadata.is_dir() && !source_metadata.is_regular() {
            return Err(unsupported("SFTP 不支持重命名特殊文件"));
        }
        self.ensure_absent(&target_path).await?;
        // Use only SSH_FXP_RENAME.  The posix-rename extension is intentionally
        // avoided because its overwrite semantics could destroy a late target.
        timeout_sftp(self.connection.sftp.rename(source_path, target_path)).await
    }

    async fn delete(&self, locator: &StorageLocator) -> StorageResult<()> {
        let logical = self.writable_path(locator)?;
        let path = self.remote_path(&logical);
        let metadata = lstat_no_symlink(&self.connection.sftp, &path, false, false)
            .await?
            .ok_or_else(|| {
                StorageError::new(StorageErrorCode::NotFound, "SFTP 文件或目录不存在")
            })?;
        if metadata.is_dir() {
            timeout_sftp(self.connection.sftp.remove_dir(path)).await
        } else if metadata.is_regular() {
            timeout_sftp(self.connection.sftp.remove_file(path)).await
        } else {
            Err(unsupported("SFTP 不支持删除特殊文件"))
        }
    }

    async fn open_read(&self, locator: &StorageLocator) -> StorageResult<StorageReader> {
        let logical = self.logical_path(locator)?;
        let path = self.remote_path(&logical);
        let metadata = lstat_no_symlink(&self.connection.sftp, &path, false, false)
            .await?
            .ok_or_else(|| StorageError::new(StorageErrorCode::NotFound, "SFTP 文件不存在"))?;
        if metadata.is_dir() {
            return Err(unsupported("请选择普通文件，文件夹不能作为文件读取"));
        }
        if !metadata.is_regular() {
            return Err(unsupported("SFTP 特殊文件不能作为普通文件读取"));
        }
        open_read_file(&self.connection.sftp, &path).await
    }

    async fn stage_write(&self, locator: &StorageLocator) -> StorageResult<Box<dyn StagedWrite>> {
        self.prepare_write(locator).await
    }

    async fn stage_replace(&self, expected: &StorageEntry) -> StorageResult<Box<dyn StagedWrite>> {
        let _ = self.writable_path(&expected.locator)?;
        Err(unsupported(
            "SFTP 当前只支持安全的新文件发布，覆盖文件请先选择改名或跳过",
        ))
    }
}

struct SftpStagedWrite {
    sftp: Arc<SftpSession>,
    temporary: String,
    target: String,
    file: Option<SftpFile>,
    published: bool,
}

impl SftpStagedWrite {
    async fn finish_file(&mut self) -> StorageResult<()> {
        if let Some(mut file) = self.file.take() {
            timeout_io(file.flush()).await?;
            timeout_io(file.close()).await?;
        }
        Ok(())
    }

    async fn cleanup(&mut self) {
        if let Some(file) = self.file.take() {
            let _ = tokio::time::timeout(OPERATION_TIMEOUT, file.close()).await;
        }
        let _ = remove_temporary(&self.sftp, &self.temporary).await;
    }
}

#[async_trait]
impl StagedWrite for SftpStagedWrite {
    fn verifies_on_commit(&self) -> bool {
        // The application transfer engine streams the temporary remote file
        // through its normal digest/limit/cancellation path before commit.
        false
    }

    async fn write(&mut self, bytes: &[u8]) -> StorageResult<()> {
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| invalid("SFTP 写入已经结束"))?;
        timeout_io(file.write_all(bytes)).await
    }

    async fn reader(&mut self) -> StorageResult<StorageReader> {
        self.finish_file().await?;
        open_read_file(&self.sftp, &self.temporary).await
    }

    async fn commit(mut self: Box<Self>) -> StorageResult<()> {
        self.finish_file().await?;
        if lstat_no_symlink(&self.sftp, &self.temporary, false, false)
            .await?
            .is_none()
        {
            return Err(StorageError::new(
                StorageErrorCode::NotFound,
                "SFTP 临时文件不存在，无法发布",
            ));
        }
        self.cleanup_target_check().await?;
        let result = timeout_sftp(
            self.sftp
                .rename(self.temporary.clone(), self.target.clone()),
        )
        .await;
        match result {
            Ok(()) => {
                self.published = true;
                Ok(())
            }
            Err(error) => {
                self.cleanup().await;
                Err(error)
            }
        }
    }
}

impl SftpStagedWrite {
    async fn cleanup_target_check(&mut self) -> StorageResult<()> {
        match lstat_no_symlink(&self.sftp, &self.target, true, false).await? {
            Some(_) => {
                self.cleanup().await;
                Err(StorageError::new(
                    StorageErrorCode::AlreadyExists,
                    "同名项目已存在，不会覆盖",
                ))
            }
            None => Ok(()),
        }
    }
}

impl Drop for SftpStagedWrite {
    fn drop(&mut self) {
        if self.published {
            return;
        }
        let sftp = Arc::clone(&self.sftp);
        let temporary = self.temporary.clone();
        let file = self.file.take();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                if let Some(file) = file {
                    let _ = tokio::time::timeout(OPERATION_TIMEOUT, file.close()).await;
                }
                let _ = remove_temporary(&sftp, &temporary).await;
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_string(manifest: &serde_json::Value, key: &str) -> StorageResult<String> {
        manifest
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| invalid("SFTP fixture manifest 缺少连接字段"))
    }

    fn fixture_port(manifest: &serde_json::Value) -> StorageResult<u16> {
        manifest
            .get("sftp_port")
            .and_then(serde_json::Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
            .filter(|port| *port != 0)
            .ok_or_else(|| invalid("SFTP fixture manifest 缺少有效端口"))
    }

    fn fixture_locator(volume_id: Uuid, path: impl Into<String>) -> StorageLocator {
        StorageLocator {
            volume_id,
            logical_path: path.into(),
            version_id: None,
        }
    }

    fn fixture_io_error() -> StorageError {
        StorageError::new(StorageErrorCode::Io, "SFTP fixture 读取失败")
    }

    #[test]
    fn known_hosts_requires_exact_host_and_port() {
        let valid = "[127.0.0.1]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";
        assert!(parse_known_hosts("127.0.0.1", 2222, valid).is_ok());
        assert!(parse_known_hosts("127.0.0.1", 22, valid).is_err());
        assert!(parse_known_hosts("localhost", 2222, valid).is_err());
        assert!(parse_known_hosts("127.0.0.1", 2222, "").is_err());
    }

    #[test]
    fn paths_preserve_root_boundary_and_reject_traversal() {
        assert_eq!(
            path_prefixes("/srv/data/file"),
            ["/", "/srv", "/srv/data", "/srv/data/file"]
        );
        assert_eq!(
            path_prefixes("srv/data/file"),
            ["srv", "srv/data", "srv/data/file"]
        );
        assert!(validate_logical_path("safe/child").is_ok());
        assert!(validate_logical_path("../outside").is_err());
        assert!(validate_logical_path("safe\\child").is_err());
        assert!(validate_logical_path("safe\0child").is_err());
    }

    #[test]
    fn temporary_file_stays_in_target_directory() {
        let path = temporary_path("root/folder/file.bin");
        assert!(path.starts_with("root/folder/.filo-transfer-"));
        assert!(!path.contains(".."));
    }

    /// Exercise the provider directly against the disposable asyncssh server
    /// from `scripts/remote-test-servers.py`.  Credentials are read from the
    /// private manifest and never logged.
    #[tokio::test]
    #[ignore = "requires FILO_TEST_REMOTE_FIXTURE pointing to a private SFTP fixture manifest"]
    async fn sftp_fixture_operations() -> StorageResult<()> {
        let Some(manifest_path) = std::env::var_os("FILO_TEST_REMOTE_FIXTURE") else {
            return Ok(());
        };
        let manifest_bytes = tokio::fs::read(manifest_path)
            .await
            .map_err(|_| invalid("SFTP fixture manifest 无法读取"))?;
        let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes)
            .map_err(|_| invalid("SFTP fixture manifest 格式无效"))?;
        let host = fixture_string(&manifest, "host")?;
        let port = fixture_port(&manifest)?;
        let known_hosts = fixture_string(&manifest, "known_hosts")?;
        let username = fixture_string(&manifest, "username")?;
        let password = fixture_string(&manifest, "password")?;
        let volume_id = Uuid::new_v4();
        let volume = StorageVolume {
            id: volume_id,
            connection_id: Uuid::new_v4(),
            name: "SFTP fixture".into(),
            root: VolumeRoot::Remote {
                path: String::new(),
            },
            read_only: false,
        };
        let config = RemoteConnectionConfig {
            protocol: RemoteProtocol::Sftp,
            host: host.clone(),
            port,
            share: String::new(),
            known_hosts: known_hosts.clone(),
        };
        let credentials = RemoteCredentials {
            username,
            password,
            private_key: String::new(),
            passphrase: String::new(),
            domain: String::new(),
        };

        let backend = SftpBackend::new(&volume, &config, &credentials).await?;
        backend.test_connection().await?;
        assert!(backend.is_remote());
        assert!(backend.capabilities().write);

        let root = fixture_locator(volume_id, "");
        let entries = backend.list(&root).await?;
        assert!(entries.iter().any(|entry| entry.name == "seed.txt"));
        assert!(entries.iter().any(|entry| {
            entry.name == "outside-link" && entry.kind == StorageEntryKind::Symlink
        }));
        let symlink = fixture_locator(volume_id, "outside-link");
        let symlink_stat_error = match backend.stat(&symlink).await {
            Ok(_) => fixture_io_error(),
            Err(error) => error,
        };
        assert_eq!(symlink_stat_error.code, StorageErrorCode::AccessDenied);
        let symlink_read_error = match backend.open_read(&symlink).await {
            Ok(_) => fixture_io_error(),
            Err(error) => error,
        };
        assert_eq!(symlink_read_error.code, StorageErrorCode::AccessDenied);

        // A configured symlink root is rejected during construction, before
        // any operation can resolve it.
        let symlink_root_volume = StorageVolume {
            root: VolumeRoot::Remote {
                path: "outside-link".into(),
            },
            ..volume.clone()
        };
        let symlink_root_error =
            match SftpBackend::new(&symlink_root_volume, &config, &credentials).await {
                Ok(_) => StorageError::new(
                    StorageErrorCode::Internal,
                    "SFTP fixture symlink root unexpectedly connected",
                ),
                Err(error) => error,
            };
        assert_eq!(symlink_root_error.code, StorageErrorCode::AccessDenied);

        let directory_name = format!("filo-sftp-{}", Uuid::new_v4());
        let directory = fixture_locator(volume_id, directory_name.clone());
        let payload = fixture_locator(volume_id, format!("{directory_name}/payload.bin"));
        let keep = fixture_locator(volume_id, format!("{directory_name}/keep.bin"));
        let renamed = fixture_locator(volume_id, format!("{directory_name}/renamed.bin"));
        let race = fixture_locator(volume_id, format!("{directory_name}/race.bin"));
        let abandoned = fixture_locator(volume_id, format!("{directory_name}/abandoned.bin"));
        let payload_bytes = b"SFTP staged fixture bytes\nwith a second line\n";
        let keep_bytes = b"keep this destination\n";

        let primary = async {
            backend.create_dir(&directory).await?;

            let mut staged = backend.stage_write(&payload).await?;
            staged.write(payload_bytes).await?;
            assert!(!staged.verifies_on_commit());
            let mut staged_reader = staged.reader().await?;
            let mut staged_bytes = Vec::new();
            tokio::io::AsyncReadExt::read_to_end(&mut staged_reader, &mut staged_bytes)
                .await
                .map_err(|_| fixture_io_error())?;
            assert_eq!(staged_bytes, payload_bytes);
            staged.commit().await?;

            let mut reader = backend.open_read(&payload).await?;
            let mut read_bytes = Vec::new();
            tokio::io::AsyncReadExt::read_to_end(&mut reader, &mut read_bytes)
                .await
                .map_err(|_| fixture_io_error())?;
            assert_eq!(read_bytes, payload_bytes);
            use sha2::{Digest, Sha256};
            let mut digest = Sha256::new();
            digest.update(&read_bytes);
            let mut expected_digest = Sha256::new();
            expected_digest.update(payload_bytes);
            assert_eq!(digest.finalize(), expected_digest.finalize());

            let mut keep_staged = backend.stage_write(&keep).await?;
            keep_staged.write(keep_bytes).await?;
            keep_staged.commit().await?;
            let conflict = backend
                .rename(&payload, &keep)
                .await
                .expect_err("SFTP rename must not replace an existing target");
            assert_eq!(conflict.code, StorageErrorCode::AlreadyExists);
            let mut keep_reader = backend.open_read(&keep).await?;
            let mut unchanged = Vec::new();
            tokio::io::AsyncReadExt::read_to_end(&mut keep_reader, &mut unchanged)
                .await
                .map_err(|_| fixture_io_error())?;
            assert_eq!(unchanged, keep_bytes);

            backend.rename(&payload, &renamed).await?;
            backend.delete(&renamed).await?;
            backend.delete(&keep).await?;

            // Two independent temporary files may stage the same destination;
            // the first successful standard rename wins and the other is
            // cleaned without replacing it.
            let mut first = backend.stage_write(&race).await?;
            first.write(b"first race winner").await?;
            let mut second = backend.stage_write(&race).await?;
            second.write(b"second race winner").await?;
            second.commit().await?;
            let conflict = first
                .commit()
                .await
                .expect_err("SFTP staged commit must reject a late target");
            assert_eq!(conflict.code, StorageErrorCode::AlreadyExists);
            backend.delete(&race).await?;

            let mut abandoned_write = backend.stage_write(&abandoned).await?;
            abandoned_write.write(b"cancelled before commit").await?;
            drop(abandoned_write);
            for _ in 0..10 {
                if backend
                    .list(&directory)
                    .await
                    .map(|children| {
                        !children
                            .iter()
                            .any(|entry| entry.name.starts_with(".filo-transfer-"))
                    })
                    .unwrap_or(false)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            assert!(!backend
                .list(&directory)
                .await?
                .iter()
                .any(|entry| entry.name.starts_with(".filo-transfer-")));
            backend.delete(&directory).await?;

            let readonly_volume = StorageVolume {
                read_only: true,
                ..volume.clone()
            };
            let readonly = SftpBackend::new(&readonly_volume, &config, &credentials).await?;
            let blocked = fixture_locator(volume_id, format!("{directory_name}-readonly"));
            let error = readonly
                .create_dir(&blocked)
                .await
                .expect_err("read-only SFTP must reject directory creation");
            assert_eq!(error.code, StorageErrorCode::AccessDenied);
            Ok::<(), StorageError>(())
        }
        .await;

        if let Ok(children) = backend.list(&directory).await {
            for child in children {
                let _ = backend.delete(&child.locator).await;
            }
        }
        for locator in [&renamed, &payload, &keep, &race, &abandoned] {
            let _ = backend.delete(locator).await;
        }
        let _ = backend.delete(&directory).await;

        // A wrong key for this exact host and port must fail the SSH handshake.
        let wrong_config = RemoteConnectionConfig {
            known_hosts: format!(
                "[{host}]:{port} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA6rWI3G2sz07DnfFlrouTcysQlj2P+jpNSOEWD9OJ3X"
            ),
            ..config.clone()
        };
        let wrong_key_error = match SftpBackend::new(&volume, &wrong_config, &credentials).await {
            Ok(_) => StorageError::new(
                StorageErrorCode::Internal,
                "SFTP fixture accepted a wrong host key",
            ),
            Err(error) => error,
        };
        assert_eq!(wrong_key_error.code, StorageErrorCode::AuthenticationFailed);
        primary
    }

    /// Exercise RSA private-key authentication against a one-shot asyncssh
    /// server. The fixture manifest is intentionally separate from the shared
    /// password fixture so this test never changes or restarts that service.
    #[tokio::test]
    #[ignore = "requires FILO_TEST_SFTP_KEY_FIXTURE pointing to a private RSA fixture manifest"]
    async fn sftp_fixture_rsa_private_key_auth() -> StorageResult<()> {
        let Some(manifest_path) = std::env::var_os("FILO_TEST_SFTP_KEY_FIXTURE") else {
            return Ok(());
        };
        let manifest_bytes = tokio::fs::read(manifest_path)
            .await
            .map_err(|_| invalid("SFTP RSA fixture manifest 无法读取"))?;
        let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes)
            .map_err(|_| invalid("SFTP RSA fixture manifest 格式无效"))?;
        let host = fixture_string(&manifest, "host")?;
        let port = manifest
            .get("port")
            .and_then(serde_json::Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
            .filter(|port| *port != 0)
            .ok_or_else(|| invalid("SFTP RSA fixture manifest 缺少有效端口"))?;
        let username = fixture_string(&manifest, "username")?;
        let private_key = fixture_string(&manifest, "private_key")?;
        let known_hosts = fixture_string(&manifest, "known_hosts")?;
        let volume_id = Uuid::new_v4();
        let volume = StorageVolume {
            id: volume_id,
            connection_id: Uuid::new_v4(),
            name: "SFTP RSA fixture".into(),
            root: VolumeRoot::Remote {
                path: String::new(),
            },
            read_only: true,
        };
        let config = RemoteConnectionConfig {
            protocol: RemoteProtocol::Sftp,
            host,
            port,
            share: String::new(),
            known_hosts,
        };
        let credentials = RemoteCredentials {
            username,
            password: String::new(),
            private_key,
            passphrase: String::new(),
            domain: String::new(),
        };
        let backend = SftpBackend::new(&volume, &config, &credentials).await?;
        backend.test_connection().await?;
        let seed = fixture_locator(volume_id, "seed.txt");
        let mut reader = backend.open_read(&seed).await?;
        let mut bytes = Vec::new();
        tokio::io::AsyncReadExt::read_to_end(&mut reader, &mut bytes)
            .await
            .map_err(|_| fixture_io_error())?;
        assert_eq!(bytes, b"RSA private-key fixture\n");
        Ok(())
    }
}
