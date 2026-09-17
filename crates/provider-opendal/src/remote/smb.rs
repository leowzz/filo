//! SMB2/3 storage backend.
//!
//! The provider keeps one authenticated SMB session per volume.  Operations
//! that use the high-level `smb2` API are serialized through the session
//! mutex; readers and staged writers then own cloned SMB connections and can
//! make progress without holding that mutex.  Staged writes always publish by
//! `Tree::rename`, whose `ReplaceIfExists` field is deliberately false in
//! `smb2`. New files therefore never clobber a late destination. Replacing a
//! verified file moves that destination aside, then uses the same no-clobber
//! rename so a changed target is not overwritten.

use super::{
    already_exists, only_file_replace, replace_conflict, same_regular_file, sibling_hidden,
};
use std::{future::Future, net::IpAddr, sync::Arc, time::Duration};
use storage_domain::*;
use storage_provider_api::{StagedWrite, StorageBackend, StorageReader};
use tokio::{
    io::{AsyncRead, ReadBuf},
    sync::{mpsc, Mutex},
};
use uuid::Uuid;

use smb2::{
    msg::{
        close::CloseRequest,
        create::{
            CreateDisposition, CreateRequest, CreateResponse, ImpersonationLevel, ShareAccess,
        },
    },
    pack::{ReadCursor, Unpack},
    types::{flags::FileAccessMask, status::NtStatus, Command, OplockLevel},
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const OPERATION_TIMEOUT: Duration = Duration::from_secs(30);
const READ_CHUNK_SIZE: u64 = 256 * 1024;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

/// All mutable SMB state that must be kept in sync with the tree returned by
/// `connect_share`.  A reconnect may replace that tree, so callers must hold
/// the mutex while invoking an `SmbClient` method that takes `&mut Tree`.
struct SmbSession {
    client: smb2::SmbClient,
    tree: smb2::Tree,
}

/// A connected SMB volume.  The struct intentionally contains no credentials
/// and therefore is safe to keep in provider registries and error contexts.
#[derive(Clone)]
pub(super) struct SmbBackend {
    session: Arc<Mutex<SmbSession>>,
    volume_id: Uuid,
    root: String,
    read_only: bool,
    namespace: String,
}

fn invalid(message: &'static str) -> StorageError {
    StorageError::new(StorageErrorCode::InvalidConfiguration, message)
}

fn invalid_path(message: &'static str) -> StorageError {
    StorageError::new(StorageErrorCode::InvalidPath, message)
}

/// Map SMB errors to stable, credential-free application errors.  The SMB
/// error's Display text is intentionally never returned because it may include
/// server names, paths, or authentication details that the UI does not need.
fn smb_error(error: smb2::Error) -> StorageError {
    let kind = error.kind();
    let (code, message, retryable) = match kind {
        smb2::ErrorKind::AuthRequired | smb2::ErrorKind::SigningRequired => (
            StorageErrorCode::AuthenticationFailed,
            "SMB 认证失败，请检查用户名、密码和域",
            false,
        ),
        smb2::ErrorKind::AccessDenied => (
            StorageErrorCode::AccessDenied,
            "SMB 拒绝访问，请检查共享权限",
            false,
        ),
        smb2::ErrorKind::NotFound => (StorageErrorCode::NotFound, "SMB 文件或共享不存在", false),
        smb2::ErrorKind::AlreadyExists => (
            StorageErrorCode::AlreadyExists,
            "同名项目已存在，不会覆盖",
            false,
        ),
        smb2::ErrorKind::IsADirectory | smb2::ErrorKind::NotADirectory => (
            StorageErrorCode::InvalidPath,
            "路径类型不符合当前操作",
            false,
        ),
        smb2::ErrorKind::DiskFull => (StorageErrorCode::Io, "SMB 共享空间不足", false),
        smb2::ErrorKind::TimedOut => (StorageErrorCode::Timeout, "SMB 请求超时，请稍后重试", true),
        smb2::ErrorKind::ConnectionLost | smb2::ErrorKind::SessionExpired => (
            StorageErrorCode::Network,
            "SMB 连接已断开，请检查网络后重试",
            true,
        ),
        smb2::ErrorKind::InvalidName => {
            (StorageErrorCode::InvalidPath, "SMB 不接受此文件名", false)
        }
        smb2::ErrorKind::InvalidData => (StorageErrorCode::Io, "SMB 返回了无法识别的数据", false),
        smb2::ErrorKind::Unsupported => (
            StorageErrorCode::Unsupported,
            "SMB 服务端不支持此操作",
            false,
        ),
        smb2::ErrorKind::Io | smb2::ErrorKind::Other => (
            StorageErrorCode::Network,
            "SMB 请求失败，请检查网络和共享状态",
            true,
        ),
        _ => (
            StorageErrorCode::Network,
            "SMB 请求失败，请检查网络和共享状态",
            true,
        ),
    };
    let mut result = StorageError::new(code, message);
    result.retryable = retryable;
    result
}

fn reader_io_error(error: StorageError) -> std::io::Error {
    std::io::Error::other(error)
}

fn timed_out() -> StorageError {
    let mut error = StorageError::new(StorageErrorCode::Timeout, "SMB 请求超时，请稍后重试");
    error.retryable = true;
    error
}

async fn with_timeout<T, F>(future: F) -> StorageResult<T>
where
    F: Future<Output = StorageResult<T>>,
{
    tokio::time::timeout(OPERATION_TIMEOUT, future)
        .await
        .map_err(|_| timed_out())?
}

fn validate_component(component: &str) -> StorageResult<()> {
    validate_name(component)?;
    if component.chars().any(char::is_control) {
        return Err(invalid_path("路径不能包含控制字符"));
    }
    Ok(())
}

fn validate_remote_path(path: &str) -> StorageResult<()> {
    let normalized = normalize_path(path)?;
    for component in normalized.split('/').filter(|part| !part.is_empty()) {
        validate_component(component)?;
    }
    Ok(())
}

fn server_addr(host: &str, port: u16) -> StorageResult<String> {
    if host.is_empty()
        || host.trim() != host
        || host.chars().any(char::is_whitespace)
        || host.contains(['/', '\\', '\0', '[', ']'])
    {
        return Err(invalid("请填写不含端口的 SMB 服务器地址"));
    }
    if port == 0 {
        return Err(invalid("SMB 端口必须在 1 到 65535 之间"));
    }
    let colon_count = host.matches(':').count();
    if colon_count == 1 {
        return Err(invalid("服务器地址和端口需分别填写"));
    }
    if colon_count > 1 && host.parse::<IpAddr>().is_err() {
        return Err(invalid("IPv6 服务器地址格式无效"));
    }
    if colon_count > 1 {
        Ok(format!("[{host}]:{port}"))
    } else {
        Ok(format!("{host}:{port}"))
    }
}

fn validate_share(share: &str) -> StorageResult<()> {
    if share.is_empty() || share.trim() != share {
        return Err(invalid("请填写有效的 SMB 共享名称"));
    }
    validate_component(share).map_err(|_| invalid("请填写有效的 SMB 共享名称"))
}

fn remote_child(parent: &str, name: &str) -> StorageResult<String> {
    validate_component(name)?;
    let candidate = if parent.is_empty() {
        name.to_owned()
    } else {
        format!("{parent}/{name}")
    };
    let normalized = normalize_path(&candidate)?;
    if normalized != candidate {
        return Err(invalid_path("SMB 返回了无效的子路径"));
    }
    Ok(normalized)
}

fn join_remote_path(root: &str, logical: &str) -> String {
    match (root.is_empty(), logical.is_empty()) {
        (true, _) => logical.to_owned(),
        (_, true) => root.to_owned(),
        (false, false) => format!("{root}/{logical}"),
    }
}

fn wire_path(tree: &smb2::Tree, path: &str) -> String {
    let encoded = smb2::encode_path(path);
    if !tree.is_dfs {
        return encoded;
    }
    // `SmbClient` normally resolves DFS before the operation reaches this
    // provider.  Keep the wire shape correct for a tree that was connected to
    // a DFS namespace directly as well.
    if encoded.is_empty() {
        format!(r"{}\{}", tree.server, tree.share_name)
    } else {
        format!(r"{}\{}\{}", tree.server, tree.share_name, encoded)
    }
}

/// Inspect each path component with FILE_OPEN_REPARSE_POINT before any
/// high-level operation.  `smb2::FileInfo` intentionally omits attributes,
/// while a normal CREATE follows a Windows reparse point; this small raw
/// CREATE/CLOSE probe preserves the provider's root boundary for Samba and
/// Windows shares.  The final component may be absent for create operations.
async fn ensure_no_reparse(session: &Arc<Mutex<SmbSession>>, path: &str) -> StorageResult<()> {
    let prefixes: Vec<String> = path
        .split('/')
        .filter(|component| !component.is_empty())
        .scan(String::new(), |prefix, component| {
            if prefix.is_empty() {
                prefix.push_str(component);
            } else {
                prefix.push('/');
                prefix.push_str(component);
            }
            Some(prefix.clone())
        })
        .collect();
    if prefixes.is_empty() {
        return Ok(());
    }

    let mut session_guard = session.lock().await;
    for (index, prefix) in prefixes.iter().enumerate() {
        let tree_id = session_guard.tree.tree_id;
        let request = CreateRequest {
            requested_oplock_level: OplockLevel::None,
            impersonation_level: ImpersonationLevel::Impersonation,
            desired_access: FileAccessMask::new(
                FileAccessMask::FILE_READ_ATTRIBUTES | FileAccessMask::SYNCHRONIZE,
            ),
            file_attributes: 0,
            share_access: ShareAccess(
                ShareAccess::FILE_SHARE_READ
                    | ShareAccess::FILE_SHARE_WRITE
                    | ShareAccess::FILE_SHARE_DELETE,
            ),
            create_disposition: CreateDisposition::FileOpen,
            create_options: FILE_OPEN_REPARSE_POINT,
            name: wire_path(&session_guard.tree, prefix),
            create_contexts: vec![],
        };
        let frame = {
            let client = &mut session_guard.client;
            with_timeout(async {
                client
                    .connection_mut()
                    .execute(Command::Create, &request, Some(tree_id))
                    .await
                    .map_err(smb_error)
            })
            .await?
        };
        if frame.header.status != NtStatus::SUCCESS {
            let error = smb_error(smb2::Error::Protocol {
                status: frame.header.status,
                command: Command::Create,
            });
            if index + 1 == prefixes.len() && error.code == StorageErrorCode::NotFound {
                break;
            }
            return Err(error);
        }
        let mut cursor = ReadCursor::new(&frame.body);
        let response = CreateResponse::unpack(&mut cursor).map_err(smb_error)?;
        let close = CloseRequest {
            flags: 0,
            file_id: response.file_id,
        };
        let close_frame = {
            let client = &mut session_guard.client;
            with_timeout(async {
                client
                    .connection_mut()
                    .execute(Command::Close, &close, Some(tree_id))
                    .await
                    .map_err(smb_error)
            })
            .await?
        };
        if close_frame.header.status != NtStatus::SUCCESS {
            return Err(smb_error(smb2::Error::Protocol {
                status: close_frame.header.status,
                command: Command::Close,
            }));
        }
        if response.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(StorageError::new(
                StorageErrorCode::AccessDenied,
                "SMB 路径包含符号链接或重解析点，已拒绝访问",
            ));
        }
    }
    Ok(())
}

