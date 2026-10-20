use std::{
    collections::VecDeque,
    panic::{catch_unwind, AssertUnwindSafe},
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[derive(Clone, serde::Serialize)]
pub(crate) struct BackendError {
    pub(crate) id: String,
    pub(crate) location: String,
}

struct Reports {
    recent: Mutex<VecDeque<BackendError>>,
    app: OnceLock<tauri::AppHandle>,
    directory: PathBuf,
}

#[derive(Clone)]
pub(crate) struct ErrorReports(Arc<Reports>);

impl ErrorReports {
    pub(crate) fn recent(&self) -> Vec<BackendError> {
        self.0
            .recent
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned()
            .collect()
    }

    pub(crate) fn attach(&self, app: tauri::AppHandle) {
        let _ = self.0.app.set(app);
    }

    pub(crate) fn application_failed(&self, error: &dyn std::fmt::Display) {
        self.report("startup".into(), &error.to_string(), "");
    }

    fn report(&self, location: String, details: &str, backtrace: &str) {
        let report = BackendError {
            id: uuid::Uuid::new_v4().to_string(),
            location,
        };
        if let Err(error) =
            super::diagnostics::write_report(&self.0.directory, &report, details, backtrace)
        {
            eprintln!("Failed to save Filo diagnostic {}: {error}", report.id);
        }
        // Never block a panic hook on a lock held by the panicking thread.
        if let Ok(mut reports) = self.0.recent.try_lock() {
            if reports.len() == 20 {
                reports.pop_front();
            }
            reports.push_back(report.clone());
        }
        tracing::error!(incident_id = %report.id, location = %report.location,
            "Backend exception; see diagnostic log");
        if let Some(app) = self.0.app.get() {
            let _ = app.emit("backend-error", &report);
        }
    }

    pub(crate) fn show_startup_failure(&self, app: &tauri::AppHandle) {
        // Storage may be only partly initialized. Keep the normal UI unavailable.
        for window in app.webview_windows().values() {
            let _ = window.hide();
        }
        let app_handle = app.clone();
        app.dialog()
            .message(format!(
                "Filo 未能完成初始化，请退出后重试。\n\n如需排查，请提供此目录中的诊断文件：\n{}",
                self.0.directory.display(),
            ))
            .title("Filo 启动失败")
            .kind(MessageDialogKind::Error)
            .buttons(MessageDialogButtons::OkCustom("退出".into()))
            .show(move |_| app_handle.exit(1));
    }
}

pub(crate) fn install() -> ErrorReports {
    install_at(super::diagnostics::log_directory())
}

fn install_at(directory: PathBuf) -> ErrorReports {
    let reports = ErrorReports(Arc::new(Reports {
        recent: Mutex::default(),
        app: OnceLock::new(),
        directory,
    }));
    let hook_reports = reports.clone();
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|location| {
                let file = std::path::Path::new(location.file())
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy();
                format!("{file}:{}:{}", location.line(), location.column())
            })
            .unwrap_or_else(|| "unknown".into());
        let details = info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
            .unwrap_or("non-string panic payload");
        hook_reports.report(
            location,
            details,
            &std::backtrace::Backtrace::force_capture().to_string(),
        );
        previous(info);
    }));
    reports
}

type SetupResult = Result<(), Box<dyn std::error::Error>>;

// Tauri turns a setup Err into a panic inside the native launch callback.
// Settle both errors and unwinding here, before they cross that FFI boundary.
pub(crate) fn setup(reports: &ErrorReports, initialize: impl FnOnce() -> SetupResult) -> bool {
    match catch_unwind(AssertUnwindSafe(initialize)) {
        Ok(Ok(())) => true,
        Ok(Err(error)) => {
            reports.application_failed(&error);
            false
        }
        Err(_) => false, // The panic hook already saved the diagnostic.
    }
}

// All application IPC commands use this declaration, including future commands.
macro_rules! commands {
    ($($(#[$meta:meta])* $vis:vis async fn $name:ident($($args:tt)*) -> $result:ty $body:block)*) => {
        $(
            #[tauri::command]
            $(#[$meta])*
            $vis async fn $name($($args)*) -> $result {
                storage_application::catch_panic(async move $body).await
            }
        )*
    };
}
pub(crate) use commands;

#[cfg(test)]
mod tests {
    use super::*;
    use storage_domain::{StorageErrorCode, StorageResult};

    super::commands! {
        async fn failing_command() -> StorageResult<()> {
            tokio::task::yield_now().await;
            panic!("fixture panic");
        }
        async fn successful_command() -> StorageResult<u32> { Ok(7) }
    }

    #[tokio::test]
    async fn command_panic_rejects_instead_of_leaving_the_caller_pending() {
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), failing_command())
            .await
            .unwrap();
        assert_eq!(result.unwrap_err().code, StorageErrorCode::Internal);
        assert_eq!(successful_command().await.unwrap(), 7);
    }

    #[test]
    fn startup_errors_and_panics_stay_inside_the_setup_boundary() {
        let directory = tempfile::tempdir().unwrap();
        let reports = ErrorReports(Arc::new(Reports {
            recent: Mutex::default(),
            app: OnceLock::new(),
            directory: directory.path().to_path_buf(),
        }));
        assert!(!setup(&reports, || Err(std::io::Error::other(
            "fixture database failure"
        )
        .into())));
        assert_eq!(reports.recent()[0].location, "startup");
        let path = std::fs::read_dir(directory.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert!(std::fs::read_to_string(path)
            .unwrap()
            .contains("fixture database failure"));
        assert!(!setup(&reports, || panic!("fixture setup panic")));
        assert!(setup(&reports, || Ok(())));
    }

    #[test]
    fn ffi_panic_fixture() {
        let Some(directory) = std::env::var_os("FILO_TEST_PANIC_DIRECTORY") else {
            return;
        };
        let reports = install_at(directory.into());
        // Simulate a panic while the report queue is locked, before app attachment.
        let _guard = reports.0.recent.lock().unwrap();
        extern "C" fn launch_callback() {
            panic!("fixture launch panic password=private-fixture");
        }
        launch_callback();
    }

    #[test]
    fn launch_panic_is_saved_before_ffi_abort_without_an_app_handle() {
        let directory = tempfile::tempdir().unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "errors::tests::ffi_panic_fixture", "--nocapture"])
            .env("FILO_TEST_PANIC_DIRECTORY", directory.path())
            .output()
            .unwrap();
        assert!(!output.status.success());
        let saved: Vec<serde_json::Value> = std::fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| {
                serde_json::from_slice(&std::fs::read(entry.unwrap().path()).unwrap()).unwrap()
            })
            .collect();
        let original = saved
            .iter()
            .find(|value| {
                value["details"]
                    .as_str()
                    .unwrap()
                    .contains("fixture launch panic")
            })
            .expect("the original panic must survive the abort");
        assert!(!original.to_string().contains("private-fixture"));
        assert!(original["incident"]["location"]
            .as_str()
            .unwrap()
            .starts_with("errors.rs:"));
        assert!(!original["backtrace"].as_str().unwrap().is_empty());
    }
}
