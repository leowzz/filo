//! SSH host-key probing and trust classification for SFTP connections.
//!
//! Host-key inspection deliberately stops after the unauthenticated SSH key
//! exchange.  It never sends a username, password, private key, or other
//! authentication request.  The desktop command supplies the contents of the
//! user's `~/.ssh/known_hosts` file; keeping the filesystem access at that
//! boundary lets the command use Tauri's platform-aware home directory.

use data_encoding::BASE64_MIME;
use hmac::{Hmac, Mac};
use russh::{
    client,
    keys::{self, ssh_key::known_hosts::KnownHosts, HashAlg, PublicKey, PublicKeyOrCertificate},
    Preferred,
};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use std::{
    borrow::Cow,
    sync::{Arc, Mutex},
    time::Duration,
};
use storage_domain::{StorageError, StorageErrorCode, StorageResult};

const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// The result of comparing the current server key with a saved or local pin.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SftpHostKeyStatus {
    Trusted,
    Unknown,
    Changed,
}

/// Details returned by the SFTP host-key inspection command.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct SftpHostKeyInspection {
    pub status: SftpHostKeyStatus,
    pub known_hosts: String,
    pub fingerprint: String,
    pub algorithm: String,
}

#[derive(Clone)]
struct KnownHostRecord {
    patterns: String,
    key: PublicKey,
    marker: Option<keys::ssh_key::known_hosts::Marker>,
}

struct ProbeHandler {
    captured: Arc<Mutex<Option<PublicKey>>>,
}

impl client::Handler for ProbeHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key = server_public_key.public_key();
        let Ok(mut captured) = self.captured.lock() else {
            return Err(russh::Error::Disconnect);
        };
        *captured = Some(key);
        // The purpose of this connection is to inspect the key.  The caller
        // classifies it after the exchange, so the handler accepts it here and
        // never proceeds to authentication.
        Ok(true)
    }
}

fn invalid(message: impl Into<String>) -> StorageError {
    StorageError::new(StorageErrorCode::InvalidConfiguration, message)
}

