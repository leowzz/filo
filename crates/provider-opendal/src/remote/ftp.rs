use super::{
    already_exists, child_path, denied, invalid, join_root, locator_path, normalize_remote_root,
    only_file_replace, replace_conflict, same_regular_file, sibling_hidden, unsupported,
};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use std::{
    future::Future,
    io,
    net::IpAddr,
    pin::Pin,
    task::{Context, Poll},
    time::{Duration, SystemTime},
};
use storage_domain::*;
use storage_provider_api::{StagedWrite, StorageBackend, StorageReader};
use suppaftp::{
    list::{File as FtpFile, ListParser},
    tokio::{AsyncDataStream, AsyncFtpStream, AsyncRustlsConnector, AsyncRustlsFtpStream},
    FtpError, FtpResult, Status,
};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf};
use uuid::Uuid;

type PlainDataStream = AsyncDataStream<suppaftp::tokio::AsyncNoTlsStream>;
type SecureDataStream = AsyncDataStream<suppaftp::tokio::AsyncRustlsStream>;

enum FtpDataStream {
    Plain(PlainDataStream),
    Secure(SecureDataStream),
}

impl AsyncRead for FtpDataStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.as_mut().get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_read(cx, buf),
            Self::Secure(stream) => Pin::new(stream).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for FtpDataStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.as_mut().get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_write(cx, bytes),
            Self::Secure(stream) => Pin::new(stream).poll_write(cx, bytes),
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.as_mut().get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_flush(cx),
            Self::Secure(stream) => Pin::new(stream).poll_flush(cx),
        }
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.as_mut().get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_shutdown(cx),
            Self::Secure(stream) => Pin::new(stream).poll_shutdown(cx),
        }
    }
}

enum FtpSession {
    Plain(AsyncFtpStream),
    Secure(AsyncRustlsFtpStream),
}

impl FtpSession {
    async fn connect(
        config: &RemoteConnectionConfig,
        credentials: &RemoteCredentials,
    ) -> StorageResult<Self> {
        let host = normalized_host(&config.host)?;
        let endpoint = endpoint(&host, config.port);
        let mut session = match config.protocol {
            RemoteProtocol::Ftp => {
                let plain = ftp_timeout(AsyncFtpStream::connect(endpoint))
                    .await
                    .map_err(ftp_error)?;
                Self::Plain(plain)
            }
            RemoteProtocol::Ftps => {
                let connector = tls_connector()?;
                let secure = ftp_timeout(async {
                    let plain = AsyncRustlsFtpStream::connect(endpoint).await?;
                    plain.into_secure(connector, &host).await
                })
                .await
                .map_err(ftp_error)?;
                Self::Secure(secure)
            }
            _ => return Err(invalid("FTP 会话使用了不匹配的协议")),
        };
        session
            .login(&credentials.username, &credentials.password)
            .await?;
        session
            .transfer_type(suppaftp::types::FileType::Binary)
            .await
            .map_err(ftp_error)?;
        Ok(session)
    }

    async fn login(&mut self, username: &str, password: &str) -> StorageResult<()> {
        if username.is_empty() {
            return Err(invalid("FTP 连接需要用户名"));
        }
        let result = ftp_timeout(async {
            match self {
                Self::Plain(session) => session.login(username, password).await,
                Self::Secure(session) => session.login(username, password).await,
            }
        })
        .await;
        result.map_err(|error| {
            if matches!(
                error,
                FtpError::UnexpectedResponse(ref response)
                    if matches!(
                        response.status,
                        Status::NotLoggedIn | Status::InvalidCredentials
                    )
            ) {
                StorageError::new(
                    StorageErrorCode::AuthenticationFailed,
                    "FTP 用户名或密码错误",
                )
            } else {
                ftp_error(error)
            }
        })
    }

    async fn transfer_type(&mut self, file_type: suppaftp::types::FileType) -> FtpResult<()> {
        ftp_timeout(async {
            match self {
                Self::Plain(session) => session.transfer_type(file_type).await,
                Self::Secure(session) => session.transfer_type(file_type).await,
            }
        })
        .await
    }

    async fn cwd(&mut self, path: &str) -> FtpResult<()> {
        ftp_timeout(async {
            match self {
                Self::Plain(session) => session.cwd(path).await,
                Self::Secure(session) => session.cwd(path).await,
            }
        })
        .await
    }

    async fn list(&mut self, path: Option<&str>) -> FtpResult<Vec<String>> {
        ftp_timeout(async {
            match self {
                Self::Plain(session) => session.list(path).await,
                Self::Secure(session) => session.list(path).await,
            }
        })
        .await
    }

    async fn mkdir(&mut self, path: &str) -> FtpResult<()> {
        ftp_timeout(async {
            match self {
                Self::Plain(session) => session.mkdir(path).await,
                Self::Secure(session) => session.mkdir(path).await,
            }
        })
        .await
    }

