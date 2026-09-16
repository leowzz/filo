//! Native TOS bucket statistics; never enumerates objects or applies a prefix.
//! API: https://www.volcengine.com/docs/6349/2485353
//! Signing: https://www.volcengine.com/docs/6349/74839
use hmac::{Hmac, Mac};
use reqwest::header::{HeaderMap, HeaderValue};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, time::Duration};
use storage_domain::*;
use url::Url;

pub(crate) struct TosStats {
    url: Url,
    region: String,
    credentials: S3Credentials,
}

impl TosStats {
    #[cfg(test)]
    pub(crate) fn with_test_url(mut self, url: Url) -> Self {
        self.url = url;
        self
    }

    pub(crate) fn new(
        config: &S3ConnectionConfig,
        credentials: &S3Credentials,
        bucket: &str,
    ) -> Option<Self> {
        let mut url = Url::parse(config.endpoint.as_deref()?).ok()?;
        let host = url.host_str()?;
        // Only translate recognized TOS hosts. Preserve public/private routing;
        // never send a custom endpoint's credentials to a guessed service.
        let domain = ["volces.com", "ivolces.com"].into_iter().find(|domain| {
            host == format!("tos-s3-{}.{domain}", config.region)
                || host == format!("tos-{}.{domain}", config.region)
        })?;
        url.set_host(Some(&format!("{bucket}.tos-{}.{domain}", config.region)))
            .ok()?;
        url.set_query(Some("stat="));
        Some(Self {
            url,
            region: config.region.clone(),
            credentials: credentials.clone(),
        })
    }

    pub(crate) async fn overview(&self) -> StorageResult<Value> {
        let headers = signed_headers(
            &self.url,
            &self.region,
            &self.credentials,
            &chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string(),
        )?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| network_error())?;
        let response = client
            .get(self.url.clone())
            .headers(headers)
            .send()
            .await
            .map_err(|_| network_error())?;
        match response.status().as_u16() {
            200 => {}
            401 | 403 => {
                return Err(StorageError::new(
                    StorageErrorCode::AccessDenied,
                    "TOS 拒绝读取桶统计，请检查 tos:GetBucketStat 权限",
                ))
            }
            _ => return Err(network_error()),
        }
        let body = response.text().await.map_err(|_| network_error())?;
        let (count, size) = parse_stats(&body)?;
        Ok(
            json!({ "object_count": count, "total_size": size, "complete": true, "source": "tos_bucket_stat" }),
        )
    }
}

fn network_error() -> StorageError {
    StorageError::new(
        StorageErrorCode::Network,
        "暂时无法获取 TOS 桶统计，请检查网络后重试",
    )
}

fn signed_headers(
    url: &Url,
    region: &str,
    credentials: &S3Credentials,
    date: &str,
) -> StorageResult<HeaderMap> {
    let digest = |input: &str| format!("{:x}", Sha256::digest(input.as_bytes()));
    let payload = digest("");
    let mut headers = BTreeMap::from([
        (
            "host",
            url[url::Position::BeforeHost..url::Position::AfterPort].to_string(),
        ),
        ("x-tos-content-sha256", payload.clone()),
        ("x-tos-date", date.to_string()),
    ]);
    if let Some(token) = &credentials.session_token {
        headers.insert("x-tos-security-token", token.trim().to_owned());
    }
    let canonical_headers: String = headers
        .iter()
        .map(|(key, value)| format!("{key}:{}\n", value.trim()))
        .collect();
    let signed = headers.keys().copied().collect::<Vec<_>>().join(";");
    let canonical = format!(
        "GET\n{}\n{}\n{canonical_headers}\n{signed}\n{payload}",
        url.path(),
        url.query().unwrap_or("")
    );
    let scope = format!("{}/{region}/tos/request", &date[..8]);
    let to_sign = format!("TOS4-HMAC-SHA256\n{date}\n{scope}\n{}", digest(&canonical));
    let hmac = |key: &[u8], value: &str| {
        let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
        mac.update(value.as_bytes());
        mac.finalize().into_bytes()
    };
    let key = hmac(credentials.secret_access_key.as_bytes(), &date[..8]);
    let key = hmac(&key, region);
    let key = hmac(&key, "tos");
    let key = hmac(&key, "request");
    let signature = format!("{:x}", hmac(&key, &to_sign));
    headers.insert(
        "authorization",
        format!(
            "TOS4-HMAC-SHA256 Credential={}/{scope},SignedHeaders={signed}, Signature={signature}",
            credentials.access_key_id
        ),
    );
    let mut result = HeaderMap::new();
    for (name, value) in headers {
        let mut value = HeaderValue::from_str(&value).map_err(|_| {
            StorageError::new(
                StorageErrorCode::InvalidConfiguration,
                "TOS 访问凭据格式无效",
            )
        })?;
        if name == "authorization" || name == "x-tos-security-token" {
            value.set_sensitive(true);
        }
        result.insert(name, value);
    }
    Ok(result)
}