fn modified_at(filetime: smb2::pack::FileTime) -> Option<String> {
    filetime
        .to_system_time()
        .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339())
}

fn smb_etag(size: u64, modified: smb2::pack::FileTime) -> String {
    format!("{size}-{:016x}", modified.0)
}

fn entry_from_info(volume_id: Uuid, logical: &str, info: &smb2::FileInfo) -> StorageEntry {
    let directory = info.is_directory;
    StorageEntry {
        locator: StorageLocator {
            volume_id,
            logical_path: logical.to_owned(),
            version_id: None,
        },
        name: logical.rsplit('/').next().unwrap_or_default().to_owned(),
        kind: if directory {
            StorageEntryKind::Directory
        } else {
            StorageEntryKind::File
        },
        size: (!directory).then_some(info.size),
        modified_at: modified_at(info.modified),
        etag: Some(smb_etag(info.size, info.modified)),
        content_type: None,
        metadata: serde_json::json!({}),
    }
}

fn entry_from_directory(
    volume_id: Uuid,
    logical: String,
    name: String,
    size: u64,
    modified: smb2::pack::FileTime,
    is_directory: bool,
) -> StorageEntry {
    StorageEntry {
        locator: StorageLocator {
            volume_id,
            logical_path: logical,
            version_id: None,
        },
        name,
        kind: if is_directory {
            StorageEntryKind::Directory
        } else {
            StorageEntryKind::File
        },
        size: (!is_directory).then_some(size),
        modified_at: modified_at(modified),
        etag: Some(smb_etag(size, modified)),
        content_type: None,
        metadata: serde_json::json!({}),
    }
}

