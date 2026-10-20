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
import { useReviewScan } from "./useReviewScan";
import { ReviewScanStatus } from "./ReviewScanStatus";

function OpenReviewDialog({
  onClose,
  onOpened,
}: {
  onClose: () => void;
  onOpened: (id: string) => Promise<void>;
}) {
  const [directory, setDirectory] = useState<PhotoDirectory | null>(null);
  const [rawOnly, setRawOnly] = useState(false);
  const [picking, setPicking] = useState(false);
  const scan = useReviewScan();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pick = async () => {
    setPicking(true);
    setError("");
    try {
      const value = await pickPhotoDirectory(false, "选择照片目录");
      if (value) {
        setDirectory(value);
      }
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPicking(false);
    }
  };
  return (
    <Modal
      title="打开照片目录"
      onClose={busy ? () => void scan.cancel() : onClose}
      busy={(busy && !scan.canCancel) || !!picking}
      className="photo-import-dialog"
    >
      {busy ? (
        <ReviewScanStatus scan={scan} />
      ) : (
        <>
          <div className="photo-import-fields">
            <div className="photo-directory-field">
              <span>照片目录</span>
              <button
                className="secondary"
                disabled={busy || !!picking}
                onClick={() => void pick()}
              >
                <FolderOpen size={16} />
                <span>
                  {picking
                    ? "正在选择目录…"
                    : (directory?.path ?? "选择照片目录")}
                </span>
              </button>
            </div>
            <label className="photo-review-option">
              <input
                type="checkbox"
                checked={rawOnly}
                disabled={picking}
                onChange={(e) => setRawOnly(e.target.checked)}
              />
              仅查看 RAW
            </label>
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
              disabled={busy || !!picking || !directory}
              onClick={() => {
                if (!directory) return;
                setBusy(true);
                setError("");
                void scan
                  .open({
                    name: "",
                    jpg: directory.locator,
                    raw: null,
                    directory: true,
                    raw_only: rawOnly,
                  })
                  .then(async (s) => {
                    if (s) await onOpened(s.id);
                  })
                  .catch((error) => setError(errorMessage(error)))
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? "正在读取照片目录…" : "开始审图"}
            </button>
          </div>
        </>
      )}
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
  const [openingReview, setOpeningReview] = useState(false);
  const resumeScan = useReviewScan();
  const [handoff, setHandoff] = useState<PhotoHandoff | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const session = query.data?.sessions.find((s) => s.id === selected);
  const directoryReview = !!session?.directory;
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
    if (directoryReview) {
      void refresh();
      return;
    }
    if (selected) timer.current = setTimeout(() => void sync(selected), 1000);
  }, [selected, sync, directoryReview, refresh]);
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
  const startReview = async () => {
    if (!session || busy || syncing || openingReview) return;
    setOpeningReview(true);
    setError("");
    try {
      if (session.directory) {
        const reopened = await resumeScan.open({
          name: session.name,
          jpg: session.directory,
          raw: null,
          directory: true,
          raw_only: session.position.raw_only,
        });
        if (!reopened) {
          setReview(false);
          return;
        }
        await refresh();
        setSelected(reopened.id);
      }
      setReview(true);
    } catch (error) {
      setReview(false);
      setError(errorMessage(error));
    } finally {
      setOpeningReview(false);
    }
  };
  const status = session?.directory
    ? "进度保存在照片目录的 .filo 中"
    : syncing
      ? "正在同步 NAS…"
      : session?.sync_error
        ? "NAS 同步失败"
        : session && session.revision > session.synced_revision
          ? "NAS 待同步"
          : "NAS 已同步";
  if (openingReview)
    return (
      <section className="photo-workspace-body">
        <ReviewScanStatus scan={resumeScan} />
      </section>
    );
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
            {session.directory ? "保存到目录" : "同步到 NAS"}
          </button>
          {error && <span role="alert">{error}</span>}
        </div>
        <PhotoReview
          key={session.id}
          session={session}
          photos={photos}
          onSaved={saved}
          onPositionSaved={scheduleSync}
          onReload={session.directory ? startReview : undefined}
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
                    <small>{s.photo_ids.length} 张照片</small>
                  </span>
                  <span className="photo-sync-status">
                    {s.directory
                      ? "已保存到目录"
                      : s.sync_error
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
              {session.directory ? "保存到目录" : "同步到 NAS"}
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
              disabled={busy || syncing}
              onClick={() => void startReview()}
            >
              继续审图
            </button>
          </div>
          {session.sync_error && (
            <div className="photo-notice error">{session.sync_error}</div>
          )}
          <div className="photo-review-summary">
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
          onOpened={async (id) => {
            await refresh();
            setOpen(false);
            setSelected(id);
            setReview(true);
            setHandoff(null);
            void client.invalidateQueries({ queryKey: ["volumes"] });
          }}
        />
      )}
    </section>
  );
}
