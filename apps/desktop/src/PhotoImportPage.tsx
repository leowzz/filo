import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Camera,
  Check,
  ChevronRight,
  ImagePlus,
  RefreshCw,
} from "lucide-react";
import { desktop, errorMessage } from "./api";
import {
  photoApi,
  pickPhotoDirectory,
  type Photo,
  type PhotoProgress,
} from "./photoApi";
import { PhotoImportDialog } from "./PhotoImportDialog";
import type { Volume } from "./types";

function stateOf(photo: Photo) {
  if (photo.excluded) return "已排除";
  if (photo.issues.length) return "待处理";
  if (photo.files.every((f) => f.verified)) return "已归档";
  if (photo.files.some((f) => f.verified)) return "部分完成";
  return photo.files.some((f) => f.error) ? "未完成" : "待导入";
}
export function PhotoImportPage({ volumes }: { volumes: Volume[] }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["photo-imports"],
    queryFn: photoApi.catalog,
    refetchOnWindowFocus: false,
  });
  const catalog = query.data;
  const [selected, setSelected] = useState<string | null>(() =>
    sessionStorage.getItem("filo.copy-session"),
  );
  const [dialog, setDialog] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<PhotoProgress | null>(null);
  const [date, setDate] = useState("");
  const session = catalog?.sessions.find((s) => s.id === selected);
  const photos =
    catalog?.photos.filter((p) => session?.photo_ids.includes(p.id)) ?? [];
  const paths = useQuery({
    queryKey: ["photo-import-paths", selected, session?.revision],
    queryFn: () => photoApi.paths(selected!),
    enabled: !!session,
  });
  useEffect(() => {
    if (selected) sessionStorage.setItem("filo.copy-session", selected);
    else sessionStorage.removeItem("filo.copy-session");
  }, [selected]);
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ["photo-imports"] });
  };
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      await refresh();
      setBusy(false);
    }
  };
  const rebind = async () => {
    const directory = await pickPhotoDirectory(true);
    if (directory && selected)
      await photoApi.rebind(selected, directory.locator);
  };
  const restore = async () => {
    const jpg = await pickPhotoDirectory();
    if (!jpg) return;
    const raw = await pickPhotoDirectory();
    if (!raw) return;
    if (!(await photoApi.restore(jpg.locator, raw.locator)))
      throw new Error("RAW 根目录下没有已同步的拷卡记录");
    setSelected(null);
    void client.invalidateQueries({ queryKey: ["volumes"] });
  };
  const copy = async () => {
    if (!session) return;
    setProgress({
      session_id: session.id,
      completed: 0,
      total: photos.filter((p) => !p.excluded).flatMap((p) => p.files).length,
      path: "正在核对归档目标…",
    });
    try {
      await photoApi.import(session.id, setProgress);
      await photoApi.sync(session.id);
    } finally {
      setProgress(null);
    }
  };
  return (
    <section className="photo-workspace-body">
      <div className="photo-page-actions">
        {session ? (
          <>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setSelected(null)}
            >
              <ArrowLeft size={16} />
              全部拷卡记录
            </button>
            <h2>{session.name}</h2>
          </>
        ) : (
          <h2>拷卡记录</h2>
        )}
        <div className="photo-page-action-spacer" />
        <button
          className="secondary"
          disabled={busy || !desktop}
          onClick={() => void run(restore)}
        >
          从 NAS 恢复记录
        </button>
        <button
          className="primary"
          disabled={busy || !desktop}
          onClick={() => setDialog(true)}
        >
          <ImagePlus size={17} />
          从存储卡导入
        </button>
      </div>
      {error && (
        <div className="photo-notice error" role="alert">
          {error}
          <button onClick={() => setError("")}>关闭</button>
        </div>
      )}
      {query.isPending ? (
        <p>正在读取拷卡记录…</p>
      ) : query.isError ? (
        <div className="photo-notice error" role="alert">
          {errorMessage(query.error)}
          <button onClick={() => void query.refetch()}>重试</button>
        </div>
      ) : !session ? (
        <>
          {!catalog?.sessions.length ? (
            <div className="photo-empty">
              <Camera size={42} />
              <h3>将存储卡归档到两个目录</h3>
              <p>分别保存 JPG 与 RAW，核对内容，保留原卡文件。</p>
              <button
                className="primary"
                disabled={!desktop}
                onClick={() => setDialog(true)}
              >
                从存储卡导入
              </button>
            </div>
          ) : (
            <div className="photo-session-list">
              {catalog.sessions
                .slice()
                .reverse()
                .map((s) => {
                  const items = catalog.photos.filter((p) =>
                    s.photo_ids.includes(p.id),
                  );
                  return (
                    <button key={s.id} onClick={() => setSelected(s.id)}>
                      <Camera size={22} />
                      <span>
                        <strong>{s.name}</strong>
                        <small>
                          {s.card_name} ·{" "}
                          {items.filter((p) => stateOf(p) === "已归档").length}/
                          {items.filter((p) => !p.excluded).length} 张已归档
                        </small>
                      </span>
                      <span
                        className={`photo-sync-status ${s.sync_error ? "error" : ""}`}
                      >
                        {s.sync_error
                          ? "NAS 同步失败"
                          : s.revision > s.synced_revision
                            ? "NAS 待同步"
                            : "NAS 已同步"}
                      </span>
                      <ChevronRight size={18} />
                    </button>
                  );
                })}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="photo-session-toolbar">
            <span
              className={`photo-sync-status ${session.sync_error ? "error" : ""}`}
            >
              {session.sync_error
                ? "本机已保存 · NAS 同步失败"
                : session.revision > session.synced_revision
                  ? "本机已保存 · NAS 待同步"
                  : "NAS 已同步"}
            </span>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void run(() => photoApi.sync(session.id))}
            >
              <RefreshCw size={15} />
              同步记录到 NAS
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void run(rebind)}
            >
              重新关联存储卡
            </button>
            <button
              className="primary"
              disabled={busy || !photos.some((p) => !p.excluded)}
              onClick={() => void run(copy)}
            >
              核对并继续导入
            </button>
          </div>
          {session.sync_error && (
            <div className="photo-notice error">{session.sync_error}</div>
          )}
          {progress && (
            <div className="photo-import-progress">
              <progress
                max={Math.max(1, progress.total)}
                value={progress.completed}
              />
              <span>
                {progress.completed} / {progress.total} 个文件 · {progress.path}
              </span>
              <button
                className="secondary"
                onClick={() =>
                  void photoApi
                    .cancel(session.id)
                    .catch((error) => setError(errorMessage(error)))
                }
              >
                暂停导入
              </button>
            </div>
          )}
          {photos.some(
            (p) => p.issues.some((i) => i.includes("日期")) && !p.excluded,
          ) && (
            <div className="photo-date-resolution">
              <label>
                为缺失日期的照片指定拍摄日期
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </label>
              <button
                className="secondary"
                disabled={busy || !date}
                onClick={() =>
                  void run(() => photoApi.resolveDate(session.id, date))
                }
              >
                更新计划路径
              </button>
            </div>
          )}
          <div className="photo-plan-source">
            扫描根目录：
            {paths.data?.source_root ?? "未关联来源，可重新选择存储卡"}
            {paths.isError && (
              <button onClick={() => void paths.refetch()}>重新读取路径</button>
            )}
          </div>
          <div className="photo-plan-table">
            <table>
              <thead>
                <tr>
                  <th>照片 / 来源</th>
                  <th>实际归档路径</th>
                  <th>状态</th>
                  <th>导入选择</th>
                </tr>
              </thead>
              <tbody>
                {photos.map((photo) => (
                  <tr
                    key={photo.id}
                    className={photo.excluded ? "excluded" : ""}
                  >
                    <td>
                      <strong>{photo.original_path}</strong>
                      <span>
                        {photo.capture_date ?? "未知拍摄日期"} ·{" "}
                        {photo.files
                          .filter((f) => f.kind === "raw" || f.kind === "jpg")
                          .map((f) => f.kind.toUpperCase())
                          .join(" + ")}
                      </span>
                      {photo.files.filter(
                        (f) => f.kind === "raw" || f.kind === "jpg",
                      ).length === 1 && (
                        <small>缺少配对文件，仍可单独导入</small>
                      )}
                    </td>
                    <td>
                      {photo.files.map((file) => (
                        <div className="photo-planned-file" key={file.id}>
                          <span className={file.verified ? "verified" : ""}>
                            {file.verified && <Check size={12} />}
                            {file.kind.toUpperCase()}
                          </span>
                          <code>
                            {paths.data?.targets[file.id] ?? file.path}
                          </code>
                          {file.error && (
                            <small className="form-error">{file.error}</small>
                          )}
                        </div>
                      ))}
                    </td>
                    <td>
                      <span
                        className={
                          stateOf(photo) === "已归档" ? "verified" : ""
                        }
                      >
                        {stateOf(photo)}
                      </span>
                      {photo.issues.map((issue) => (
                        <small className="form-error" key={issue}>
                          {issue}
                        </small>
                      ))}
                    </td>
                    <td>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            photoApi.exclude(
                              session.id,
                              photo.id,
                              !photo.excluded,
                            ),
                          )
                        }
                      >
                        {photo.excluded ? "恢复导入" : "排除"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {dialog && (
        <PhotoImportDialog
          preset={catalog?.preset ?? null}
          volumes={volumes}
          onClose={() => setDialog(false)}
          onPlanned={(id) => {
            setDialog(false);
            setSelected(id);
            void refresh();
          }}
          onPicked={() =>
            void client.invalidateQueries({ queryKey: ["volumes"] })
          }
        />
      )}
    </section>
  );
}
