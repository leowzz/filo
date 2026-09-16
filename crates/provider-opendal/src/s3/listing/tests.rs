use super::*;
use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn fixture(
    root: &str,
    expected_prefix: &str,
    pages: Vec<String>,
) -> (
    OpenDalS3Backend,
    StorageLocator,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let expected_prefix = expected_prefix.to_owned();
    let server = tokio::spawn(async move {
        for (index, body) in pages.into_iter().enumerate() {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let read = socket.read(&mut buffer).await.unwrap();
                assert!(read > 0);
                request.extend_from_slice(&buffer[..read]);
            }
            let request = String::from_utf8(request).unwrap();
            let target = request
                .lines()
                .next()
                .unwrap()
                .split_whitespace()
                .nth(1)
                .unwrap();
            let url = url::Url::parse(&format!("http://localhost{target}")).unwrap();
            let query: HashMap<_, _> = url.query_pairs().into_owned().collect();
            assert_eq!(url.path().trim_end_matches('/'), "/bucket");
            assert_eq!(
                query.get("prefix").map(String::as_str).unwrap_or(""),
                expected_prefix
            );
            assert_eq!(query.get("delimiter").map(String::as_str), Some("/"));
            assert_eq!(query.get("max-keys").map(String::as_str), Some("500"));
            assert_eq!(query.get("list-type").map(String::as_str), Some("2"));
            if index > 0 {
                assert_eq!(
                    query.get("continuation-token").map(String::as_str),
                    Some("next")
                );
            }
            let body = format!("<ListBucketResult>{body}</ListBucketResult>");
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        }
    });
    let volume = StorageVolume {
        id: Uuid::new_v4(),
        connection_id: Uuid::new_v4(),
        name: "fixture".into(),
        root: VolumeRoot::S3 {
            bucket: "bucket".into(),
            prefix: root.into(),
        },
        read_only: false,
    };
    let backend = OpenDalS3Backend::new(
        &volume,
        &S3ConnectionConfig {
            provider: None,
            endpoint: Some(endpoint),
            region: "us-east-1".into(),
            force_path_style: true,
        },
        &S3Credentials {
            access_key_id: "fixture".into(),
            secret_access_key: "fixture".into(),
            session_token: None,
        },
    )
    .unwrap();
    let parent = StorageLocator {
        volume_id: volume.id,
        logical_path: String::new(),
        version_id: None,
    };
    (backend, parent, server)
}

fn object(key: &str) -> String {
    format!("<Contents><Key>{key}</Key><Size>7</Size><ETag>etag</ETag><LastModified>2026-09-16T00:00:00Z</LastModified></Contents>")
}

#[tokio::test]
async fn root_keys_do_not_panic_or_hide_later_pages() {
    let pages = vec![
        format!("<IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken><CommonPrefixes><Prefix>/</Prefix></CommonPrefixes>{}", object("/")),
        format!("<IsTruncated>false</IsTruncated><CommonPrefixes><Prefix>folder/</Prefix></CommonPrefixes>{}{}{}", object("!first"), object(".hidden"), object("中文%2F.txt")),
    ];
    let (backend, parent, server) = fixture("", "", pages).await;
    let mut reader = backend.open_listing(&parent).await.unwrap();
    let mut entries = Vec::new();
    loop {
        let batch = reader.next_batch(1).await.unwrap();
        if batch.is_empty() {
            break;
        }
        assert_eq!(batch.len(), 1);
        entries.extend(batch);
    }
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        ["folder", "!first", ".hidden", "中文%2F.txt"]
    );
    assert_eq!(entries[0].kind, StorageEntryKind::VirtualPrefix);
    assert_eq!(entries[1].size, Some(7));
    assert_eq!(entries[1].etag.as_deref(), Some("etag"));
    server.await.unwrap();
}

#[tokio::test]
async fn scoped_listing_preserves_exact_keys_and_skips_only_unsupported_names() {
    let body = format!(
        "<IsTruncated>false</IsTruncated>{}{}{}{}{}{}{}<CommonPrefixes><Prefix>allowed/folder/sub/</Prefix></CommonPrefixes>",
        object("allowed/folder/"), // The directory's own marker is not a child.
        object("allowed/folder/a&amp;b%2F.txt"),
        object("allowed/folder/.hidden"),
        object("/allowed/folder/alias"),
        object("allowed/folder//alias"),
        object("allowed/folder/../escape"),
        object("allowed-other/escape"),
    );
    for streaming in [false, true] {
        let (backend, mut parent, server) =
            fixture("allowed", "allowed/folder/", vec![body.clone()]).await;
        parent.logical_path = "folder".into();
        let entries = if streaming {
            backend
                .open_listing(&parent)
                .await
                .unwrap()
                .next_batch(500)
                .await
                .unwrap()
        } else {
            backend.list(&parent).await.unwrap()
        };
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.locator.logical_path.as_str())
                .collect::<Vec<_>>(),
            ["folder/sub", "folder/a&b%2F.txt", "folder/.hidden"]
        );
        assert_eq!(
            entries[1].modified_at.as_deref(),
            Some("2026-09-16T00:00:00Z")
        );
        server.await.unwrap();
    }
}

#[tokio::test]
async fn mutation_listing_rejects_unsupported_keys_and_file_directory_collisions() {
    for body in [
        format!("<IsTruncated>false</IsTruncated>{}", object("/")),
        "<IsTruncated>false</IsTruncated><CommonPrefixes><Prefix>/</Prefix></CommonPrefixes>".into(),
        format!("<IsTruncated>false</IsTruncated>{}", object("../escape")),
        format!("<IsTruncated>false</IsTruncated><CommonPrefixes><Prefix>same/</Prefix></CommonPrefixes>{}", object("same")),
    ] {
        let (backend, parent, server) = fixture("", "", vec![body]).await;
        let error = backend.list_for_mutation(&parent).await.unwrap_err();
        assert_eq!(error.code, StorageErrorCode::Unsupported);
        server.await.unwrap();
    }
    let (backend, parent, server) = fixture(
        "allowed",
        "allowed/",
        vec![format!(
            "<IsTruncated>false</IsTruncated>{}{}",
            object("allowed/"),
            object("allowed/normal.txt")
        )],
    )
    .await;
    let entries = backend.list_for_mutation(&parent).await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].locator.logical_path, "normal.txt");
    server.await.unwrap();
}

#[tokio::test]
async fn invalid_pagination_fails_instead_of_repeating_forever() {
    for pages in [
        vec!["<IsTruncated>true</IsTruncated>".into()],
        vec![
            "<IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken>"
                .into(),
            "<IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken>"
                .into(),
        ],
    ] {
        let (backend, parent, server) = fixture("", "", pages).await;
        let error = backend
            .open_listing(&parent)
            .await
            .unwrap()
            .next_batch(500)
            .await
            .unwrap_err();
        assert_eq!(error.code, StorageErrorCode::Network);
        server.await.unwrap();
    }
}
