//! FileZilla-style storage modes. Only explicit legacy import uses keyring.
use super::CredentialStore;
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{rand_core::RngCore, Aead, AeadCore, KeyInit, OsRng, Payload},
    XChaCha20Poly1305, XNonce,
};
use std::{collections::BTreeMap, fs::OpenOptions, io::Write, path::PathBuf, sync::Mutex};
use storage_domain::*;
use zeroize::Zeroizing;

type Credentials = BTreeMap<String, S3Credentials>;
type Key = Zeroizing<[u8; 32]>;

#[derive(Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialMode {
    #[default]
    Plain,
    Master,
    Memory,
}

#[derive(serde::Serialize)]
pub struct CredentialStatus {
    pub mode: CredentialMode,
    pub locked: bool,
    pub legacy_import_available: bool,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
enum Contents {
    Plain {
        data: String,
    },
    Master {
        salt: String,
        nonce: String,
        data: String,
    },
    Memory,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    version: u32,
    // Changes when the mode/password changes, invalidating other processes.
    generation: String,
    legacy_imported: bool,
    contents: Contents,
}
impl Document {
    fn mode(&self) -> CredentialMode {
        match self.contents {
            Contents::Plain { .. } => CredentialMode::Plain,
            Contents::Master { .. } => CredentialMode::Master,
            Contents::Memory => CredentialMode::Memory,
        }
    }
}

#[derive(Default)]
struct Session {
    generation: String,
    key: Option<Key>,
    credentials: Credentials,
}

pub struct FileCredentialStore {
    path: Option<PathBuf>,
    session: Mutex<Session>,
}

fn invalid(message: &str) -> StorageError {
    StorageError::new(StorageErrorCode::InvalidConfiguration, message)
}
fn io_error(_: impl std::fmt::Display) -> StorageError {
    StorageError::new(
        StorageErrorCode::Io,
        "无法读写本地凭据文件，请检查目录权限后重试",
    )
}
fn corrupt() -> StorageError {
    invalid("凭据文件损坏或版本不受支持，原文件未被覆盖。请恢复备份或重置凭据")
}
fn locked() -> StorageError {
    StorageError::new(
        StorageErrorCode::CredentialsLocked,
        "请先输入主密码解锁凭据",
    )
}
fn decode(value: &str) -> StorageResult<Vec<u8>> {
    STANDARD.decode(value).map_err(|_| corrupt())
}

fn derive(password: &str, salt: &[u8]) -> StorageResult<Key> {
    let mut key = Zeroizing::new([0; 32]);
    // Fixed for format v1: Argon2id v19, 19 MiB, two passes, one lane.
    let params = Params::new(19_456, 2, 1, Some(32)).map_err(|_| corrupt())?;
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, key.as_mut())
        .map_err(|_| invalid("无法派生主密码密钥，请稍后重试"))?;
    Ok(key)
}

impl FileCredentialStore {
    pub fn new(path: Option<PathBuf>) -> Self {
        Self {
            path,
            session: Mutex::new(Session::default()),
        }
    }

    fn lock(&self) -> StorageResult<std::fs::File> {
        let path = self.path.as_ref().ok_or_else(|| io_error("missing path"))?;
        let parent = path.parent().ok_or_else(|| io_error("missing parent"))?;
        std::fs::create_dir_all(parent).map_err(io_error)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options
            .open(path.with_extension("lock"))
            .map_err(io_error)?;
        lock.lock().map_err(io_error)?;
        Ok(lock)
    }

