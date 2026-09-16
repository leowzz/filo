use std::{collections::VecDeque, sync::Mutex};
use tauri::{Emitter, Manager};

#[derive(Clone, serde::Serialize)]
pub(crate) struct BackendError {
    id: String,
    location: String,
}

#[derive(Default)]
pub(crate) struct ErrorReports(Mutex<VecDeque<BackendError>>);

impl ErrorReports {
    pub(crate) fn recent(&self) -> Vec<BackendError> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned()
            .collect()
    }
}

pub(crate) fn install(app: tauri::AppHandle) {
    app.manage(ErrorReports::default());
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
        let report = BackendError {
            id: uuid::Uuid::new_v4().to_string(),
            location,
        };
        // Preserve reports that happen before the frontend event listener is ready.
        // Never block the panic hook on a lock that the panicking thread may hold.
        if let Ok(mut reports) = app.state::<ErrorReports>().0.try_lock() {
            if reports.len() == 20 {
                reports.pop_front();
            }
            reports.push_back(report.clone());
        }
        tracing::error!(incident_id = %report.id, location = %report.location,
            backtrace = %std::backtrace::Backtrace::force_capture(), "Backend panic");
        let _ = app.emit("backend-error", &report);
        previous(info);
    }));
}

// All application IPC commands use this declaration, including future commands.
macro_rules! commands {
    ($($vis:vis async fn $name:ident($($args:tt)*) -> $result:ty $body:block)*) => {
        $(
            #[tauri::command]
            $vis async fn $name($($args)*) -> $result {
                storage_application::catch_panic(async move $body).await
            }
        )*
    };
}
pub(crate) use commands;

#[cfg(test)]
mod tests {
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
}