    async fn rm(&mut self, path: &str) -> FtpResult<()> {
        ftp_timeout(async {
            match self {
                Self::Plain(session) => session.rm(path).await,
                Self::Secure(session) => session.rm(path).await,
            }
        })
        .await
    }

    async fn rmdir(&mut self, path: &str) -> FtpResult<()> {
        ftp_timeout(async {
            match self {
                Self::Plain(session) => session.rmdir(path).await,
                Self::Secure(session) => session.rmdir(path).await,
            }
        })
        .await
    }

    async fn retr(&mut self, path: &str) -> FtpResult<FtpDataStream> {
        ftp_timeout(async {
            match self {
                Self::Plain(session) => {
                    session.retr_as_stream(path).await.map(FtpDataStream::Plain)
                }
                Self::Secure(session) => session
                    .retr_as_stream(path)
                    .await
                    .map(FtpDataStream::Secure),
            }
        })
        .await
    }

    async fn finalize(self, stream: FtpDataStream) -> FtpResult<()> {
        match (self, stream) {
            (Self::Plain(mut session), FtpDataStream::Plain(stream)) => {
                ftp_timeout(session.finalize_retr_stream(stream)).await
            }
            (Self::Secure(mut session), FtpDataStream::Secure(stream)) => {
                ftp_timeout(session.finalize_retr_stream(stream)).await
            }
            _ => Err(FtpError::BadResponse),
        }
    }

    async fn put(&mut self, path: &str) -> FtpResult<FtpDataStream> {
        ftp_timeout(async {
            match self {
                Self::Plain(session) => session
                    .put_with_stream(path)
                    .await
                    .map(FtpDataStream::Plain),
                Self::Secure(session) => session
                    .put_with_stream(path)
                    .await
                    .map(FtpDataStream::Secure),
            }
        })
        .await
    }

    async fn finalize_put(&mut self, stream: FtpDataStream) -> FtpResult<()> {
        match (self, stream) {
            (Self::Plain(session), FtpDataStream::Plain(stream)) => {
                ftp_timeout(session.finalize_put_stream(stream)).await
            }
            (Self::Secure(session), FtpDataStream::Secure(stream)) => {
                ftp_timeout(session.finalize_put_stream(stream)).await
            }
            _ => Err(FtpError::BadResponse),
        }
    }

    async fn rename(&mut self, from: &str, to: &str) -> FtpResult<()> {
        ftp_timeout(async {
            match self {
                Self::Plain(session) => session.rename(from, to).await,
                Self::Secure(session) => session.rename(from, to).await,
            }
        })
        .await
    }
}

struct FtpReader {
    session: Option<FtpSession>,
    stream: Option<FtpDataStream>,
    finalizer: Option<Pin<Box<dyn Future<Output = FtpResult<()>> + Send>>>,
    read_deadline: Pin<Box<tokio::time::Sleep>>,
    finished: bool,
}

impl FtpReader {
    fn new(session: FtpSession, stream: FtpDataStream) -> Self {
        Self {
            session: Some(session),
            stream: Some(stream),
            finalizer: None,
            read_deadline: Box::pin(tokio::time::sleep(FTP_OPERATION_TIMEOUT)),
            finished: false,
        }
    }

    fn poll_finalize(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let Some(finalizer) = &mut self.finalizer else {
            return Poll::Ready(Ok(()));
        };
        match finalizer.as_mut().poll(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Ok(())) => {
                self.finalizer = None;
                self.finished = true;
                Poll::Ready(Ok(()))
            }
            Poll::Ready(Err(error)) => {
                self.finalizer = None;
                self.finished = true;
                let _ = error;
                Poll::Ready(Err(io::Error::other("FTP 数据传输未正常结束")))
            }
        }
    }
}

impl AsyncRead for FtpReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        loop {
            if self.finished {
                return Poll::Ready(Ok(()));
            }
            if self.finalizer.is_some() {
                return self.poll_finalize(cx);
            }
            if self.read_deadline.as_mut().poll(cx).is_ready() {
                self.finished = true;
                return Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "FTP 数据读取超时",
                )));
            }
            let Some(stream) = self.stream.as_mut() else {
                self.finished = true;
                return Poll::Ready(Ok(()));
            };
            let before = buf.filled().len();
            match Pin::new(stream).poll_read(cx, buf) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Err(error)) => {
                    self.finished = true;
                    return Poll::Ready(Err(error));
                }
                Poll::Ready(Ok(())) if buf.filled().len() > before => {
                    self.read_deadline
                        .as_mut()
                        .reset(tokio::time::Instant::now() + FTP_OPERATION_TIMEOUT);
                    return Poll::Ready(Ok(()));
                }
                Poll::Ready(Ok(())) => {
                    let stream = self.stream.take().expect("FTP reader stream");
                    let session = self.session.take().expect("FTP reader session");
                    self.finalizer = Some(Box::pin(async move { session.finalize(stream).await }));
                }
            }
        }
    }
}

