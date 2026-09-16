use super::*;
#[test]
fn rejects_credential_urls_and_preserves_volume_boundaries() {
    let volume = StorageVolume {
        id: Uuid::new_v4(),
        connection_id: Uuid::new_v4(),
        name: "test".into(),
        root: VolumeRoot::S3 {
            bucket: "bucket".into(),
            prefix: "allowed".into(),
        },
        read_only: true,
    };
    let credentials = S3Credentials {
        access_key_id: "access".into(),
        secret_access_key: "secret".into(),
        session_token: None,
    };
    let mut config = S3ConnectionConfig {
        endpoint: Some("http://127.0.0.1:9000".into()),
        region: "us-east-1".into(),
        force_path_style: true,
    };
    let backend = OpenDalS3Backend::new(&volume, &config, &credentials).unwrap();
    let locator = StorageLocator {
        volume_id: volume.id,
        logical_path: "folder/file".into(),
        version_id: None,
    };
    assert_eq!(backend.path(&locator, false).unwrap(), "folder/file");
    assert!(backend.path(&locator, true).is_err());
    assert!(backend
        .path(
            &StorageLocator {
                volume_id: Uuid::new_v4(),
                ..locator.clone()
            },
            false
        )
        .is_err());
    assert!(backend
        .path(
            &StorageLocator {
                logical_path: "../escape".into(),
                ..locator.clone()
            },
            false
        )
        .is_err());
    assert!(backend
        .path(
            &StorageLocator {
                version_id: Some("version".into()),
                ..locator
            },
            false
        )
        .is_err());
    for endpoint in [
        "file:///tmp",
        "https://user:secret@example.com",
        "https://example.com/bucket",
        "https://example.com/?key=secret",
    ] {
        config.endpoint = Some(endpoint.into());
        assert!(OpenDalS3Backend::new(&volume, &config, &credentials).is_err());
    }
    assert!(
        !backend.capabilities().write
            && !backend.capabilities().trash
            && !backend.capabilities().native_open
    );
}
