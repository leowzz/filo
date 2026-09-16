import { Download } from "lucide-react";
import type { AppUpdater } from "./useAppUpdater";
import { useEffect, useRef } from "react";

export function UpdateProgressDialog({ updater }: { updater: AppUpdater }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="update-progress"
      aria-labelledby="update-title"
      onCancel={(event) => event.preventDefault()}
    >
      <h2 id="update-title">
        {updater.phase === "installing" ? "正在安装更新…" : "正在下载更新…"}
      </h2>
      <p>完成后将重启 Filo，请保持应用打开。</p>
      <progress max={100} value={updater.progress} aria-label="更新下载进度" />
    </dialog>
  );
}

export function AppUpdateCard({ updater }: { updater: AppUpdater }) {
  return (
    <section className="settings-card">
      <h2>
        <Download size={19} />
        软件更新
      </h2>
      <p>Filo {updater.version}</p>
      <p role="status">
        {!updater.enabled
          ? "开发与浏览器预览模式不检查更新。"
          : updater.phase === "checking"
            ? "正在检查更新…"
            : updater.phase === "current"
              ? "当前已是最新版本。"
              : updater.phase === "restart"
                ? "更新已安装，请重启 Filo。"
                : updater.availableVersion
                  ? `发现新版本 ${updater.availableVersion}，安装后将重启 Filo。`
                  : "启动后自动检查更新，安装前会征求你的确认。"}
      </p>
      {updater.error && <p role="alert">{updater.error}</p>}
      <div className="transfer-settings-actions">
        {updater.phase === "restart" ? (
          <button className="primary" onClick={() => void updater.restart()}>
            重启 Filo
          </button>
        ) : (
          <>
            <button
              className="secondary"
              disabled={
                !updater.enabled || updater.busy || updater.phase === "checking"
              }
              onClick={() => void updater.check()}
            >
              检查更新
            </button>
            {updater.availableVersion && (
              <button
                className="primary"
                disabled={updater.busy || updater.phase === "checking"}
                onClick={() => void updater.install()}
              >
                安装并重启
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