/// A bounded channel-backed adapter from smb2's positioned `FileReader` to
/// the provider API's `AsyncRead`.  The worker owns the SMB handle and closes
/// it on EOF, an SMB error, or receiver cancellation, so browsing never holds
/// the session mutex for the duration of a download.
struct SmbReader {
    receiver: mpsc::Receiver<Result<Vec<u8>, StorageError>>,
    pending: Vec<u8>,
    pending_offset: usize,
    finished: bool,
}

fn reader_from_file(file: smb2::FileReader) -> StorageReader {
    let size = file.size();
    let (sender, receiver) = mpsc::channel(2);
    tokio::spawn(async move {
        let mut offset = 0;
        let mut result = Ok(());
        while offset < size {
            let length = (size - offset).min(READ_CHUNK_SIZE);
            match tokio::time::timeout(OPERATION_TIMEOUT, file.read_at(offset, length)).await {
                Err(_) => {
                    result = Err(timed_out());
                    break;
                }
                Ok(Err(error)) => {
                    result = Err(smb_error(error));
                    break;
                }
                Ok(Ok(chunk)) if chunk.is_empty() => break,
                Ok(Ok(chunk)) => {
                    offset += chunk.len() as u64;
                    if sender.send(Ok(chunk)).await.is_err() {
                        break;
                    }
                }
            }
        }
        if let Err(error) = result {
            let _ = sender.send(Err(error)).await;
        }
        match tokio::time::timeout(OPERATION_TIMEOUT, file.close()).await {
            Ok(Err(error)) => {
                let _ = sender.send(Err(smb_error(error))).await;
            }
            Err(_) => {
                let _ = sender.send(Err(timed_out())).await;
            }
            Ok(Ok(())) => {}
        }
    });
    Box::pin(SmbReader {
        receiver,
        pending: Vec::new(),
        pending_offset: 0,
        finished: false,
    })
}