#[derive(Clone)]
pub struct FtpBackend {
    volume_id: Uuid,
    root: String,
    read_only: bool,
    config: RemoteConnectionConfig,
    credentials: RemoteCredentials,
    namespace: String,
}

impl FtpBackend {
    pub fn new(
        volume: &StorageVolume,
        config: &RemoteConnectionConfig,
        credentials: &RemoteCredentials,
    ) -> StorageResult<Self> {
        let VolumeRoot::Remote { path } = &volume.root else {
            return Err(invalid("需要远程存储空间"));
        };
        if !matches!(config.protocol, RemoteProtocol::Ftp | RemoteProtocol::Ftps) {
            return Err(invalid("连接协议不是 FTP 或 FTPS"));
        }
        let host = normalized_host(&config.host)?;
        if config.port == 0 || credentials.username.trim().is_empty() {
            return Err(invalid("请填写有效的 FTP 主机、端口和用户名"));
        }
        if credentials.username.chars().any(char::is_control)
            || credentials.password.chars().any(char::is_control)
        {
            return Err(invalid("FTP 用户名和密码不能包含控制字符"));
        }
        let root = normalize_remote_root(path, config.protocol)?;
        let scheme = if matches!(config.protocol, RemoteProtocol::Ftps) {
            "ftps"
        } else {
            "ftp"
        };
        Ok(Self {
            volume_id: volume.id,
            root,
            read_only: volume.read_only,
            config: config.clone(),
            credentials: credentials.clone(),
            namespace: format!("remote:{scheme}://{}:{}/", host.to_lowercase(), config.port),
        })
    }

    async fn connect(&self) -> StorageResult<FtpSession> {
        let mut session = FtpSession::connect(&self.config, &self.credentials).await?;
        self.prepare_root(&mut session).await?;
        Ok(session)
    }

    async fn prepare_root(&self, session: &mut FtpSession) -> StorageResult<()> {
        if self.root.is_empty() || self.root == "." {
            return Ok(());
        }
        let root = self.root.trim_start_matches('/');
        if self.root.starts_with('/') {
            session.cwd("/").await.map_err(ftp_error)?;
        }
        if root.is_empty() {
            return Ok(());
        }
        self.ensure_safe_path(session, root, false).await?;
        session.cwd(root).await.map_err(ftp_error)
    }

    fn path(&self, locator: &StorageLocator, write: bool) -> StorageResult<String> {
        let path = locator_path(locator, self.volume_id)?;
        if write && (self.read_only || path.is_empty()) {
            return Err(denied("只读位置或远程根目录不能修改"));
        }
        Ok(path)
    }

    fn entry(&self, logical: &str, file: &FtpFile) -> StorageResult<StorageEntry> {
        let name = file.name();
        if name.is_empty() || name == "." || name == ".." {
            return Err(invalid("FTP 返回了无效的文件名"));
        }
        validate_name(name)?;
        let kind = if file.is_symlink() {
            StorageEntryKind::Symlink
        } else if file.is_directory() {
            StorageEntryKind::Directory
        } else if file.is_file() {
            StorageEntryKind::File
        } else {
            return Err(unsupported("FTP 返回了不支持的文件类型"));
        };
        let modified_at = file
            .modified()
            .duration_since(SystemTime::UNIX_EPOCH)
            .ok()
            .map(|duration| DateTime::<Utc>::from(SystemTime::UNIX_EPOCH + duration).to_rfc3339());
        Ok(StorageEntry {
            locator: StorageLocator {
                volume_id: self.volume_id,
                logical_path: child_path(logical, name),
                version_id: None,
            },
            name: name.to_owned(),
            kind: kind.clone(),
            size: matches!(kind, StorageEntryKind::File).then(|| file.size() as u64),
            modified_at,
            etag: None,
            content_type: None,
            metadata: serde_json::json!({}),
        })
    }

    async fn listing(&self, session: &mut FtpSession, parent: &str) -> StorageResult<Vec<FtpFile>> {
        let path = (!parent.is_empty()).then_some(parent);
        let lines = session.list(path).await.map_err(ftp_listing_error)?;
        lines
            .into_iter()
            .filter(|line| !line.trim_start().starts_with("total "))
            .map(|line| {
                ListParser::parse_posix(&line)
                    .or_else(|_| ListParser::parse_dos(&line))
                    .map_err(|_| {
                        StorageError::new(StorageErrorCode::Io, "FTP 返回的目录列表无法解析")
                    })
            })
            .collect()
    }

    async fn ensure_safe_path(
        &self,
        session: &mut FtpSession,
        logical: &str,
        allow_missing_leaf: bool,
    ) -> StorageResult<()> {
        let components: Vec<&str> = logical.split('/').filter(|part| !part.is_empty()).collect();
        let mut parent = String::new();
        for (index, component) in components.iter().enumerate() {
            let files = self.listing(session, &parent).await?;
            let file = files.into_iter().find(|file| file.name() == *component);
            let is_leaf = index + 1 == components.len();
            let Some(file) = file else {
                if is_leaf && allow_missing_leaf {
                    return Ok(());
                }
                return Err(StorageError::new(
                    StorageErrorCode::NotFound,
                    "远程文件或目录不存在",
                ));
            };
            if file.is_symlink() {
                return Err(denied("远程路径包含符号链接，已拒绝访问"));
            }
            if !is_leaf && !file.is_directory() {
                return Err(StorageError::new(
                    StorageErrorCode::InvalidPath,
                    "远程路径的父级不是目录",
                ));
            }
            parent = child_path(&parent, component);
        }
        Ok(())
    }