    // All reads and read-modify-writes share the same process and file locks.
    // Re-read the file each time: a second process can rotate its password.
    fn access<T>(
        &self,
        action: impl FnOnce(&mut Session, Document) -> StorageResult<T>,
    ) -> StorageResult<T> {
        let mut session = self.session.lock().map_err(io_error)?;
        let _lock = self.lock()?;
        let path = self.path.as_ref().ok_or_else(|| io_error("missing path"))?;
        let document = match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice::<Document>(&bytes).map_err(|_| corrupt())?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Document {
                version: 1,
                generation: String::new(),
                legacy_imported: false,
                contents: Contents::Plain {
                    data: STANDARD.encode(b"{}"),
                },
            },
            Err(e) => return Err(io_error(e)),
        };
        if document.version != 1 {
            return Err(corrupt());
        }
        if session.generation != document.generation {
            *session = Session {
                generation: document.generation.clone(),
                ..Session::default()
            };
        }
        action(&mut session, document)
    }

    fn status_for(session: &Session, document: &Document) -> CredentialStatus {
        CredentialStatus {
            mode: document.mode(),
            locked: document.mode() == CredentialMode::Master && session.key.is_none(),
            legacy_import_available: !document.legacy_imported,
        }
    }

    pub fn status(&self) -> StorageResult<CredentialStatus> {
        self.access(|session, document| {
            if document.mode() == CredentialMode::Plain {
                Self::credentials(session, &document)?;
            }
            Ok(Self::status_for(session, &document))
        })
    }

    fn credentials(session: &Session, document: &Document) -> StorageResult<Credentials> {
        let bytes = match &document.contents {
            Contents::Memory => return Ok(session.credentials.clone()),
            Contents::Plain { data } => Zeroizing::new(decode(data)?),
            Contents::Master { nonce, data, .. } => {
                let key = session.key.as_ref().ok_or_else(locked)?;
                let nonce: [u8; 24] = decode(nonce)?.try_into().map_err(|_| corrupt())?;
                let data = decode(data)?;
                Zeroizing::new(
                    XChaCha20Poly1305::new_from_slice(key.as_ref())
                        .map_err(|_| corrupt())?
                        .decrypt(
                            XNonce::from_slice(&nonce),
                            Payload {
                                msg: &data,
                                aad: document.generation.as_bytes(),
                            },
                        )
                        .map_err(|_| invalid("主密码不正确或凭据文件已损坏"))?,
                )
            }
        };
        serde_json::from_slice(&bytes).map_err(|_| corrupt())
    }

    fn encode(
        document: &mut Document,
        credentials: &Credentials,
        key: Option<&Key>,
    ) -> StorageResult<()> {
        let bytes = Zeroizing::new(serde_json::to_vec(credentials).map_err(|_| corrupt())?);
        match &mut document.contents {
            Contents::Plain { data } => *data = STANDARD.encode(&bytes),
            Contents::Master { nonce, data, .. } => {
                let key = key.ok_or_else(locked)?;
                let fresh_nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
                let encrypted = XChaCha20Poly1305::new_from_slice(key.as_ref())
                    .map_err(|_| corrupt())?
                    .encrypt(
                        &fresh_nonce,
                        Payload {
                            msg: &bytes,
                            aad: document.generation.as_bytes(),
                        },
                    )
                    .map_err(|_| invalid("凭据加密失败"))?;
                *nonce = STANDARD.encode(fresh_nonce);
                *data = STANDARD.encode(encrypted);
            }
            Contents::Memory => {}
        }
        Ok(())
    }

    fn write(&self, document: &Document) -> StorageResult<()> {
        let path = self.path.as_ref().ok_or_else(|| io_error("missing path"))?;
        let parent = path.parent().ok_or_else(|| io_error("missing parent"))?;
        // NamedTempFile is 0600 on Unix. Persist replaces atomically; no backup
        // containing ordinary credentials survives switching to master/memory.
        let mut file = tempfile::NamedTempFile::new_in(parent).map_err(io_error)?;
        serde_json::to_writer(&mut file, document).map_err(io_error)?;
        file.flush().map_err(io_error)?;
        file.as_file().sync_all().map_err(io_error)?;
        file.persist(path).map_err(io_error)?;
        Ok(())
    }

    fn password_session(document: &Document, password: &str) -> StorageResult<Session> {
        let Contents::Master { salt, .. } = &document.contents else {
            return Err(invalid("当前未启用主密码"));
        };
        let salt: [u8; 16] = decode(salt)?.try_into().map_err(|_| corrupt())?;
        let session = Session {
            generation: document.generation.clone(),
            key: Some(derive(password, &salt)?),
            ..Session::default()
        };
        Self::credentials(&session, document)?;
        Ok(session)
    }

    pub fn unlock(&self, password: &str) -> StorageResult<CredentialStatus> {
        self.access(|session, document| {
            *session = Self::password_session(&document, password)?;
            Ok(Self::status_for(session, &document))
        })
    }

    pub fn configure(
        &self,
        mode: CredentialMode,
        password: Option<&str>,
        current_password: Option<&str>,
    ) -> StorageResult<CredentialStatus> {
        self.access(|session, mut document| {
            let verified;
            let source = if document.mode() == CredentialMode::Master {
                verified = Self::password_session(
                    &document,
                    current_password.ok_or_else(|| invalid("请输入当前主密码"))?,
                )?;
                &verified
            } else {
                &*session
            };
            let credentials = Self::credentials(source, &document)?;
            let key = if mode == CredentialMode::Master {
                let password = password
                    .filter(|p| p.chars().count() >= 8)
                    .ok_or_else(|| invalid("主密码至少需要 8 个字符"))?;
                let mut salt = [0; 16];
                OsRng.fill_bytes(&mut salt);
                document.contents = Contents::Master {
                    salt: STANDARD.encode(salt),
                    nonce: String::new(),
                    data: String::new(),
                };
                Some(derive(password, &salt)?)
            } else {
                document.contents = if mode == CredentialMode::Memory {
                    Contents::Memory
                } else {
                    Contents::Plain {
                        data: String::new(),
                    }
                };
                None
            };
            document.generation = uuid::Uuid::new_v4().to_string();
            Self::encode(&mut document, &credentials, key.as_ref())?;
            self.write(&document)?;
            *session = Session {
                generation: document.generation.clone(),
                key,
                credentials: if mode == CredentialMode::Memory {
                    credentials
                } else {
                    Credentials::new()
                },
            };
            Ok(Self::status_for(session, &document))
        })
    }

    pub fn reset(&self, confirmed: bool) -> StorageResult<CredentialStatus> {
        if !confirmed {
            return Err(invalid("请确认清除已保存的凭据"));
        }
        // Reset deliberately also works on corrupt files. It never edits connections.
        let mut session = self.session.lock().map_err(io_error)?;
        let _lock = self.lock()?;
        let document = Document {
            version: 1,
            generation: uuid::Uuid::new_v4().to_string(),
            legacy_imported: false,
            contents: Contents::Plain {
                data: STANDARD.encode(b"{}"),
            },
        };
        self.write(&document)?;
        *session = Session {
            generation: document.generation.clone(),
            ..Session::default()
        };
        Ok(Self::status_for(&session, &document))
    }

    pub fn import_legacy(&self, references: &[String]) -> StorageResult<usize> {
        // Caller explicitly requests this operation; startup and normal reads
        // never access keyring. Keep original entries as a migration backup.
        self.import_from(|| super::legacy::read(references))
    }

    fn import_from(
        &self,
        read: impl FnOnce() -> StorageResult<Credentials>,
    ) -> StorageResult<usize> {
        self.access(|session, mut document| {
            let mut credentials = Self::credentials(session, &document)?;
            let imported = read()?;
            if imported.is_empty() {
                return Err(invalid("未找到可导入的旧凭据，请重新输入连接密码"));
            }
            let before = credentials.len();
            for (reference, value) in imported {
                credentials.entry(reference).or_insert(value);
            }
            let count = credentials.len() - before;
            document.legacy_imported = document.mode() != CredentialMode::Memory;
            Self::encode(&mut document, &credentials, session.key.as_ref())?;
            self.write(&document)?;
            if document.mode() == CredentialMode::Memory {
                session.credentials = credentials;
            }
            Ok(count)
        })
    }
}