impl AsyncRead for SmbReader {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let this = self.as_mut().get_mut();
        if this.finished {
            return std::task::Poll::Ready(Ok(()));
        }
        if this.pending_offset < this.pending.len() {
            let count = (this.pending.len() - this.pending_offset).min(buffer.remaining());
            buffer.put_slice(&this.pending[this.pending_offset..this.pending_offset + count]);
            this.pending_offset += count;
            return std::task::Poll::Ready(Ok(()));
        }
        this.pending.clear();
        this.pending_offset = 0;
        loop {
            match std::pin::Pin::new(&mut this.receiver).poll_recv(cx) {
                std::task::Poll::Pending => return std::task::Poll::Pending,
                std::task::Poll::Ready(None) => {
                    this.finished = true;
                    return std::task::Poll::Ready(Ok(()));
                }
                std::task::Poll::Ready(Some(Ok(chunk))) if chunk.is_empty() => continue,
                std::task::Poll::Ready(Some(Ok(chunk))) => {
                    this.pending = chunk;
                    let count = this.pending.len().min(buffer.remaining());
                    buffer.put_slice(&this.pending[..count]);
                    this.pending_offset = count;
                    return std::task::Poll::Ready(Ok(()));
                }
                std::task::Poll::Ready(Some(Err(error))) => {
                    this.finished = true;
                    return std::task::Poll::Ready(Err(reader_io_error(error)));
                }
            }
        }
    }
}

async fn open_reader_path(
    session: &Arc<Mutex<SmbSession>>,
    path: &str,
) -> StorageResult<StorageReader> {
    ensure_no_reparse(session, path).await?;
    let mut session_guard = session.lock().await;
    let SmbSession { client, tree } = &mut *session_guard;
    let file = with_timeout(async { client.open_file_reader(tree, path).await.map_err(smb_error) })
        .await?;
    drop(session_guard);
    Ok(reader_from_file(file))
}