    async fn safe_leaf(&self, session: &mut FtpSession, logical: &str) -> StorageResult<FtpFile> {
        let (parent, name) = logical.rsplit_once('/').unwrap_or(("", logical));
        self.ensure_safe_path(session, parent, false).await?;
        self.listing(session, parent)
            .await?
            .into_iter()
            .find(|file| file.name() == name)
            .ok_or_else(|| StorageError::new(StorageErrorCode::NotFound, "远程文件或目录不存在"))
    }

    async fn list_impl(&self, parent: &StorageLocator) -> StorageResult<Vec<StorageEntry>> {
        let logical = self.path(parent, false)?;
        let mut session = self.connect().await?;
        self.ensure_safe_path(&mut session, &logical, false).await?;
        let files = self.listing(&mut session, logical.as_str()).await?;
        let mut entries = Vec::with_capacity(files.len());
        for file in files {
            if file.name() == "." || file.name() == ".." {
                continue;
            }
            entries.push(self.entry(&logical, &file)?);
        }
        Ok(entries)
    }

    pub async fn test_connection(&self) -> StorageResult<()> {
        let mut session = self.connect().await?;
        // connect() already changes into the configured root. Passing root a
        // second time would incorrectly test root/root on relative roots.
        session.list(None).await.map_err(ftp_listing_error)?;
        Ok(())
    }
}

#[async_trait]
impl StorageBackend for FtpBackend {
    fn is_remote(&self) -> bool {
        true
    }

    fn volume_id(&self) -> Uuid {
        self.volume_id
    }

    fn capabilities(&self) -> StorageCapabilities {
        StorageCapabilities::remote(self.config.protocol, self.read_only)
    }

    fn storage_path(&self, locator: &StorageLocator) -> Option<(String, String)> {
        let logical = locator_path(locator, self.volume_id).ok()?;
        Some((
            self.namespace.clone(),
            join_root(&self.root, &logical).trim_matches('/').to_owned(),
        ))
    }

    async fn list(&self, parent: &StorageLocator) -> StorageResult<Vec<StorageEntry>> {
        self.list_impl(parent).await
    }

    async fn list_for_mutation(&self, parent: &StorageLocator) -> StorageResult<Vec<StorageEntry>> {
        self.list_impl(parent).await
    }

    async fn stat(&self, locator: &StorageLocator) -> StorageResult<StorageEntry> {
        let logical = self.path(locator, false)?;
        if logical.is_empty() {
            return Ok(StorageEntry {
                locator: locator.clone(),
                name: String::new(),
                kind: StorageEntryKind::Directory,
                size: None,
                modified_at: None,
                etag: None,
                content_type: None,
                metadata: serde_json::json!({}),
            });
        }
        let mut session = self.connect().await?;
        let file = self.safe_leaf(&mut session, &logical).await?;
        if file.is_symlink() {
            return Err(denied("远程符号链接不能访问"));
        }
        let mut entry = self.entry(
            logical
                .rsplit_once('/')
                .map(|(parent, _)| parent)
                .unwrap_or(""),
            &file,
        )?;
        entry.locator = locator.clone();
        Ok(entry)
    }

    async fn create_dir(&self, locator: &StorageLocator) -> StorageResult<()> {
        let logical = self.path(locator, true)?;
        let mut session = self.connect().await?;
        let parent = logical
            .rsplit_once('/')
            .map(|(parent, _)| parent)
            .unwrap_or("");
        self.ensure_safe_path(&mut session, parent, false).await?;
        match self.safe_leaf(&mut session, &logical).await {
            Ok(_) => Err(StorageError::new(
                StorageErrorCode::AlreadyExists,
                "同名项目已存在",
            )),
            Err(error) if error.code == StorageErrorCode::NotFound => {
                session.mkdir(&logical).await.map_err(ftp_error)
            }
            Err(error) => Err(error),
        }
    }

    async fn rename(&self, source: &StorageLocator, target: &StorageLocator) -> StorageResult<()> {
        let from = self.path(source, true)?;
        let to = self.path(target, true)?;
        if from == to {
            return Err(StorageError::new(
                StorageErrorCode::Conflict,
                "源对象和目标对象相同",
            ));
        }
        let mut session = self.connect().await?;
        let source_file = self.safe_leaf(&mut session, &from).await?;
        if source_file.is_symlink() {
            return Err(denied("远程符号链接不能访问"));
        }
        if !source_file.is_file() && !source_file.is_directory() {
            return Err(unsupported("FTP 不支持重命名此项目"));
        }
        match self.safe_leaf(&mut session, &to).await {
            Ok(_) => Err(already_exists()),
            Err(error) if error.code == StorageErrorCode::NotFound => {
                session.rename(&from, &to).await.map_err(ftp_error)
            }
            Err(error) => Err(error),
        }
    }

