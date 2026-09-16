use crate::StorageService;
use provider_opendal::RemoteBackend;
use storage_domain::*;
use uuid::Uuid;

fn configuration(message: &str) -> StorageError {
    StorageError::new(StorageErrorCode::InvalidConfiguration, message)
}

fn validate_remote_name(name: &str) -> StorageResult<&str> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 || name.chars().any(char::is_control) {
        return Err(configuration("连接名称须为 1–100 个字符，不能包含控制字符"));
    }
    Ok(name)
}

fn normalize_remote_root(path: &str, protocol: RemoteProtocol) -> StorageResult<String> {
    if path.contains(['\\', '\0']) || path.chars().any(char::is_control) {
        return Err(StorageError::new(
            StorageErrorCode::InvalidPath,
            "远程目录包含无效字符",
        ));
    }
    if matches!(protocol, RemoteProtocol::Smb) {
        return normalize_path(path);
    }
    let absolute = path.starts_with('/');
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                return Err(StorageError::new(
                    StorageErrorCode::InvalidPath,
                    "远程目录不能访问上级路径",
                ));
            }
            value => parts.push(value),
        }
    }
    let normalized = parts.join("/");
    if absolute {
        Ok(if normalized.is_empty() {
            "/".into()
        } else {
            format!("/{normalized}")
        })
    } else {
        Ok(normalized)
    }
}

fn validate_host(host: &str) -> StorageResult<&str> {
    let host = host.trim();
    if host.is_empty() || host.chars().any(char::is_whitespace) || host.contains(['/', '\\', '@']) {
        return Err(configuration("远程主机地址无效"));
    }
    Ok(host)
}

impl StorageService {
    async fn prepare_remote(
        &self,
        id: Option<Uuid>,
        input: &RemoteStorageInput,
    ) -> StorageResult<(StorageVolume, RemoteConnectionConfig, RemoteCredentials)> {
        let name = validate_remote_name(&input.name)?;
        let host = validate_host(&input.host)?;
        if input.port == 0 {
            return Err(configuration("远程端口必须是 1–65535"));
        }
        if matches!(input.protocol, RemoteProtocol::Smb) && input.share.trim().is_empty() {
            return Err(configuration("SMB 连接必须填写共享名称"));
        }
        let root = normalize_remote_root(input.path.trim(), input.protocol)?;
        let config = RemoteConnectionConfig {
            protocol: input.protocol,
            host: host.to_owned(),
            port: input.port,
            share: input.share.trim().to_owned(),
            known_hosts: input.known_hosts.trim().to_owned(),
        };

        let mut volume = if let Some(id) = id {
            let volume = self
                .repository
                .list_volumes()
                .await?
                .into_iter()
                .find(|volume| volume.id == id)
                .ok_or_else(|| configuration("未找到远程存储位置"))?;
            if !matches!(&volume.root, VolumeRoot::Remote { .. }) {
                return Err(configuration("未找到远程存储位置"));
            }
            volume
        } else {
            StorageVolume {
                id: Uuid::new_v4(),
                connection_id: Uuid::new_v4(),
                name: String::new(),
                root: VolumeRoot::Remote {
                    path: String::new(),
                },
                read_only: false,
            }
        };

        let credentials = if let Some(credentials) = &input.credentials {
            credentials.clone()
        } else if id.is_some() {
            let connection = self.connection(volume.connection_id).await?;
            if connection.provider != ProviderKind::Remote {
                return Err(configuration("远程位置缺少匹配的连接配置"));
            }
            let reference = connection
                .credential_ref
                .ok_or_else(|| configuration("缺少远程凭据引用，请编辑连接重新保存"))?;
            if !crate::credentials::is_remote_reference(&reference) {
                return Err(configuration("远程凭据引用格式无效，请编辑连接重新保存"));
            }
            let packed = self.load_credentials(Some(reference)).await?;
            crate::credentials::unpack_remote_credentials(&packed)?
        } else {
            return Err(configuration("请填写远程连接凭据"));
        };

        volume.name = name.to_owned();
        volume.read_only = input.read_only;
        volume.root = VolumeRoot::Remote { path: root };
        Ok((volume, config, credentials))
    }

    pub async fn test_remote_connection(
        &self,
        id: Option<Uuid>,
        input: RemoteStorageInput,
    ) -> StorageResult<()> {
        let (volume, config, credentials) = self.prepare_remote(id, &input).await?;
        let backend = RemoteBackend::new(&volume, &config, &credentials).await?;
        backend.test_connection().await
    }

    pub async fn save_remote_storage(
        &self,
        id: Option<Uuid>,
        input: RemoteStorageInput,
    ) -> StorageResult<StorageVolume> {
        if let Some(id) = id {
            drop(self.idle_volume(id).await?);
        }
        let _guard = self.mutation_lock.write().await;
        let _transfers = if let Some(id) = id {
            Some(self.idle_volume(id).await?)
        } else {
            None
        };

        let (volume, config, credentials) = self.prepare_remote(id, &input).await?;
        let backend = RemoteBackend::new(&volume, &config, &credentials).await?;
        backend.test_connection().await?;

        let old_reference = if id.is_some() {
            self.connection(volume.connection_id).await?.credential_ref
        } else {
            None
        };
        let reference = crate::credentials::remote_reference(Uuid::new_v4());
        let packed = crate::credentials::pack_remote_credentials(&credentials)?;
        if let Err(error) = self.store_credentials(reference.clone(), packed).await {
            let _ = self.delete_credentials(reference).await;
            return Err(error);
        }
        let connection = StorageConnection {
            id: volume.connection_id,
            name: volume.name.clone(),
            provider: ProviderKind::Remote,
            config: serde_json::to_value(&config).map_err(|_| configuration("配置序列化失败"))?,
            credential_ref: Some(reference.clone()),
            enabled: true,
        };
        if let Err(error) = self.repository.save_remote(&connection, &volume).await {
            let _ = self.delete_credentials(reference).await;
            return Err(error);
        }
        if let Some(old) = old_reference {
            let _ = self.delete_credentials(old).await;
        }
        Ok(volume)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_root_preserves_ftp_absolute_paths_and_rejects_escape() {
        assert_eq!(
            normalize_remote_root("/srv/./data//", RemoteProtocol::Ftp).unwrap(),
            "/srv/data"
        );
        assert_eq!(
            normalize_remote_root("./folder", RemoteProtocol::Sftp).unwrap(),
            "folder"
        );
        assert!(normalize_remote_root("../outside", RemoteProtocol::Sftp).is_err());
        assert!(normalize_remote_root("/share", RemoteProtocol::Smb).is_err());
    }

    #[test]
    fn remote_host_validation_does_not_accept_embedded_authority() {
        assert!(validate_host("127.0.0.1").is_ok());
        assert!(validate_host("[::1]").is_ok());
        assert!(validate_host("user@host").is_err());
        assert!(validate_host("host/path").is_err());
    }
}