fn parse_stats(body: &str) -> StorageResult<(u64, u64)> {
    let invalid = || StorageError::new(StorageErrorCode::Unsupported, "TOS 未返回有效的桶统计数据");
    // The official Go SDK uses JSON (Storage is a decimal string), while the
    // REST reference also documents an XML BucketStat response.
    if body.trim_start().starts_with('{') {
        let value: Value = serde_json::from_str(body).map_err(|_| invalid())?;
        let total = &value["TotalStorageStat"];
        let number = |value: &Value| {
            value
                .as_u64()
                .or_else(|| value.as_str()?.parse::<u64>().ok())
        };
        return Ok((
            number(&total["ObjectCount"]).ok_or_else(invalid)?,
            number(&total["Storage"]).ok_or_else(invalid)?,
        ));
    }
    #[derive(Deserialize)]
    struct BucketStat {
        #[serde(rename = "TotalStorageStat")]
        total: Total,
    }
    #[derive(Deserialize)]
    struct Total {
        #[serde(rename = "ObjectCount")]
        count: u64,
        #[serde(rename = "Storage")]
        size: u64,
    }
    let stats: BucketStat = quick_xml::de::from_str(body).map_err(|_| invalid())?;
    Ok((stats.total.count, stats.total.size))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credentials() -> S3Credentials {
        S3Credentials {
            access_key_id: "testAK".into(),
            secret_access_key: "testSK".into(),
            session_token: None,
        }
    }

    #[test]
    fn signature_matches_official_test_vector() {
        let url =
            Url::parse("https://examplebucket.tos-cn-beijing.volces.com/exampleobject").unwrap();
        let headers =
            signed_headers(&url, "cn-beijing", &credentials(), "20220101T000000Z").unwrap();
        assert!(headers["authorization"].to_str().unwrap().ends_with(
            "Signature=d40b66cf0054d1642843670d10fa095e1609c7896f25df217770b0abe717693b"
        ));
        let mut credentials = credentials();
        credentials.session_token = Some("test-token".into());
        let with_token =
            signed_headers(&url, "cn-beijing", &credentials, "20220101T000000Z").unwrap();
        assert_eq!(with_token["x-tos-security-token"], "test-token");
        assert!(with_token["authorization"]
            .to_str()
            .unwrap()
            .contains(";x-tos-security-token,"));
        assert_ne!(with_token["authorization"], headers["authorization"]);
    }

    #[test]
    fn endpoints_preserve_public_private_scope_and_reject_unknown_hosts() {
        for domain in ["volces.com", "ivolces.com"] {
            let mut config = S3ConnectionConfig {
                provider: Some(S3Provider::Tos),
                endpoint: Some(format!("https://tos-s3-cn-beijing.{domain}")),
                region: "cn-beijing".into(),
                force_path_style: false,
            };
            let stats = TosStats::new(&config, &credentials(), "examplebucket").unwrap();
            assert_eq!(
                stats.url.as_str(),
                format!("https://examplebucket.tos-cn-beijing.{domain}/?stat=")
            );
            config.endpoint = Some("https://custom.example.com".into());
            assert!(TosStats::new(&config, &credentials(), "examplebucket").is_none());
        }
    }

    #[test]
    fn reads_actual_storage_and_rejects_missing_or_invalid_totals() {
        assert_eq!(parse_stats(r#"{"TotalStorageStat":{"Storage":"43087225856","ChargeStorage":"99999999999","ObjectCount":10553469}}"#).unwrap(), (10553469, 43087225856));
        assert_eq!(parse_stats("<BucketStat><TotalStorageStat><Storage>12</Storage><ObjectCount>3</ObjectCount></TotalStorageStat></BucketStat>").unwrap(), (3, 12));
        assert_eq!(
            parse_stats(r#"{"TotalStorageStat":{"Storage":0,"ObjectCount":0}}"#).unwrap(),
            (0, 0)
        );
        for invalid in [
            "{}",
            r#"{"TotalStorageStat":{"Storage":-1,"ObjectCount":2}}"#,
            "<BucketStat/>",
            r#"{"TotalStorageStat":{"Storage":"unknown","ObjectCount":2}}"#,
        ] {
            assert!(parse_stats(invalid).is_err());
        }
    }
}