    async fn delete(&self, locator: &StorageLocator) -> StorageResult<()> {
        let logical = self.path(locator, true)?;
        let mut session = self.connect().await?;
        let entry_file = self.safe_leaf(&mut session, &logical).await?;
        if entry_file.is_symlink() {
            return Err(denied("远程符号链接不能删除"));
        }
        if entry_file.is_directory() {
            session.rmdir(&logical).await.map_err(ftp_error)
        } else if entry_file.is_file() {
            session.rm(&logical).await.map_err(ftp_error)
        } else {
            Err(unsupported("FTP 不支持删除此项目"))
        }
    }

    async fn open_read(&self, locator: &StorageLocator) -> StorageResult<StorageReader> {
        let logical = self.path(locator, false)?;
        let mut session = self.connect().await?;
        let entry = self.safe_leaf(&mut session, &logical).await?;
        if entry.is_symlink() {
            return Err(denied("远程符号链接不能访问"));
        }
        if !entry.is_file() {
            return Err(unsupported("当前只支持读取普通文件"));
        }
        let stream = session.retr(&logical).await.map_err(ftp_error)?;
        Ok(Box::pin(FtpReader::new(session, stream)))
    }

    async fn stage_write(&self, locator: &StorageLocator) -> StorageResult<Box<dyn StagedWrite>> {
        self.prepare_write(locator, None).await
    }

    async fn stage_replace(&self, expected: &StorageEntry) -> StorageResult<Box<dyn StagedWrite>> {
        if expected.kind != StorageEntryKind::File {
            return Err(only_file_replace());
        }
        self.prepare_write(&expected.locator, Some(expected.clone()))
            .await
    }
}

impl FtpBackend {
    async fn prepare_write(
        &self,
        locator: &StorageLocator,
        expected: Option<StorageEntry>,
    ) -> StorageResult<Box<dyn StagedWrite>> {
        let logical = self.path(locator, true)?;
        let mut session = self.connect().await?;
        let parent = logical
            .rsplit_once('/')
            .map(|(parent, _)| parent)
            .unwrap_or("");
        self.ensure_safe_path(&mut session, parent, false).await?;
        if let Some(expected) = &expected {
            let current = self.leaf_entry(&mut session, &logical).await?;
            if !same_regular_file(&current, expected) {
                return Err(replace_conflict());
            }
        } else {
            self.ensure_absent(&mut session, &logical).await?;
        }
        let temporary = sibling_hidden(&logical, ".filo-transfer-");
        self.ensure_absent(&mut session, &temporary).await?;
        let stream = session.put(&temporary).await.map_err(ftp_error)?;
        Ok(Box::new(FtpStagedWrite {
            backend: self.clone(),
            temporary,
            target: logical,
            expected,
            session: Some(session),
            stream: Some(stream),
            published: false,
        }))
    }

    async fn leaf_entry(
        &self,
        session: &mut FtpSession,
        logical: &str,
    ) -> StorageResult<StorageEntry> {
        let file = self.safe_leaf(session, logical).await?;
        if file.is_symlink() {
            return Err(denied("远程符号链接不能访问"));
        }
        let parent = logical
            .rsplit_once('/')
            .map(|(parent, _)| parent)
            .unwrap_or("");
        let mut entry = self.entry(parent, &file)?;
        entry.locator.logical_path = logical.to_owned();
        Ok(entry)
    }

