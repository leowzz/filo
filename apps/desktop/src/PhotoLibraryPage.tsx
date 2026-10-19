import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Camera,
  ChevronRight,
  Copy,
  FolderOpen,
  RefreshCw,
} from "lucide-react";
import { desktop, errorMessage } from "./api";
import { Modal } from "./components";
import {
  pickPhotoDirectory,
  reviewApi,
  type Photo,
  type PhotoCatalog,
  type PhotoDirectory,
  type PhotoHandoff,
} from "./photoApi";
import { PhotoReview } from "./PhotoReview";

function OpenReviewDialog({
  onClose,
  onOpened,
}: {
  onClose: () => void;
  onOpened: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [jpg, setJpg] = useState<PhotoDirectory | null>(null);
  const [raw, setRaw] = useState<PhotoDirectory | null>(null);
  const directory = jpg ?? raw;
  const [picking, setPicking] = useState<"jpg" | "raw" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pick = async (field: "jpg" | "raw") => {
    setPicking(field);
    setError("");
    try {
      const value = await pickPhotoDirectory(
        false,
        field === "raw" ? "选择 RAW 照片目录" : "选择照片目录（JPG / NEF）",
      );
      if (value) {
        if (field === "raw") setRaw(value);
        else setJpg(value);
        if (!name.trim())
          setName(value.path.split(/[\\/]/).filter(Boolean).pop() ?? "照片");
      }
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPicking(null);
    }
  };
  return (
    <Modal
      title="打开照片目录"
      onClose={onClose}
      busy={busy || !!picking}
      className="photo-import-dialog"
    >
      <div className="photo-import-fields">
        <label>
          审图名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy || !!picking}
          />
        </label>
        <div className="photo-directory-field">
          <span>照片目录（JPG / NEF）</span>
          <button
            className="secondary"
            disabled={busy || !!picking}
            onClick={() => void pick("jpg")}
          >
            <FolderOpen size={16} />
            <span>
              {picking === "jpg"
                ? "正在选择目录…"
                : (jpg?.path ?? "选择已有照片目录")}
            </span>
          </button>
        </div>
        <div className="photo-directory-field">
          <span>单独的 RAW 目录（可选）</span>
          <button
            className="secondary"
            disabled={busy || !!picking}
            onClick={() => void pick("raw")}
          >
            <FolderOpen size={16} />
            <span>
              {picking === "raw"
                ? "正在选择目录…"
                : (raw?.path ?? "NEF 与 JPG 分开存放时选择")}
            </span>
          </button>
          {raw && (
            <button disabled={busy || !!picking} onClick={() => setRaw(null)}>
              清除
            </button>
          )}
        </div>
        <p className="muted">
          直接审阅已有
          JPG/NEF。分别选择两个根目录时，按相同相对路径配对；同一目录可同时包含两种格式。
        </p>
        {!jpg && raw && <p className="muted">将直接审阅所选 RAW 目录。</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="modal-actions">
        <button
          className="secondary"
          disabled={busy || !!picking}
          onClick={onClose}
        >
          取消
        </button>
        <button
          className="primary"
          disabled={busy || !!picking || !directory || !name.trim()}
          onClick={() => {
            if (!directory) return;
            setBusy(true);
            setError("");
            void reviewApi
              .openLibrary(
                name,
                directory.locator,
                jpg ? (raw?.locator ?? null) : null,
              )
              .then((s) => onOpened(s.id))
              .catch((error) => setError(errorMessage(error)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "正在读取照片目录…" : "开始审图"}
        </button>
      </div>
    </Modal>
  );
}

export function PhotoLibraryPage() {
  const client = useQueryClient();
  const key = ["photo-reviews"];
  const query = useQuery({
    queryKey: key,
    queryFn: reviewApi.catalog,
    refetchOnWindowFocus: false,
  });
  const [selected, setSelected] = useState<string | null>(() =>
    sessionStorage.getItem("filo.review-session"),
  );
  const [review, setReview] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [handoff, setHandoff] = useState<PhotoHandoff | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const session = query.data?.sessions.find((s) => s.id === selected);
  const photos =
    query.data?.photos.filter((p) => session?.photo_ids.includes(p.id)) ?? [];
  useEffect(() => {
    if (selected) sessionStorage.setItem("filo.review-session", selected);
    else sessionStorage.removeItem("filo.review-session");
  }, [selected]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const refresh = useCallback(async () => {
    await client.invalidateQueries({ queryKey: ["photo-reviews"] });
  }, [client]);
  const sync = useCallback(
    async (id: string, explicit = false) => {
      setSyncing(true);
      try {
        await reviewApi.sync(id);
      } catch (error) {
        if (explicit) setError(errorMessage(error));
      } finally {
        await refresh();
        setSyncing(false);
      }
    },
    [refresh],
  );
  const scheduleSync = useCallback(() => {
    clearTimeout(timer.current);
    if (selected) timer.current = setTimeout(() => void sync(selected), 1000);
  }, [selected, sync]);
  const saved = useCallback(
    (photo: Photo) => {
      client.setQueryData<PhotoCatalog>(["photo-reviews"], (old) =>
        old
          ? {
              ...old,
              photos: old.photos.map((p) => (p.id === photo.id ? photo : p)),
              sessions: old.sessions.map((s) =>
                s.photo_ids.includes(photo.id)
                  ? { ...s, revision: s.revision + 1 }
                  : s,
              ),
            }
          : old,
      );
      scheduleSync();
    },
    [client, scheduleSync],
  );
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
  const restore = async () => {
    const jpg = await pickPhotoDirectory();
    if (!jpg) return;
    const raw = await pickPhotoDirectory();
    if (!raw) return;
    if (!(await reviewApi.restore(jpg.locator, raw.locator)))
      throw new Error("所选 RAW 目录下没有已同步的审图记录");
    setSelected(null);
  };
  const status = syncing
    ? "正在同步 NAS…"
    : session?.sync_error
      ? "NAS 同步失败"
      : session && session.revision > session.synced_revision
        ? "NAS 待同步"
        : "NAS 已同步";
  if (review && session)
    return (
      <div className="photo-review-shell">
        <div
          className={`photo-review-syncbar ${session.sync_error ? "error" : ""}`}
        >
          <span>
            {status}
            {session.sync_error && ` · ${session.sync_error}`}
          </span>
          <button
            disabled={syncing}
            onClick={() => void sync(session.id, true)}
          >
            同步到 NAS
          </button>
          {error && <span role="alert">{error}</span>}
        </div>
        <PhotoReview
          key={session.id}
          session={session}
          photos={photos}
          onSaved={saved}
          onPositionSaved={scheduleSync}
          onBack={() => {
            setReview(false);
            void refresh();
          }}
        />
      </div>
    );
  return (
    <section className="photo-workspace-body">
      <div className="photo-page-actions">
        {session ? (
          <>
            <button
              className="secondary"
              onClick={() => {
                setSelected(null);
                setHandoff(null);
              }}
            >
              <ArrowLeft size={16} />
              全部审图记录
            </button>
            <h2>{session.name}</h2>
          </>
        ) : (
          <h2>审图记录</h2>
        )}
        <div className="photo-page-action-spacer" />
        <button
          className="secondary"
          disabled={busy || !desktop}
          onClick={() => void run(restore)}
        >
          从 NAS 恢复审图
        </button>
        <button
          className="primary"
          disabled={busy || !desktop}
          onClick={() => setOpen(true)}
        >
          <FolderOpen size={16} />
          打开照片目录
        </button>
      </div>
      {error && (
        <div className="photo-notice error" role="alert">
          {error}
          <button onClick={() => setError("")}>关闭</button>
        </div>
      )}
      {query.isPending ? (
        <p>正在读取审图记录…</p>
      ) : query.isError ? (
        <div className="photo-notice error" role="alert">
          {errorMessage(query.error)}
          <button onClick={() => void query.refetch()}>重试</button>
        </div>
      ) : !session ? (
        query.data?.sessions.length ? (
          <div className="photo-session-list">
            {query.data.sessions
              .slice()
              .reverse()
              .map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    setSelected(s.id);
                    setHandoff(null);
                  }}
                >
                  <Camera size={22} />
                  <span>
                    <strong>{s.name}</strong>
                    <small>
                      {
                        query.data.photos.filter(
                          (p) => s.photo_ids.includes(p.id) && p.reviewed,
                        ).length
                      }{" "}
                      / {s.photo_ids.length} 张已审阅
                    </small>
                  </span>
                  <span className="photo-sync-status">
                    {s.sync_error
                      ? "NAS 同步失败"
                      : s.revision > s.synced_revision
                        ? "NAS 待同步"
                        : "NAS 已同步"}
                  </span>
                  <ChevronRight size={18} />
                </button>
              ))}
          </div>
        ) : (
          <div className="photo-empty">
            <Camera size={42} />
            <h3>打开照片目录，开始初选</h3>
            <p>为已有照片设置星级和旗标，再将结果交给 Lightroom Classic。</p>
            <button
              className="primary"
              disabled={!desktop}
              onClick={() => setOpen(true)}
            >
              打开照片目录
            </button>
          </div>
        )
      ) : (
        <>
          <div className="photo-session-toolbar">
            <span
              className={`photo-sync-status ${session.sync_error ? "error" : ""}`}
            >
              {status}
            </span>
            <button
              className="secondary"
              disabled={busy || syncing}
              onClick={() => void sync(session.id, true)}
            >
              <RefreshCw size={15} />
              同步到 NAS
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setHandoff(await reviewApi.prepare(session.id));
                  await sync(session.id);
                })
              }
            >
              准备 LRC 导入
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => setReview(true)}
            >
              继续审图
            </button>
          </div>
          {session.sync_error && (
            <div className="photo-notice error">{session.sync_error}</div>
          )}
          <div className="photo-review-summary">
            <strong>
              {photos.filter((p) => p.reviewed).length} / {photos.length}
            </strong>
            <span>张已审阅</span>
            <span>{photos.filter((p) => p.flag === "pick").length} 张保留</span>
            <span>
              {photos.filter((p) => p.flag === "reject").length}{" "}
              张待删除（仅旗标）
            </span>
          </div>
          {handoff && (
            <div className="photo-handoff">
              <h3>
                {handoff.failures.length
                  ? "部分 XMP 未能写出"
                  : handoff.directories.length
                    ? "XMP 已准备完成"
                    : "此目录没有可交接的 RAW"}
              </h3>
              <p>
                在 Lightroom Classic 中使用 Add
                添加以下目录，原片保留在原位置。目录可能包含其他照片，请在 LRC
                中选择所需内容。catalog 请保存在本机。
              </p>
              {handoff.jpg_only > 0 && (
                <p>{handoff.jpg_only} 张只有 JPG，本次不写入 JPG 元数据。</p>
              )}
              {handoff.directories.map((directory) => (
                <div key={directory} className="photo-handoff-directory">
                  <code>{directory}</code>
                  <button
                    aria-label={`复制 ${directory}`}
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(directory)
                        .catch((error) => setError(errorMessage(error)))
                    }
                  >
                    <Copy size={15} />
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      void reviewApi
                        .open(session.id, directory)
                        .catch((error) => setError(errorMessage(error)))
                    }
                  >
                    <FolderOpen size={15} />
                    打开目录
                  </button>
                </div>
              ))}
              {handoff.failures.map((f) => (
                <p className="form-error" key={f}>
                  {f}
                </p>
              ))}
              {handoff.directories.length > 0 && (
                <button
                  className="secondary"
                  onClick={() =>
                    void reviewApi
                      .launch()
                      .catch((error) => setError(errorMessage(error)))
                  }
                >
                  启动 Lightroom Classic
                </button>
              )}
              <p className="muted">
                准备完成和启动程序都不代表已加入 LRC catalog。旗标需要 LRC 13.2
                或更新版本，请先用少量照片确认兼容性。
              </p>
            </div>
          )}
        </>
      )}
      {open && (
        <OpenReviewDialog
          onClose={() => setOpen(false)}
          onOpened={(id) => {
            setOpen(false);
            setSelected(id);
            setReview(true);
            setHandoff(null);
            void refresh();
            void client.invalidateQueries({ queryKey: ["volumes"] });
          }}
        />
      )}
    </section>
  );
}
