use std::collections::BTreeMap;
use storage_domain::*;

fn error() -> StorageError {
    StorageError::new(
        StorageErrorCode::AccessDenied,
        "无法读取旧系统凭据，请授权后重试，或重新输入连接密码",
    )
}

pub(super) fn read(references: &[String]) -> StorageResult<BTreeMap<String, S3Credentials>> {
    let mut credentials = BTreeMap::new();
    #[cfg(target_os = "macos")]
    {
        #[derive(serde::Deserialize)]
        struct LegacyVault {
            credentials: BTreeMap<String, S3Credentials>,
        }
        let entry = keyring::Entry::new("dev.filo.desktop.s3", "vault-v1").map_err(|_| error())?;
        match entry.get_password() {
            Ok(value) => {
                let vault: LegacyVault = serde_json::from_str(&value).map_err(|_| error())?;
                for reference in references {
                    if let Some(value) = vault.credentials.get(reference) {
                        credentials.insert(reference.clone(), value.clone());
                    }
                }
            }
            Err(keyring::Error::NoEntry) => {}
            Err(_) => return Err(error()),
        }
    }
    #[cfg(not(target_os = "macos"))]
    for reference in references {
        let entry = keyring::Entry::new("dev.filo.desktop.s3", reference).map_err(|_| error())?;
        match entry.get_password() {
            Ok(value) => {
                credentials.insert(
                    reference.clone(),
                    serde_json::from_str(&value).map_err(|_| error())?,
                );
            }
            Err(keyring::Error::NoEntry) => {}
            Err(_) => return Err(error()),
        }
    }
    Ok(credentials)
}