    async fn ensure_absent(&self, session: &mut FtpSession, logical: &str) -> StorageResult<()> {
        match self.safe_leaf(session, logical).await {
            Ok(_) => Err(already_exists()),
            Err(error) if error.code == StorageErrorCode::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }

    async fn publish(
        &self,
        session: &mut FtpSession,
        temporary: &str,
        target: &str,
        expected: Option<&StorageEntry>,
    ) -> StorageResult<()> {
        if let Some(expected) = expected {
            let current = self.leaf_entry(session, target).await?;
            if !same_regular_file(&current, expected) {
                let _ = session.rm(temporary).await;
                return Err(replace_conflict());
            }
            let backup = sibling_hidden(target, ".filo-backup-");
            if let Err(error) = session.rename(target, &backup).await {
                let _ = session.rm(temporary).await;
                return Err(ftp_error(error));
            }
            match session.rename(temporary, target).await {
                Ok(()) => {
                    let _ = session.rm(&backup).await;
                    Ok(())
                }
                Err(error) => {
                    let _ = session.rename(&backup, target).await;
                    let _ = session.rm(temporary).await;
                    Err(ftp_error(error))
                }
            }
        } else {
            match self.ensure_absent(session, target).await {
                Ok(()) => session.rename(temporary, target).await.map_err(ftp_error),
                Err(error) => {
                    let _ = session.rm(temporary).await;
                    Err(error)
                }
            }
        }
    }
}

struct FtpStagedWrite {
    backend: FtpBackend,
    temporary: String,
    target: String,
    expected: Option<StorageEntry>,
    session: Option<FtpSession>,
    stream: Option<FtpDataStream>,
    published: bool,
}

impl FtpStagedWrite {
    async fn finish_stream(&mut self) -> StorageResult<()> {
        if let Some(stream) = self.stream.take() {
            let session = self
                .session
                .as_mut()
                .ok_or_else(|| invalid("FTP 写入已经结束"))?;
            session.finalize_put(stream).await.map_err(ftp_error)?;
        }
        Ok(())
    }
}

#[async_trait]
impl StagedWrite for FtpStagedWrite {
    async fn write(&mut self, bytes: &[u8]) -> StorageResult<()> {
        let stream = self
            .stream
            .as_mut()
            .ok_or_else(|| invalid("FTP 写入已经结束"))?;
        tokio::time::timeout(FTP_OPERATION_TIMEOUT, stream.write_all(bytes))
            .await
            .map_err(|_| timeout_error())?
            .map_err(|error| {
                if error.kind() == io::ErrorKind::TimedOut {
                    timeout_error()
                } else {
                    StorageError::new(StorageErrorCode::Io, "FTP 写入失败")
                }
            })
    }

    async fn reader(&mut self) -> StorageResult<StorageReader> {
        self.finish_stream().await?;
        let mut session = self
            .session
            .take()
            .ok_or_else(|| invalid("FTP 写入已经结束"))?;
        let stream = session.retr(&self.temporary).await.map_err(ftp_error)?;
        Ok(Box::pin(FtpReader::new(session, stream)))
    }

    async fn commit(mut self: Box<Self>) -> StorageResult<()> {
        self.finish_stream().await?;
        self.session.take();
        let mut session = self.backend.connect().await?;
        self.backend
            .publish(
                &mut session,
                &self.temporary,
                &self.target,
                self.expected.as_ref(),
            )
            .await?;
        self.published = true;
        Ok(())
    }
}

impl Drop for FtpStagedWrite {
    fn drop(&mut self) {
        if self.published {
            return;
        }
        self.stream.take();
        self.session.take();
        let backend = self.backend.clone();
        let temporary = self.temporary.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                if let Ok(mut session) = backend.connect().await {
                    let _ = session.rm(&temporary).await;
                }
            });
        }
    }
}

fn normalized_host(host: &str) -> StorageResult<String> {
    let host = host.trim();
    let host = match (host.starts_with('['), host.ends_with(']')) {
        (true, true) => &host[1..host.len() - 1],
        (false, false) => host,
        _ => return Err(invalid("远程主机地址无效")),
    };
    if host.is_empty() || host.chars().any(char::is_whitespace) || host.contains(['/', '\\', '@']) {
        return Err(invalid("远程主机地址无效"));
    }
    if host.contains(':') && host.parse::<IpAddr>().is_err() {
        return Err(invalid("IPv6 主机地址格式无效"));
    }
    Ok(host.to_owned())
}

fn endpoint(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn tls_connector() -> StorageResult<AsyncRustlsConnector> {
    let mut roots = rustls::RootCertStore::empty();
    let certificates = rustls_native_certs::load_native_certs();
    for certificate in certificates.certs {
        let _ = roots.add(certificate);
    }
    if roots.is_empty() {
        return Err(StorageError::new(
            StorageErrorCode::InvalidConfiguration,
            "系统证书库为空，无法验证 FTPS 服务器",
        ));
    }
    // The S3 stack enables aws-lc-rs while suppaftp enables ring. Select the
    // provider explicitly so rustls never has to guess from process features.
    let config = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|_| {
        StorageError::new(
            StorageErrorCode::InvalidConfiguration,
            "FTPS 不支持当前 TLS 协议版本",
        )
    })?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(AsyncRustlsConnector::from(
        tokio_rustls::TlsConnector::from(std::sync::Arc::new(config)),
    ))
}

fn timeout_error() -> StorageError {
    StorageError {
        code: StorageErrorCode::Timeout,
        message: "FTP 连接超时，请检查网络和服务地址".into(),
        retryable: true,
    }
}

const FTP_OPERATION_TIMEOUT: Duration = Duration::from_secs(30);

async fn ftp_timeout<T, F>(future: F) -> FtpResult<T>
where
    F: Future<Output = FtpResult<T>>,
{
    tokio::time::timeout(FTP_OPERATION_TIMEOUT, future)
        .await
        .unwrap_or_else(|_| {
            Err(FtpError::ConnectionError(io::Error::new(
                io::ErrorKind::TimedOut,
                "FTP 操作超时",
            )))
        })
}

