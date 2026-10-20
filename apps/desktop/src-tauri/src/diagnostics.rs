use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::LazyLock,
    time::{SystemTime, UNIX_EPOCH},
};

const RETAINED_REPORTS: usize = 20;
const MAX_TEXT_BYTES: usize = 64 * 1024;

pub(crate) fn log_directory() -> PathBuf {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap_or_default();
    let identifier = config["identifier"].as_str().unwrap_or("dev.filo.desktop");
    dirs::config_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(identifier)
        .join("log")
}

pub(crate) fn redact(text: &str) -> String {
    static AUTH: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"(?i)\b(?:Bearer|Basic)\s+[^\s,;\x22']+").unwrap());
    static URL: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r#"(?i)\b(?:https?|s3|smb|sftp|ftp)://[^\s<>"']+"#).unwrap()
    });
    static SECRET: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r#"(?i)(["']?(?:access[_ -]?key(?:[_ -]?id)?|secret(?:[_ -]?access)?[_ -]?key|session[_ -]?token|token|authorization|password|signature|credential)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}&]+)"#,
        )
        .unwrap()
    });
    let text = AUTH.replace_all(text, "[已隐藏]");
    let text = URL.replace_all(&text, "[地址已隐藏]");
    let mut text = SECRET.replace_all(&text, "${1}[已隐藏]").into_owned();
    let mut end = text.len().min(MAX_TEXT_BYTES);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text
}

// Write directly and sync before returning: an FFI panic may abort immediately,
// without unwinding or giving a background log worker time to flush.
pub(crate) fn write_report(
    directory: &Path,
    report: &super::errors::BackendError,
    details: &str,
    backtrace: &str,
) -> std::io::Result<PathBuf> {
    fs::create_dir_all(directory)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let path = directory.join(format!("error-{timestamp:020}-{}.json", report.id));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    serde_json::to_writer(
        &mut file,
        &serde_json::json!({
            "timestamp_ms": timestamp,
            "version": env!("CARGO_PKG_VERSION"),
            "incident": report,
            "details": redact(details),
            "backtrace": redact(backtrace),
        }),
    )?;
    file.write_all(b"\n")?;
    file.sync_all()?;

    let mut reports: Vec<_> = fs::read_dir(directory)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("error-") && name.ends_with(".json"))
        })
        .collect();
    reports.sort();
    for path in reports
        .iter()
        .take(reports.len().saturating_sub(RETAINED_REPORTS))
    {
        let _ = fs::remove_file(path);
    }
    Ok(path)
}

// Failed marks are user work, so keep these records independently of the
// rotating exception reports. They are evidence, not an automatic replay queue.
pub(crate) fn write_review_save_failure(
    data: &Path,
    mark: &serde_json::Value,
    error: &storage_domain::StorageError,
) -> std::io::Result<PathBuf> {
    let directory = data.join("review-save-failures");
    fs::create_dir_all(&directory)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let path = directory.join(format!("{timestamp:020}-{}.json", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    serde_json::to_writer_pretty(
        &mut file,
        &serde_json::json!({
            "timestamp_ms": timestamp,
            "version": env!("CARGO_PKG_VERSION"),
            "mark": mark,
            "error": { "code": error.code, "message": redact(&error.message) },
        }),
    )?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_review_marks_preserve_work_without_rotating_or_exposing_credentials() {
        let data = tempfile::tempdir().unwrap();
        let mark = serde_json::json!({
            "session_id": uuid::Uuid::new_v4(),
            "photo_id": uuid::Uuid::new_v4(),
            "original_path": "RAW/照片.NEF",
            "rating": 4,
            "flag": "reject",
        });
        let error = storage_domain::StorageError::new(
            storage_domain::StorageErrorCode::Network,
            "failed smb://user:private-password@host/ password=private-password",
        );
        for _ in 0..RETAINED_REPORTS + 1 {
            let path = write_review_save_failure(data.path(), &mark, &error).unwrap();
            let text = fs::read_to_string(&path).unwrap();
            let saved: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(saved["mark"], mark);
            assert_eq!(saved["error"]["code"], "network");
            assert!(saved["timestamp_ms"].as_u64().is_some());
            assert!(!text.contains("private-password"));
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    fs::metadata(path).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
        }
        assert_eq!(
            fs::read_dir(data.path().join("review-save-failures"))
                .unwrap()
                .count(),
            RETAINED_REPORTS + 1
        );
        let file = data.path().join("not-a-directory");
        fs::write(&file, "fixture").unwrap();
        assert!(write_review_save_failure(&file, &mark, &error).is_err());
    }

    #[test]
    fn reports_are_private_redacted_bounded_and_retained() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("unrelated.txt"), "keep").unwrap();
        let report = super::super::errors::BackendError {
            id: uuid::Uuid::new_v4().to_string(),
            location: "fixture.rs:42:9".into(),
        };
        let path = write_report(
            directory.path(),
            &report,
            r#"failed Authorization="Bearer private-token" password=private-password sftp://user:private-password@host/ secret_access_key='private-secret'"#,
            "fixture stack",
        )
        .unwrap();
        let text = fs::read_to_string(&path).unwrap();
        let saved: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(saved["incident"]["id"], report.id);
        assert_eq!(saved["incident"]["location"], report.location);
        assert_eq!(saved["backtrace"], "fixture stack");
        assert!(!text.contains("private-"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let bounded = redact(&"异".repeat(MAX_TEXT_BYTES));
        assert!(bounded.len() <= MAX_TEXT_BYTES);
        for _ in 0..RETAINED_REPORTS + 2 {
            let report = super::super::errors::BackendError {
                id: uuid::Uuid::new_v4().to_string(),
                location: "startup".into(),
            };
            write_report(directory.path(), &report, "fixture", "").unwrap();
        }
        assert_eq!(
            fs::read_dir(directory.path()).unwrap().count(),
            RETAINED_REPORTS + 1
        );
        assert!(directory.path().join("unrelated.txt").exists());
    }
}