async fn delete_temporary(session: &Arc<Mutex<SmbSession>>, path: &str) -> StorageResult<()> {
    let mut session_guard = session.lock().await;
    let result = with_timeout(async {
        let SmbSession { client, tree } = &mut *session_guard;
        client.delete_file(tree, path).await.map_err(smb_error)
    })
    .await;
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.code == StorageErrorCode::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

impl SmbBackend {
    pub(super) async fn new(
        volume: &StorageVolume,
        config: &RemoteConnectionConfig,
        credentials: &RemoteCredentials,
    ) -> StorageResult<Self> {
        let VolumeRoot::Remote { path } = &volume.root else {
            return Err(invalid("需要 SMB 远程存储空间"));
        };
        if config.protocol != RemoteProtocol::Smb {
            return Err(invalid("SMB provider 收到了错误的协议类型"));
        }
        let root = normalize_path(path)?;
        validate_remote_path(&root)?;
        validate_share(&config.share)?;
        let addr = server_addr(&config.host, config.port)?;
        let client_config = smb2::ClientConfig {
            addr,
            timeout: CONNECT_TIMEOUT,
            username: credentials.username.clone(),
            password: credentials.password.clone(),
            domain: credentials.domain.clone(),
            auto_reconnect: true,
            // The raw reparse-point probe below uses the primary connection.
            // smb2's DFS resolver may move a Tree to another connection, which
            // would make that probe address the wrong tree id. Reject DFS
            // namespace referrals until the crate exposes the tree's routed
            // connection instead of risking a path check on the wrong share.
            dfs_enabled: false,
            ..Default::default()
        };
        let mut client = with_timeout(async {
            smb2::SmbClient::connect(client_config)
                .await
                .map_err(smb_error)
        })
        .await?;
        let tree =
            with_timeout(async { client.connect_share(&config.share).await.map_err(smb_error) })
                .await?;
        let namespace = format!(
            "smb://{}/{}",
            server_addr(&config.host, config.port)?,
            config.share
        )
        .to_lowercase();
        Ok(Self {
            session: Arc::new(Mutex::new(SmbSession { client, tree })),
            volume_id: volume.id,
            root,
            read_only: volume.read_only,
            namespace,
        })
    }

    fn check_locator(&self, locator: &StorageLocator) -> StorageResult<String> {
        if locator.volume_id != self.volume_id || locator.version_id.is_some() {
            return Err(invalid_path("文件位置与当前 SMB 存储空间不匹配"));
        }
        let logical = normalize_path(&locator.logical_path)?;
        validate_remote_path(&logical)?;
        Ok(logical)
    }

    fn writable_path(&self, locator: &StorageLocator) -> StorageResult<String> {
        let logical = self.check_locator(locator)?;
        if self.read_only {
            return Err(StorageError::new(
                StorageErrorCode::AccessDenied,
                "该 SMB 存储空间为只读",
            ));
        }
        if logical.is_empty() {
            return Err(invalid_path("不能修改 SMB 存储根目录"));
        }
        Ok(logical)
    }

    fn path(&self, logical: &str) -> String {
        join_remote_path(&self.root, logical)
    }

    async fn stat_path(&self, path: &str) -> StorageResult<smb2::FileInfo> {
        ensure_no_reparse(&self.session, path).await?;
        let mut session_guard = self.session.lock().await;
        let SmbSession { client, tree } = &mut *session_guard;
        with_timeout(async { client.stat(tree, path).await.map_err(smb_error) }).await
    }

    async fn absent(&self, path: &str) -> StorageResult<()> {
        match self.stat_path(path).await {
            Ok(_) => Err(already_exists()),
            Err(error) if error.code == StorageErrorCode::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }

    async fn prepare_write(&self, locator: &StorageLocator) -> StorageResult<Box<dyn StagedWrite>> {
        self.prepare_write_mode(locator, None).await
    }

    async fn prepare_write_mode(
        &self,
        locator: &StorageLocator,
        expected: Option<StorageEntry>,
    ) -> StorageResult<Box<dyn StagedWrite>> {
        let logical = self.writable_path(locator)?;
        let target = self.path(&logical);
        if expected.is_none() {
            self.absent(&target).await?;
        }
        let temporary = sibling_hidden(&target, ".filo-transfer-");
        ensure_no_reparse(&self.session, &target).await?;
        let mut session_guard = self.session.lock().await;
        let SmbSession { client, tree } = &mut *session_guard;
        let writer = with_timeout(async {
            client
                .create_file_writer_exclusive(tree, &temporary)
                .await
                .map_err(smb_error)
        })
        .await?;
        Ok(Box::new(SmbStagedWrite {
            session: Arc::clone(&self.session),
            volume_id: self.volume_id,
            temporary,
            target,
            expected,
            writer: Some(writer),
            published: false,
        }))
    }

    async fn list_path(&self, logical: &str) -> StorageResult<Vec<StorageEntry>> {
        let path = self.path(logical);
        ensure_no_reparse(&self.session, &path).await?;
        let mut session_guard = self.session.lock().await;
        let SmbSession { client, tree } = &mut *session_guard;
        let entries =
            with_timeout(async { client.list_directory(tree, &path).await.map_err(smb_error) })
                .await?;
        entries
            .into_iter()
            .filter(|entry| entry.name != "." && entry.name != "..")
            .map(|entry| {
                let child = remote_child(logical, &entry.name)?;
                Ok(entry_from_directory(
                    self.volume_id,
                    child,
                    entry.name,
                    entry.size,
                    entry.modified,
                    entry.is_directory,
                ))
            })
            .collect()
    }
}

#[async_trait::async_trait]
impl StorageBackend for SmbBackend {
    fn is_remote(&self) -> bool {
        true
    }

    fn volume_id(&self) -> Uuid {
        self.volume_id
    }

    fn capabilities(&self) -> StorageCapabilities {
        StorageCapabilities::remote(RemoteProtocol::Smb, self.read_only)
    }

    fn storage_path(&self, locator: &StorageLocator) -> Option<(String, String)> {
        let logical = self.check_locator(locator).ok()?;
        // SMB shares are normally case-insensitive.  Lower-casing the physical
        // path is conservative for overlap checks: it may reject an operation
        // on a case-sensitive Samba share, but can never permit an overlap.
        Some((self.namespace.clone(), self.path(&logical).to_lowercase()))
    }

    async fn list(&self, parent: &StorageLocator) -> StorageResult<Vec<StorageEntry>> {
        let logical = self.check_locator(parent)?;
        let info = self.stat_path(&self.path(&logical)).await?;
        if !info.is_directory {
            return Err(invalid_path("该位置不是目录"));
        }
        self.list_path(&logical).await
    }

    async fn list_for_mutation(&self, parent: &StorageLocator) -> StorageResult<Vec<StorageEntry>> {
        self.list(parent).await
    }

    async fn stat(&self, locator: &StorageLocator) -> StorageResult<StorageEntry> {
        let logical = self.check_locator(locator)?;
        let info = self.stat_path(&self.path(&logical)).await?;
        Ok(entry_from_info(self.volume_id, &logical, &info))
    }

    async fn create_dir(&self, locator: &StorageLocator) -> StorageResult<()> {
        let logical = self.writable_path(locator)?;
        let path = self.path(&logical);
        self.absent(&path).await?;
        let mut session_guard = self.session.lock().await;
        let SmbSession { client, tree } = &mut *session_guard;
        with_timeout(async {
            client
                .create_directory(tree, &path)
                .await
                .map_err(smb_error)
        })
        .await
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
        let source_path = self.path(&source_logical);
        let target_path = self.path(&target_logical);
        ensure_no_reparse(&self.session, &source_path).await?;
        ensure_no_reparse(&self.session, &target_path).await?;
        let mut session_guard = self.session.lock().await;
        // smb2 encodes ReplaceIfExists=false in Tree::rename.  Do not add a
        // preflight-only existence check here; the wire-level no-clobber bit
        // closes the race with another writer.
        let SmbSession { client, tree } = &mut *session_guard;
        with_timeout(async {
            client
                .rename(tree, &source_path, &target_path)
                .await
                .map_err(smb_error)
        })
        .await
    }

    async fn delete(&self, locator: &StorageLocator) -> StorageResult<()> {
        let logical = self.writable_path(locator)?;
        let path = self.path(&logical);
        let info = self.stat_path(&path).await?;
        let mut session_guard = self.session.lock().await;
        let SmbSession { client, tree } = &mut *session_guard;
        let result = if info.is_directory {
            with_timeout(async {
                client
                    .delete_directory(tree, &path)
                    .await
                    .map_err(smb_error)
            })
            .await
        } else {
            with_timeout(async { client.delete_file(tree, &path).await.map_err(smb_error) }).await
        };
        result
    }

    async fn open_read(&self, locator: &StorageLocator) -> StorageResult<StorageReader> {
        let logical = self.check_locator(locator)?;
        let path = self.path(&logical);
        let info = self.stat_path(&path).await?;
        if info.is_directory {
            return Err(StorageError::new(
                StorageErrorCode::Unsupported,
                "请选择普通文件，文件夹不能作为文件读取",
            ));
        }
        open_reader_path(&self.session, &path).await
    }

    async fn stage_write(&self, locator: &StorageLocator) -> StorageResult<Box<dyn StagedWrite>> {
        self.prepare_write(locator).await
    }

    async fn stage_replace(&self, expected: &StorageEntry) -> StorageResult<Box<dyn StagedWrite>> {
        if expected.kind != StorageEntryKind::File {
            return Err(only_file_replace());
        }
        let current = self.stat(&expected.locator).await?;
        if !same_regular_file(&current, expected) {
            return Err(replace_conflict());
        }
        self.prepare_write_mode(&expected.locator, Some(expected.clone()))
            .await
    }
}

struct SmbStagedWrite {
    session: Arc<Mutex<SmbSession>>,
    volume_id: Uuid,
    temporary: String,
    target: String,
    expected: Option<StorageEntry>,
    writer: Option<smb2::FileWriter>,
    published: bool,
}

impl SmbStagedWrite {
    async fn finish_writer(&mut self) -> StorageResult<()> {
        if let Some(writer) = self.writer.take() {
            with_timeout(async { writer.finish().await.map_err(smb_error) }).await?;
        }
        Ok(())
    }

    async fn cleanup(&mut self) {
        if let Some(writer) = self.writer.take() {
            let _ = tokio::time::timeout(OPERATION_TIMEOUT, writer.abort()).await;
        }
        let _ = delete_temporary(&self.session, &self.temporary).await;
    }
}

#[async_trait::async_trait]
impl StagedWrite for SmbStagedWrite {
    fn verifies_on_commit(&self) -> bool {
        // The transfer engine calls `reader` and hashes the temporary remote
        // file before reaching this commit boundary.  Keeping this false is
        // what preserves its progress, cancellation and transfer limits.
        false
    }

    async fn write(&mut self, bytes: &[u8]) -> StorageResult<()> {
        let writer = self
            .writer
            .as_mut()
            .ok_or_else(|| invalid_path("写入已经结束"))?;
        with_timeout(async { writer.write_chunk(bytes).await.map_err(smb_error) }).await?;
        Ok(())
    }

    async fn reader(&mut self) -> StorageResult<StorageReader> {
        self.finish_writer().await?;
        open_reader_path(&self.session, &self.temporary).await
    }

    async fn commit(mut self: Box<Self>) -> StorageResult<()> {
        self.finish_writer().await?;
        // Recheck every ancestor immediately before publication.  The
        // preparation check prevents ordinary link traversal; this second
        // probe covers a parent that was replaced while the upload ran.
        ensure_no_reparse(&self.session, &self.temporary).await?;
        ensure_no_reparse(&self.session, &self.target).await?;
        if self.expected.is_some() {
            return self.publish_replace().await;
        }
        let temporary = self.temporary.clone();
        let target = self.target.clone();
        let rename_result = self.rename_path(&temporary, &target).await;
        if let Err(error) = rename_result {
            self.cleanup().await;
            return Err(error);
        }
        self.published = true;
        Ok(())
    }
}

impl SmbStagedWrite {
    async fn rename_path(&mut self, from: &str, to: &str) -> StorageResult<()> {
        let mut session_guard = self.session.lock().await;
        let SmbSession { client, tree } = &mut *session_guard;
        with_timeout(async { client.rename(tree, from, to).await.map_err(smb_error) }).await
    }

    async fn publish_replace(&mut self) -> StorageResult<()> {
        let expected = self.expected.clone().expect("replace commit");
        let info = match self.stat_target().await {
            Ok(info) => info,
            Err(error) => {
                self.cleanup().await;
                return Err(if error.code == StorageErrorCode::NotFound {
                    replace_conflict()
                } else {
                    error
                });
            }
        };
        let current = entry_from_info(self.volume_id, "", &info);
        if !same_regular_file(&current, &expected) {
            self.cleanup().await;
            return Err(replace_conflict());
        }
        let target = self.target.clone();
        let temporary = self.temporary.clone();
        let backup = sibling_hidden(&target, ".filo-backup-");
        if let Err(error) = self.rename_path(&target, &backup).await {
            self.cleanup().await;
            return Err(error);
        }
        match self.rename_path(&temporary, &target).await {
            Ok(()) => {
                self.published = true;
                let _ = delete_temporary(&self.session, &backup).await;
                Ok(())
            }
            Err(error) => {
                let _ = self.rename_path(&backup, &target).await;
                self.cleanup().await;
                Err(error)
            }
        }
    }

    async fn stat_target(&mut self) -> StorageResult<smb2::FileInfo> {
        ensure_no_reparse(&self.session, &self.target).await?;
        let mut session_guard = self.session.lock().await;
        let SmbSession { client, tree } = &mut *session_guard;
        with_timeout(async { client.stat(tree, &self.target).await.map_err(smb_error) }).await
    }
}

impl Drop for SmbStagedWrite {
    fn drop(&mut self) {
        if self.published {
            return;
        }
        let session = Arc::clone(&self.session);
        let temporary = self.temporary.clone();
        let writer = self.writer.take();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                if let Some(writer) = writer {
                    let _ = tokio::time::timeout(OPERATION_TIMEOUT, writer.abort()).await;
                }
                let _ = delete_temporary(&session, &temporary).await;
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
            .ok_or_else(|| invalid("SMB fixture manifest 缺少连接字段"))
    }

    fn fixture_port(manifest: &serde_json::Value) -> StorageResult<u16> {
        manifest
            .get("smb_port")
            .and_then(serde_json::Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
            .filter(|port| *port != 0)
            .ok_or_else(|| invalid("SMB fixture manifest 缺少有效端口"))
    }

    fn fixture_locator(volume_id: Uuid, path: impl Into<String>) -> StorageLocator {
        StorageLocator {
            volume_id,
            logical_path: path.into(),
            version_id: None,
        }
    }

    fn fixture_io_error() -> StorageError {
        StorageError::new(StorageErrorCode::Io, "SMB fixture 读取失败")
    }

    #[test]
    fn server_address_keeps_ipv6_separate_from_port() {
        assert_eq!(server_addr("nas.example", 445).unwrap(), "nas.example:445");
        assert_eq!(
            server_addr("2001:db8::10", 445).unwrap(),
            "[2001:db8::10]:445"
        );
        assert!(server_addr("nas.example:445", 445).is_err());
        assert!(server_addr("2001:db8:bad", 445).is_err());
    }

    #[test]
    fn paths_reject_traversal_and_absolute_names() {
        assert!(validate_remote_path("safe/child").is_ok());
        assert!(validate_remote_path("../outside").is_err());
        assert!(validate_remote_path("/outside").is_err());
        assert!(validate_remote_path("safe\\child").is_err());
        assert!(validate_remote_path("safe:child").is_err());
    }

    #[test]
    fn remote_path_is_rooted_without_double_separators() {
        assert_eq!(join_remote_path("", "file"), "file");
        assert_eq!(join_remote_path("share-root", "file"), "share-root/file");
        assert_eq!(join_remote_path("share-root", ""), "share-root");
    }

    /// Run against the disposable SMB2 server from
    /// `scripts/remote-test-servers.py` when a private manifest is supplied.
    /// The test deliberately reads credentials from the manifest without ever
    /// logging them, and uses UUID names so a failed run cannot touch fixture
    /// data created by another test.
    #[tokio::test]
    #[ignore = "requires FILO_TEST_REMOTE_FIXTURE pointing to a private SMB fixture manifest"]
    async fn smb_fixture_operations() -> StorageResult<()> {
        let Some(manifest_path) = std::env::var_os("FILO_TEST_REMOTE_FIXTURE") else {
            return Ok(());
        };
        let manifest_bytes = tokio::fs::read(manifest_path)
            .await
            .map_err(|_| invalid("SMB fixture manifest 无法读取"))?;
        let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes)
            .map_err(|_| invalid("SMB fixture manifest 格式无效"))?;
        let host = fixture_string(&manifest, "host")?;
        let share = fixture_string(&manifest, "share")?;
        let username = fixture_string(&manifest, "username")?;
        let password = fixture_string(&manifest, "password")?;
        let port = fixture_port(&manifest)?;
        let volume_id = Uuid::new_v4();
        let volume = StorageVolume {
            id: volume_id,
            connection_id: Uuid::new_v4(),
            name: "SMB fixture".into(),
            root: VolumeRoot::Remote {
                path: String::new(),
            },
            read_only: false,
        };
        let config = RemoteConnectionConfig {
            protocol: RemoteProtocol::Smb,
            host,
            port,
            share,
            known_hosts: String::new(),
        };
        let credentials = RemoteCredentials {
            username,
            password,
            private_key: String::new(),
            passphrase: String::new(),
            domain: String::new(),
        };
        let backend = SmbBackend::new(&volume, &config, &credentials).await?;
        assert!(backend.is_remote());
        assert!(backend.capabilities().write);

        let root = fixture_locator(volume_id, "");
        let entries = backend.list(&root).await?;
        assert!(entries.iter().any(|entry| entry.name == "seed.txt"));
        assert!(entries.iter().any(|entry| entry.name == "folder"));

        let directory_name = format!("filo-smb-{}", Uuid::new_v4());
        let directory = fixture_locator(volume_id, directory_name.clone());
        let payload = fixture_locator(volume_id, format!("{directory_name}/payload.bin"));
        let keep = fixture_locator(volume_id, format!("{directory_name}/keep.bin"));
        let renamed = fixture_locator(volume_id, format!("{directory_name}/renamed.bin"));
        let payload_bytes = b"SMB staged fixture bytes\nwith a second line\n";
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

            let stat = backend.stat(&payload).await?;
            assert_eq!(stat.size, Some(payload_bytes.len() as u64));
            let mut reader = backend.open_read(&payload).await?;
            let mut read_bytes = Vec::new();
            tokio::io::AsyncReadExt::read_to_end(&mut reader, &mut read_bytes)
                .await
                .map_err(|_| fixture_io_error())?;
            assert_eq!(read_bytes, payload_bytes);

            let mut keep_staged = backend.stage_write(&keep).await?;
            keep_staged.write(keep_bytes).await?;
            keep_staged.commit().await?;

            let conflict = backend
                .rename(&payload, &keep)
                .await
                .expect_err("SMB rename must not replace an existing target");
            assert_eq!(conflict.code, StorageErrorCode::AlreadyExists);
            let mut keep_reader = backend.open_read(&keep).await?;
            let mut unchanged = Vec::new();
            tokio::io::AsyncReadExt::read_to_end(&mut keep_reader, &mut unchanged)
                .await
                .map_err(|_| fixture_io_error())?;
            assert_eq!(unchanged, keep_bytes);

            backend.rename(&payload, &renamed).await?;
            let expected = backend.stat(&keep).await?;
            let mut replaced = backend.stage_replace(&expected).await?;
            replaced.write(b"replaced SMB payload\n").await?;
            drop(replaced.reader().await?);
            replaced.commit().await?;
            let mut replaced_reader = backend.open_read(&keep).await?;
            let mut replaced_bytes = Vec::new();
            tokio::io::AsyncReadExt::read_to_end(&mut replaced_reader, &mut replaced_bytes)
                .await
                .map_err(|_| fixture_io_error())?;
            assert_eq!(replaced_bytes, b"replaced SMB payload\n");
            backend.delete(&renamed).await?;
            backend.delete(&keep).await?;
            backend.delete(&directory).await?;

            let readonly_volume = StorageVolume {
                read_only: true,
                ..volume.clone()
            };
            let readonly = SmbBackend::new(&readonly_volume, &config, &credentials).await?;
            let blocked = fixture_locator(volume_id, format!("{directory_name}-readonly"));
            let error = readonly
                .create_dir(&blocked)
                .await
                .expect_err("read-only SMB must reject directory creation");
            assert_eq!(error.code, StorageErrorCode::AccessDenied);
            Ok::<(), StorageError>(())
        }
        .await;

        // Best-effort cleanup also removes a temporary upload if the assertion
        // above fails before commit.  Preserve the first operation error.
        if let Ok(children) = backend.list(&directory).await {
            for child in children {
                let _ = backend.delete(&child.locator).await;
            }
        }
        let _ = backend.delete(&renamed).await;
        let _ = backend.delete(&payload).await;
        let _ = backend.delete(&keep).await;
        let _ = backend.delete(&directory).await;
        primary
    }
}