fn ftp_listing_error(error: FtpError) -> StorageError {
    match error {
        FtpError::UnexpectedResponse(response)
            if matches!(
                response.status,
                Status::BadCommand
                    | Status::BadArguments
                    | Status::NotImplemented
                    | Status::NotImplementedParameter
            ) =>
        {
            unsupported("FTP 服务端不支持安全目录列表")
        }
        other => ftp_error(other),
    }
}

fn ftp_error(error: FtpError) -> StorageError {
    match error {
        FtpError::ConnectionError(error) if error.kind() == io::ErrorKind::TimedOut => {
            timeout_error()
        }
        FtpError::ConnectionError(_) => network_error(),
        FtpError::SecureError(_) => StorageError::new(
            StorageErrorCode::Network,
            "FTPS 安全连接失败，请检查服务器证书",
        ),
        FtpError::UnexpectedResponse(response) => match response.status {
            Status::InvalidCredentials | Status::NotLoggedIn => StorageError::new(
                StorageErrorCode::AuthenticationFailed,
                "FTP 用户名或密码错误",
            ),
            Status::FileUnavailable => {
                StorageError::new(StorageErrorCode::NotFound, "远程文件或目录不存在")
            }
            Status::BadFilename => {
                StorageError::new(StorageErrorCode::InvalidPath, "远程文件名无效")
            }
            Status::NotImplemented | Status::NotImplementedParameter => {
                unsupported("FTP 服务器不支持此操作")
            }
            status if status.code() >= 400 && status.code() < 500 => network_error(),
            _ => StorageError::new(StorageErrorCode::Io, "FTP 操作失败"),
        },
        FtpError::BadResponse => StorageError::new(StorageErrorCode::Io, "FTP 返回了无效响应"),
        FtpError::InvalidAddress(_) => {
            StorageError::new(StorageErrorCode::InvalidConfiguration, "FTP 服务器地址无效")
        }
        FtpError::DataConnectionAlreadyOpen => {
            StorageError::new(StorageErrorCode::Network, "FTP 数据连接状态异常")
        }
    }
}