fn probe_error(error: russh::Error) -> StorageError {
    let (code, retryable, message) = match error {
        russh::Error::ConnectionTimeout | russh::Error::KeepaliveTimeout => (
            StorageErrorCode::Timeout,
            true,
            "读取 SFTP 服务器主机密钥超时，请检查网络和服务状态",
        ),
        russh::Error::IO(_) | russh::Error::Disconnect | russh::Error::HUP => (
            StorageErrorCode::Network,
            true,
            "读取 SFTP 服务器主机密钥失败，请检查网络和服务状态",
        ),
        _ => (
            StorageErrorCode::Network,
            true,
            "读取 SFTP 服务器主机密钥失败，请检查网络和服务状态",
        ),
    };
    let mut result = StorageError::new(code, message);
    result.retryable = retryable;
    result
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
        || host.contains(['/', '\\', '\0', '[', ']', '@'])
    {
        return Err(invalid("请填写不含端口的 SFTP 服务器地址"));
    }
    if port == 0 {
        return Err(invalid("SFTP 端口必须在 1 到 65535 之间"));
    }
    if host.matches(':').count() == 1 {
        return Err(invalid("服务器地址和端口需分别填写"));
    }
    if host.matches(':').count() > 1 && host.parse::<std::net::IpAddr>().is_err() {
        return Err(invalid("IPv6 SFTP 服务器地址格式无效"));
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

fn parse_known_hosts(text: &str) -> StorageResult<Vec<KnownHostRecord>> {
    // `ssh-key` deliberately parses the canonical space-separated format but
    // does not consume leading whitespace or tabs.  OpenSSH accepts both, so
    // normalize separators at this boundary while leaving key material and
    // marker semantics to the mature parser.
    let normalized = text
        .lines()
        .filter_map(|line| {
            let line = line.split_once('#').map_or(line, |(line, _)| line);
            let fields: Vec<&str> = line.split_whitespace().collect();
            (!fields.is_empty()).then(|| fields.join(" "))
        })
        .collect::<Vec<_>>()
        .join("\n");
    KnownHosts::new(&normalized)
        .map(|entry| {
            entry
                .map(|entry| KnownHostRecord {
                    patterns: entry.host_patterns().to_string(),
                    key: entry.public_key().clone(),
                    marker: entry.marker().copied(),
                })
                .map_err(|_| invalid("SSH known_hosts 文件格式无效"))
        })
        .collect()
}

fn decode_hashed_pattern(pattern: &str) -> Option<(Vec<u8>, Vec<u8>)> {
    let encoded = pattern.strip_prefix("|1|")?;
    let (salt, hash) = encoded.split_once('|')?;
    let salt = BASE64_MIME.decode(salt.as_bytes()).ok()?;
    let hash = BASE64_MIME.decode(hash.as_bytes()).ok()?;
    // OpenSSH's |1| format uses HMAC-SHA1, whose output is exactly 20 bytes.
    (hash.len() == 20).then_some((salt, hash))
}

fn hashed_pattern_matches(pattern: &str, host: &str) -> bool {
    let Some((salt, expected)) = decode_hashed_pattern(pattern) else {
        return false;
    };
    let Ok(mut mac) = Hmac::<Sha1>::new_from_slice(&salt) else {
        return false;
    };
    mac.update(host.as_bytes());
    mac.verify_slice(&expected).is_ok()
}

/// Match the small host-pattern language used by OpenSSH known_hosts.
///
/// `ssh-key` owns parsing and validation of the file.  It intentionally leaves
/// matching to callers, so this function handles exact, wildcard, negated, and
/// hashed host patterns while preserving OpenSSH's negation rule.
fn wildcard_matches(pattern: &str, value: &str) -> bool {
    let pattern = pattern.as_bytes();
    let value = value.as_bytes();
    let mut p = 0;
    let mut v = 0;
    let mut star = None;
    let mut star_value = 0;

    while v < value.len() {
        if p < pattern.len() && (pattern[p] == value[v] || pattern[p] == b'?') {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            star_value = v;
        } else if let Some(star_position) = star {
            p = star_position + 1;
            star_value += 1;
            v = star_value;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

fn host_pattern_matches(patterns: &str, host: &str) -> bool {
    if patterns.starts_with("|1|") {
        return hashed_pattern_matches(patterns, host);
    }

    let mut positive_match = false;
    for entry in patterns.split(',') {
        if let Some(negated) = entry.strip_prefix('!') {
            if wildcard_matches(negated, host) {
                return false;
            }
        } else if wildcard_matches(entry, host) {
            positive_match = true;
        }
    }
    positive_match
}

fn same_key(left: &PublicKey, right: &PublicKey) -> bool {
    // Comments are presentation metadata and are not part of host-key
    // identity.  Comparing KeyData also avoids treating a saved comment as a
    // key change.
    left.key_data() == right.key_data()
}

fn classify(
    host: &str,
    port: u16,
    saved_pin: &str,
    local_records: &[KnownHostRecord],
    current_key: &PublicKey,
) -> SftpHostKeyStatus {
    let expected_host = host_pattern(host, port);

    if !saved_pin.trim().is_empty() {
        // The saved value is the connection pin.  A malformed pin, a
        // wildcard, or a different key is a changed pin.  Crucially,
        // no local known_hosts record can turn this result back into trusted.
        let Ok(saved_records) = parse_known_hosts(saved_pin) else {
            return SftpHostKeyStatus::Changed;
        };
        let mut trusted = false;
        for saved in &saved_records {
            // Existing saved connections may contain a comma-separated alias
            // list or more than one key type.  Only an exact host token is a
            // valid connection pin; wildcard and hashed patterns belong to
            // the local known_hosts lookup below.
            let exact_host = saved
                .patterns
                .split(',')
                .any(|entry| entry == expected_host);
            if !exact_host {
                continue;
            }
            if matches!(
                saved.marker,
                Some(keys::ssh_key::known_hosts::Marker::Revoked)
            ) && same_key(&saved.key, current_key)
            {
                return SftpHostKeyStatus::Changed;
            }
            if saved.marker.is_none() && same_key(&saved.key, current_key) {
                trusted = true;
            }
        }
        // Any nonempty saved value is authoritative.  A local record is never
        // consulted when it does not match the saved pin.
        return if trusted {
            SftpHostKeyStatus::Trusted
        } else {
            SftpHostKeyStatus::Changed
        };
    }

    let matching = local_records
        .iter()
        .filter(|record| host_pattern_matches(&record.patterns, &expected_host));
    let matching: Vec<&KnownHostRecord> = matching.collect();
    if matching.iter().any(|record| {
        matches!(
            record.marker,
            Some(keys::ssh_key::known_hosts::Marker::Revoked)
        ) && same_key(&record.key, current_key)
    }) {
        return SftpHostKeyStatus::Changed;
    }
    // A file can legitimately retain keys for more than one host-key
    // algorithm.  Trust if any unmarked record matches the current key; a
    // different algorithm does not turn a known host into "unknown".
    if matching
        .iter()
        .any(|record| record.marker.is_none() && same_key(&record.key, current_key))
    {
        SftpHostKeyStatus::Trusted
    } else if matching.is_empty() {
        SftpHostKeyStatus::Unknown
    } else {
        SftpHostKeyStatus::Changed
    }
}

fn canonical_pin(host: &str, port: u16, key: &PublicKey) -> StorageResult<String> {
    let openssh = key
        .to_openssh()
        .map_err(|_| invalid("SFTP 服务器返回了无法编码的主机密钥"))?;
    let mut fields = openssh.split_whitespace();
    let algorithm = fields
        .next()
        .ok_or_else(|| invalid("SFTP 服务器返回了无效的主机密钥"))?;
    let encoded = fields
        .next()
        .ok_or_else(|| invalid("SFTP 服务器返回了无效的主机密钥"))?;
    Ok(format!(
        "{} {algorithm} {encoded}",
        host_pattern(host, port)
    ))
}

fn inspection(
    host: &str,
    port: u16,
    saved_pin: &str,
    local_records: &[KnownHostRecord],
    key: PublicKey,
) -> StorageResult<SftpHostKeyInspection> {
    let known_hosts = canonical_pin(host, port, &key)?;
    let status = classify(host, port, saved_pin, local_records, &key);
    let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
    let algorithm = key.algorithm().as_str().to_owned();
    Ok(SftpHostKeyInspection {
        status,
        known_hosts,
        fingerprint,
        algorithm,
    })
}

async fn probe_sftp_host_key(
    host: &str,
    port: u16,
    preferred_keys: &[PublicKey],
) -> StorageResult<PublicKey> {
    let captured = Arc::new(Mutex::new(None));
    let handler = ProbeHandler {
        captured: Arc::clone(&captured),
    };
    let config = russh::client::Config {
        preferred: preferred_for_keys(preferred_keys),
        nodelay: true,
        ..Default::default()
    };
    let connection = tokio::time::timeout(
        PROBE_TIMEOUT,
        russh::client::connect(Arc::new(config), (host, port), handler),
    )
    .await
    .map_err(|_| {
        let mut error = StorageError::new(
            StorageErrorCode::Timeout,
            "读取 SFTP 服务器主机密钥超时，请检查网络和服务状态",
        );
        error.retryable = true;
        error
    })?
    .map_err(probe_error)?;

    // `connect` resolves after key exchange.  No auth method is called; send
    // an explicit disconnect and then drop the handle to stop russh's loop.
    let key = captured
        .lock()
        .ok()
        .and_then(|mut captured| captured.take())
        .ok_or_else(|| {
            StorageError::new(StorageErrorCode::Internal, "未捕获 SFTP 服务器主机密钥")
        })?;
    let _ = connection
        .disconnect(
            russh::Disconnect::ByApplication,
            "host-key inspection complete",
            "",
        )
        .await;
    drop(connection);
    Ok(key)
}

/// Reorder russh's host-key algorithms so a recorded key type is selected
/// before the default Ed25519 preference.  RSA host keys use the strongest
/// available rsa-sha2 exchange signature first; the actual key identity stays
/// `ssh-rsa` and is still compared by key data.
pub(crate) fn preferred_for_keys(keys: &[PublicKey]) -> Preferred {
    let mut preferred = Preferred::DEFAULT.clone();
    let mut ordered = Vec::new();
    for key in keys {
        let algorithms = if key.algorithm().is_rsa() {
            vec![
                keys::Algorithm::Rsa {
                    hash: Some(keys::HashAlg::Sha512),
                },
                keys::Algorithm::Rsa {
                    hash: Some(keys::HashAlg::Sha256),
                },
            ]
        } else {
            vec![key.algorithm()]
        };
        for algorithm in algorithms {
            if preferred.key.contains(&algorithm) && !ordered.contains(&algorithm) {
                ordered.push(algorithm);
            }
        }
    }
    for algorithm in Preferred::DEFAULT.key.iter() {
        if !ordered.iter().any(|candidate| candidate == algorithm) {
            ordered.push(algorithm.clone());
        }
    }
    preferred.key = Cow::Owned(ordered);
    preferred
}

/// Inspect a server key and classify it against a saved connection pin or
/// the supplied contents of the user's known_hosts file.
///
/// `local_known_hosts` is only consulted when `saved_pin` is empty.  Callers
/// should pass an empty string when `~/.ssh/known_hosts` does not exist.
pub async fn inspect_sftp_host_key(
    host: &str,
    port: u16,
    saved_pin: &str,
    local_known_hosts: &str,
) -> StorageResult<SftpHostKeyInspection> {
    let host = normalized_host(host, port)?;
    let saved_records = if saved_pin.trim().is_empty() {
        Vec::new()
    } else {
        // A malformed saved pin remains a changed pin, but a valid key lets
        // the probe select its algorithm when possible.
        parse_known_hosts(saved_pin).unwrap_or_default()
    };
    let local_records = if saved_pin.trim().is_empty() {
        parse_known_hosts(local_known_hosts)?
    } else {
        Vec::new()
    };
    let expected_host = host_pattern(&host, port);
    let preferred_keys: Vec<PublicKey> = if saved_pin.trim().is_empty() {
        local_records
            .iter()
            .filter(|record| {
                record.marker.is_none() && host_pattern_matches(&record.patterns, &expected_host)
            })
            .map(|record| record.key.clone())
            .collect()
    } else {
        saved_records
            .iter()
            .filter(|record| {
                record.marker.is_none()
                    && record
                        .patterns
                        .split(',')
                        .any(|entry| entry == expected_host)
            })
            .map(|record| record.key.clone())
            .collect()
    };
    let key = probe_sftp_host_key(&host, port, &preferred_keys).await?;
    inspection(&host, port, saved_pin, &local_records, key)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_A: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";
    const KEY_B: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIA6rWI3G1sz07DnfFlrouTcysQlj2P+jpNSOEWD9OJ3X";

    fn key(encoded: &str) -> PublicKey {
        keys::parse_public_key_base64(encoded).expect("fixture key is valid")
    }

    fn record(patterns: &str, encoded: &str) -> KnownHostRecord {
        KnownHostRecord {
            patterns: patterns.to_owned(),
            key: key(encoded),
            marker: None,
        }
    }

    fn hashed_pattern(value: &str, salt: &[u8]) -> String {
        let mut mac = Hmac::<Sha1>::new_from_slice(salt).expect("fixture salt is valid");
        mac.update(value.as_bytes());
        format!(
            "|1|{}|{}",
            BASE64_MIME.encode(salt),
            BASE64_MIME.encode(&mac.finalize().into_bytes())
        )
    }

    #[test]
    fn empty_local_file_is_unknown() {
        assert_eq!(
            classify("example.com", 22, "", &[], &key(KEY_A)),
            SftpHostKeyStatus::Unknown
        );
    }

    #[test]
    fn matching_pin_is_trusted() {
        let pin = format!("example.com ssh-ed25519 {KEY_A}");
        assert_eq!(
            classify("example.com", 22, &pin, &[], &key(KEY_A)),
            SftpHostKeyStatus::Trusted
        );
    }

    #[test]
    fn saved_pin_mismatch_never_falls_back_to_local_record() {
        let saved = format!("example.com ssh-ed25519 {KEY_B}");
        let local = vec![record("example.com", KEY_A)];
        assert_eq!(
            classify("example.com", 22, &saved, &local, &key(KEY_A)),
            SftpHostKeyStatus::Changed
        );
    }

    #[test]
    fn same_host_different_key_is_changed_even_when_algorithm_differs() {
        let ecdsa = "AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBHwf2HMM5TRXvo2SQJjsNkiDD5KqiiNjrGVv3UUh+mMT5RHxiRtOnlqvjhQtBq0VpmpCV/PwUdhOig4vkbqAcEc=";
        let records = vec![record("example.com", ecdsa)];
        assert_eq!(
            classify("example.com", 22, "", &records, &key(KEY_A)),
            SftpHostKeyStatus::Changed
        );
    }

    #[test]
    fn one_matching_algorithm_trusts_a_multi_algorithm_host() {
        let ecdsa = "AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBHwf2HMM5TRXvo2SQJjsNkiDD5KqiiNjrGVv3UUh+mMT5RHxiRtOnlqvjhQtBq0VpmpCV/PwUdhOig4vkbqAcEc=";
        let records = vec![record("example.com", ecdsa), record("example.com", KEY_A)];
        assert_eq!(
            classify("example.com", 22, "", &records, &key(KEY_A)),
            SftpHostKeyStatus::Trusted
        );
    }

    #[test]
    fn saved_pin_accepts_exact_host_alias_lists() {
        let pin = format!("example.com,alias.example.com ssh-ed25519 {KEY_A}");
        assert_eq!(
            classify("example.com", 22, &pin, &[], &key(KEY_A)),
            SftpHostKeyStatus::Trusted
        );
    }

    #[test]
    fn hashed_host_record_matches() {
        let patterns = hashed_pattern("example.com", b"01234567890123456789");
        let records = vec![record(&patterns, KEY_A)];
        assert_eq!(
            classify("example.com", 22, "", &records, &key(KEY_A)),
            SftpHostKeyStatus::Trusted
        );
        assert_eq!(
            classify("other.example.com", 22, "", &records, &key(KEY_A)),
            SftpHostKeyStatus::Unknown
        );
    }

    #[test]
    fn nondefault_port_uses_bracketed_host_pattern() {
        let records = vec![record("[example.com]:2200", KEY_A)];
        assert_eq!(
            classify("example.com", 2200, "", &records, &key(KEY_A)),
            SftpHostKeyStatus::Trusted
        );
        assert_eq!(
            classify("example.com", 22, "", &records, &key(KEY_A)),
            SftpHostKeyStatus::Unknown
        );
    }

    #[test]
    fn revoked_record_cannot_be_trusted() {
        let mut revoked = record("example.com", KEY_A);
        revoked.marker = Some(keys::ssh_key::known_hosts::Marker::Revoked);
        assert_eq!(
            classify("example.com", 22, "", &[revoked], &key(KEY_A)),
            SftpHostKeyStatus::Changed
        );
    }

    #[test]
    fn canonical_pin_has_no_comment_or_newline() {
        let pin = canonical_pin("example.com", 2200, &key(KEY_A)).expect("key encodes");
        assert_eq!(pin, format!("[example.com]:2200 ssh-ed25519 {KEY_A}"));
        assert!(!pin.ends_with('\n'));
    }

    #[test]
    fn preferred_algorithms_put_recorded_type_first() {
        let preferred = preferred_for_keys(&[key(KEY_A)]);
        assert_eq!(preferred.key.first(), Some(&keys::Algorithm::Ed25519));
    }

    #[tokio::test]
    #[ignore = "requires FILO_TEST_REMOTE_FIXTURE loopback servers"]
    async fn loopback_fixture_probe_is_auth_free_and_classifies_pin() {
        let path = std::env::var_os("FILO_TEST_REMOTE_FIXTURE")
            .expect("FILO_TEST_REMOTE_FIXTURE must point to the disposable fixture");
        let fixture: serde_json::Value = serde_json::from_slice(
            &std::fs::read(path).expect("fixture manifest must be readable"),
        )
        .expect("fixture manifest must be JSON");
        let host = fixture["host"].as_str().expect("fixture host");
        let port = fixture["sftp_port"].as_u64().expect("fixture port") as u16;
        let pin = fixture["known_hosts"]
            .as_str()
            .expect("fixture known_hosts");

        let first = inspect_sftp_host_key(host, port, "", "")
            .await
            .expect("probe");
        assert_eq!(first.known_hosts, pin.trim());
        assert_eq!(first.status, SftpHostKeyStatus::Unknown);

        let local_trusted = inspect_sftp_host_key(host, port, "", pin.trim())
            .await
            .expect("local known_hosts probe");
        assert_eq!(local_trusted.status, SftpHostKeyStatus::Trusted);

        let trusted = inspect_sftp_host_key(host, port, pin.trim(), "")
            .await
            .expect("trusted probe");
        assert_eq!(trusted.status, SftpHostKeyStatus::Trusted);

        let wrong = format!("{} ssh-ed25519 {KEY_B}", host_pattern(host, port));
        let changed = inspect_sftp_host_key(host, port, &wrong, "")
            .await
            .expect("changed probe");
        assert_eq!(changed.status, SftpHostKeyStatus::Changed);
    }
}