impl CredentialStore for FileCredentialStore {
    fn get(&self, reference: &str) -> StorageResult<S3Credentials> {
        self.access(|session, document| {
            Self::credentials(session, &document)?
                .get(reference)
                .cloned()
                .ok_or_else(|| {
                    let mut error = StorageError::new(
                        StorageErrorCode::CredentialsRequired,
                        "请重新输入此连接的凭据",
                    );
                    error.credential_ref = Some(reference.into());
                    error
                })
        })
    }
    fn set(&self, reference: &str, value: &S3Credentials) -> StorageResult<()> {
        self.access(|session, mut document| {
            let mut credentials = Self::credentials(session, &document)?;
            credentials.insert(reference.into(), value.clone());
            Self::encode(&mut document, &credentials, session.key.as_ref())?;
            self.write(&document)?;
            if document.mode() == CredentialMode::Memory {
                session.credentials = credentials;
            }
            Ok(())
        })
    }
    fn delete(&self, reference: &str) -> StorageResult<()> {
        self.access(|session, mut document| {
            let mut credentials = Self::credentials(session, &document)?;
            if credentials.remove(reference).is_none() {
                return Ok(());
            }
            Self::encode(&mut document, &credentials, session.key.as_ref())?;
            self.write(&document)?;
            if document.mode() == CredentialMode::Memory {
                session.credentials = credentials;
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests;