fn network_error() -> StorageError {
    StorageError {
        code: StorageErrorCode::Network,
        message: "FTP 请求失败，请检查网络和服务状态".into(),
        retryable: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::path::PathBuf;
    use tokio::io::AsyncReadExt;

    #[derive(Deserialize)]
    struct Fixture {
        host: String,
        ftp_port: u16,
        ftps_port: u16,
        username: String,
        password: String,
        tls_ca: PathBuf,
    }

    fn fixture() -> Option<Fixture> {
        let path = std::env::var_os("FILO_TEST_REMOTE_FIXTURE")?;
        let bytes = std::fs::read(path).expect("FILO_TEST_REMOTE_FIXTURE must be readable");
        Some(serde_json::from_slice(&bytes).expect("FILO_TEST_REMOTE_FIXTURE must be valid JSON"))
    }

    fn fixture_volume(path: &str, protocol: RemoteProtocol) -> StorageVolume {
        StorageVolume {
            id: Uuid::new_v4(),
            connection_id: Uuid::new_v4(),
            name: format!("{protocol:?} fixture"),
            root: VolumeRoot::Remote {
                path: path.to_owned(),
            },
            read_only: false,
        }
    }

    fn fixture_locator(volume_id: Uuid, logical_path: &str) -> StorageLocator {
        StorageLocator {
            volume_id,
            logical_path: logical_path.to_owned(),
            version_id: None,
        }
    }

    async fn assert_fixture_protocol(fixture: &Fixture, protocol: RemoteProtocol, port: u16) {
        let volume = fixture_volume("", protocol);
        let config = RemoteConnectionConfig {
            protocol,
            host: fixture.host.clone(),
            port,
            share: String::new(),
            known_hosts: String::new(),
        };
        let credentials = RemoteCredentials {
            username: fixture.username.clone(),
            password: fixture.password.clone(),
            private_key: String::new(),
            passphrase: String::new(),
            domain: String::new(),
        };
        let backend = FtpBackend::new(&volume, &config, &credentials).unwrap();
        backend.test_connection().await.unwrap();

        let root = fixture_locator(volume.id, "");
        let entries = backend.list(&root).await.unwrap();
        assert!(entries.iter().any(|entry| entry.name == "seed.txt"));
        assert!(entries.iter().any(|entry| {
            entry.name == "outside-link" && entry.kind == StorageEntryKind::Symlink
        }));

        let mut reader = backend
            .open_read(&fixture_locator(volume.id, "seed.txt"))
            .await
            .unwrap();
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).await.unwrap();
        assert_eq!(bytes, b"Filo remote fixture\n");

        let link = fixture_locator(volume.id, "outside-link");
        assert_eq!(
            backend.stat(&link).await.unwrap_err().code,
            StorageErrorCode::AccessDenied
        );
        let read_error = match backend.open_read(&link).await {
            Ok(_) => panic!("FTP read must reject symlink"),
            Err(error) => error,
        };
        assert_eq!(read_error.code, StorageErrorCode::AccessDenied);
        let nested = fixture_locator(volume.id, "outside-link/secret.txt");
        assert_eq!(
            backend.list(&nested).await.unwrap_err().code,
            StorageErrorCode::AccessDenied
        );
        assert_eq!(
            backend.create_dir(&nested).await.unwrap_err().code,
            StorageErrorCode::AccessDenied
        );
        assert_eq!(
            backend.delete(&nested).await.unwrap_err().code,
            StorageErrorCode::AccessDenied
        );

        let symlink_root = fixture_volume("outside-link", protocol);
        let symlink_backend = FtpBackend::new(&symlink_root, &config, &credentials).unwrap();
        assert_eq!(
            symlink_backend.test_connection().await.unwrap_err().code,
            StorageErrorCode::AccessDenied
        );

        assert!(backend.capabilities().write);
        assert!(matches!(
            backend.capabilities().rename,
            RenameSemantics::Atomic
        ));
        let directory_name = format!("filo-ftp-{}", Uuid::new_v4());
        let directory = fixture_locator(volume.id, &directory_name);
        let payload = fixture_locator(volume.id, &format!("{directory_name}/payload.bin"));
        let keep = fixture_locator(volume.id, &format!("{directory_name}/keep.bin"));
        let renamed = fixture_locator(volume.id, &format!("{directory_name}/renamed.bin"));
        let payload_bytes = b"FTP staged fixture bytes\nwith a second line\n";
        let keep_bytes = b"keep this destination\n";
        let replaced_bytes = b"replaced FTP payload\n";
        backend.create_dir(&directory).await.unwrap();

        let mut staged = backend.stage_write(&payload).await.unwrap();
        staged.write(payload_bytes).await.unwrap();
        let mut staged_reader = staged.reader().await.unwrap();
        let mut staged_bytes = Vec::new();
        staged_reader.read_to_end(&mut staged_bytes).await.unwrap();
        assert_eq!(staged_bytes, payload_bytes);
        staged.commit().await.unwrap();
        let mut reader = backend.open_read(&payload).await.unwrap();
        let mut read_bytes = Vec::new();
        reader.read_to_end(&mut read_bytes).await.unwrap();
        assert_eq!(read_bytes, payload_bytes);

        let mut keep_staged = backend.stage_write(&keep).await.unwrap();
        keep_staged.write(keep_bytes).await.unwrap();
        keep_staged.commit().await.unwrap();
        let conflict = backend
            .rename(&payload, &keep)
            .await
            .expect_err("FTP rename must not replace an existing target");
        assert_eq!(conflict.code, StorageErrorCode::AlreadyExists);
        backend.rename(&payload, &renamed).await.unwrap();

        let expected = backend.stat(&keep).await.unwrap();
        let mut replaced = backend.stage_replace(&expected).await.unwrap();
        replaced.write(replaced_bytes).await.unwrap();
        drop(replaced.reader().await.unwrap());
        replaced.commit().await.unwrap();
        let mut replaced_reader = backend.open_read(&keep).await.unwrap();
        let mut replaced_read = Vec::new();
        replaced_reader
            .read_to_end(&mut replaced_read)
            .await
            .unwrap();
        assert_eq!(replaced_read, replaced_bytes);

        let stale = backend.stat(&keep).await.unwrap();
        let current = backend.stat(&keep).await.unwrap();
        let mut newer = backend.stage_replace(&current).await.unwrap();
        newer.write(b"newer FTP payload").await.unwrap();
        drop(newer.reader().await.unwrap());
        newer.commit().await.unwrap();
        let stale_error = match backend.stage_replace(&stale).await {
            Ok(_) => panic!("stale FTP replace must be rejected"),
            Err(error) => error,
        };
        assert_eq!(stale_error.code, StorageErrorCode::Conflict);

        backend.delete(&renamed).await.unwrap();
        backend.delete(&keep).await.unwrap();
        backend.delete(&directory).await.unwrap();

        let readonly_volume = StorageVolume {
            read_only: true,
            ..volume.clone()
        };
        let readonly = FtpBackend::new(&readonly_volume, &config, &credentials).unwrap();
        let blocked = fixture_locator(volume.id, &format!("{directory_name}-readonly"));
        assert_eq!(
            readonly.create_dir(&blocked).await.unwrap_err().code,
            StorageErrorCode::AccessDenied
        );
    }

    #[tokio::test]
    #[ignore = "requires FILO_TEST_REMOTE_FIXTURE and disposable FTP/FTPS services"]
    async fn ftp_fixture_operations_reject_symlink_escape() {
        let Some(fixture) = fixture() else {
            return;
        };
        // The disposable FTPS service uses a per-run CA. rustls-native-certs
        // intentionally honors this standard test-only trust override.
        std::env::set_var("SSL_CERT_FILE", &fixture.tls_ca);
        assert_fixture_protocol(&fixture, RemoteProtocol::Ftp, fixture.ftp_port).await;
        assert_fixture_protocol(&fixture, RemoteProtocol::Ftps, fixture.ftps_port).await;
    }
}
