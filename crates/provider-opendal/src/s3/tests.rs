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
        provider: None,
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

// A local S3 protocol fixture counts full object reads and can corrupt the
// published object. No real bucket or credentials are used.
struct TestS3 {
    endpoint: String,
    reads: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    stopped: std::sync::Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl TestS3 {
    fn new(corrupt: bool, corrupt_upload: bool) -> Self {
        use md5::{Digest, Md5};
        use std::io::{BufRead, Read, Write};
        use std::sync::{atomic::Ordering, Arc, Mutex};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let reads = Arc::new(Mutex::new(Vec::new()));
        let requests = reads.clone();
        let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop = stopped.clone();
        let thread = std::thread::spawn(move || {
            let mut objects = std::collections::HashMap::<String, Vec<u8>>::new();
            let mut etags = std::collections::HashMap::<String, String>::new();
            let mut upload_parts = std::collections::BTreeMap::<usize, Vec<u8>>::new();
            while !stop.load(Ordering::Relaxed) {
                let (mut stream, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                        continue;
                    }
                    Err(error) => panic!("{error}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                    .unwrap();
                let mut input = std::io::BufReader::new(&mut stream);
                let mut first = String::new();
                input.read_line(&mut first).unwrap();
                let parts: Vec<_> = first.split_whitespace().collect();
                if parts.len() < 2 {
                    continue;
                }
                let (method, uri) = (parts[0], parts[1]);
                let (path, query) = uri.split_once('?').unwrap_or((uri, ""));
                let params: std::collections::HashMap<_, _> =
                    url::form_urlencoded::parse(query.as_bytes())
                        .into_owned()
                        .collect();
                let mut headers = std::collections::HashMap::new();
                loop {
                    let mut line = String::new();
                    input.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    if let Some((key, value)) = line.split_once(':') {
                        headers.insert(key.to_lowercase(), value.trim().to_owned());
                    }
                }
                let length = headers
                    .get("content-length")
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
                let mut body = vec![0; length];
                input.read_exact(&mut body).unwrap();
                drop(input);
                let mut status = "200 OK";
                let mut response_etag = None;
                let result = match method {
                    "POST" if params.contains_key("uploads") => {
                        upload_parts.clear();
                        b"<InitiateMultipartUploadResult><UploadId>test-upload</UploadId></InitiateMultipartUploadResult>".to_vec()
                    }
                    "POST" if params.contains_key("uploadId") => {
                        let mut combined = Md5::new();
                        let mut bytes = Vec::new();
                        for part in upload_parts.values() {
                            combined.update(Md5::digest(part));
                            bytes.extend_from_slice(part);
                        }
                        let etag = format!("{:x}-{}", combined.finalize(), upload_parts.len());
                        objects.insert(path.into(), bytes);
                        etags.insert(path.into(), etag.clone());
                        format!("<CompleteMultipartUploadResult><ETag>\"{etag}\"</ETag></CompleteMultipartUploadResult>").into_bytes()
                    }
                    "PUT" if params.contains_key("partNumber") => {
                        let etag = format!("{:x}", Md5::digest(&body));
                        upload_parts.insert(params["partNumber"].parse().unwrap(), body);
                        response_etag = Some(etag);
                        Vec::new()
                    }
                    "PUT" => {
                        if let Some(source) = headers.get("x-amz-copy-source") {
                            let source = format!("/{}", source.trim_start_matches('/'));
                            let mut bytes = objects[&source].clone();
                            if corrupt && !bytes.is_empty() {
                                bytes[0] ^= 1;
                            }
                            let etag = format!("{:x}", Md5::digest(&bytes));
                            etags.insert(path.into(), etag.clone());
                            objects.insert(path.into(), bytes);
                            format!("<CopyObjectResult><ETag>\"{etag}\"</ETag><LastModified>2026-09-16T00:00:00Z</LastModified></CopyObjectResult>").into_bytes()
                        } else {
                            if corrupt_upload
                                && path.contains(".filo-transfer-")
                                && !body.is_empty()
                            {
                                body[0] ^= 1;
                            }
                            etags.insert(path.into(), format!("{:x}", Md5::digest(&body)));
                            objects.insert(path.into(), body);
                            Vec::new()
                        }
                    }
                    "HEAD" | "GET" => match objects.get(path) {
                        Some(bytes) => {
                            if method == "GET" {
                                requests.lock().unwrap().push(path.into());
                            }
                            bytes.clone()
                        }
                        None => {
                            status = "404 Not Found";
                            Vec::new()
                        }
                    },
                    "DELETE" => {
                        objects.remove(path);
                        Vec::new()
                    }
                    _ => panic!("unexpected S3 method {method}"),
                };
                let etag = response_etag
                    .or_else(|| etags.get(path).cloned())
                    .unwrap_or_default();
                write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nETag: \"{etag}\"\r\nConnection: close\r\n\r\n", result.len()).unwrap();
                if method != "HEAD" {
                    stream.write_all(&result).unwrap();
                }
            }
        });
        Self {
            endpoint,
            reads,
            stopped,
            thread: Some(thread),
        }
    }
}
impl Drop for TestS3 {
    fn drop(&mut self) {
        self.stopped
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = self.thread.take().unwrap().join();
    }
}

#[tokio::test]
async fn s3_commit_verifies_provider_hash_without_download_and_rejects_corruption() {
    for (corrupt, overwrite, large) in [
        (false, false, false),
        (true, false, false),
        (false, true, false),
        (false, false, true),
    ] {
        let server = TestS3::new(corrupt, overwrite);
        let volume = StorageVolume {
            id: Uuid::new_v4(),
            connection_id: Uuid::new_v4(),
            name: "fixture".into(),
            root: VolumeRoot::S3 {
                bucket: "bucket".into(),
                prefix: String::new(),
            },
            read_only: false,
        };
        let backend = OpenDalS3Backend::new(
            &volume,
            &S3ConnectionConfig {
                provider: None,
                endpoint: Some(server.endpoint.clone()),
                region: "us-east-1".into(),
                force_path_style: true,
            },
            &S3Credentials {
                access_key_id: "test".into(),
                secret_access_key: "test".into(),
                session_token: None,
            },
        )
        .unwrap();
        let locator = StorageLocator {
            volume_id: volume.id,
            logical_path: "target.bin".into(),
            version_id: None,
        };
        let mut writer = if overwrite {
            backend
                .operator
                .write("target.bin", "original")
                .await
                .unwrap();
            let expected = backend.stat(&locator).await.unwrap();
            backend.stage_replace(&expected).await.unwrap()
        } else {
            backend.stage_write(&locator).await.unwrap()
        };
        assert!(writer.verifies_on_commit());
        if large {
            let bytes = vec![42; 9 * 1024 * 1024 + 17];
            for chunk in bytes.chunks(256 * 1024) {
                writer.write(chunk).await.unwrap();
            }
        } else {
            writer.write(b"first chunk").await.unwrap();
            writer.write(b" and second chunk").await.unwrap();
        }
        let result = writer.commit().await;
        if corrupt || overwrite {
            assert_eq!(result.unwrap_err().code, StorageErrorCode::Io);
        } else {
            result.unwrap();
        }
        assert!(
            server.reads.lock().unwrap().is_empty(),
            "verification must use HEAD, never GET"
        );
        if overwrite {
            assert_eq!(
                backend.operator.read("target.bin").await.unwrap().to_vec(),
                b"original"
            );
        }
    }
}
