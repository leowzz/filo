import {
  ArrowDownUp,
  CircleCheck,
  CircleX,
  LoaderCircle,
  FileSymlink,
  FolderOpen,
  X,
} from "lucide-react";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import { activeTransfer, type TransferJob } from "./types";
import { TransferProgress } from "./TransferProgress";
import {
  sortTransfers,
  transferStateLabels,
  transferSummary,
} from "./transferPresentation";

export function TransferTasksMenu({
  jobs,
  uploadIds,
  recentTransfer,
  loading,
  error,
  onRetry,
  onViewAll,
  onOpenDirectory,
}: {
  jobs: TransferJob[];
  uploadIds: Set<string>;
  recentTransfer: { id: number; jobIds: string[] } | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onViewAll: () => void;
  onOpenDirectory: (job: TransferJob) => Promise<void>;
}) {
  const [actionError, setActionError] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  async function openResult(job: TransferJob, directory: boolean) {
    setActionError("");
    setPendingAction(job.id);
    try {
      if (directory) await onOpenDirectory(job);
      else await api.openTransferFile(job.id, false);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setPendingAction(null);
    }
  }
  const [open, setOpen] = useState(false);
  const [highlightedTransfer, setHighlightedTransfer] = useState<number | null>(
    null,
  );
  const revealedTransfer = useRef<number | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const id = useId();
  const { active, running, label: summary } = transferSummary(jobs);
  const uploading = active.filter(
    (job) => uploadIds.has(job.id) && job.state !== "queued",
  ).length;
  const label = active.length
    ? !running
      ? `等待中 ${active.length}`
      : uploading === running
        ? `上传中 ${uploading}`
        : `传输中 ${running}`
    : "传输任务";
  const recent = sortTransfers(jobs);
  const batchIds = new Set(recentTransfer?.jobIds ?? []);
  const batchJobs = recent
    .filter((job) => batchIds.has(job.id))
    .sort(
      (a, b) =>
        b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id),
    );
  const otherJobs = recent.filter((job) => !batchIds.has(job.id));
  const highlighting =
    recentTransfer !== null && highlightedTransfer === recentTransfer.id;
  const visible = [
    ...batchJobs,
    ...otherJobs.filter(activeTransfer),
    ...otherJobs.filter((job) => !activeTransfer(job)).slice(0, 3),
  ];

  useEffect(() => {
    if (!recentTransfer) return;
    if (revealedTransfer.current !== recentTransfer.id) {
      revealedTransfer.current = recentTransfer.id;
      setOpen(true);
      if (list.current) list.current.scrollTop = 0;
    }
    setHighlightedTransfer(recentTransfer.id);
    const timer = window.setTimeout(() => setHighlightedTransfer(null), 6000);
    return () => window.clearTimeout(timer);
  }, [recentTransfer]);

  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target))
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div
      className="transfer-tasks"
      ref={ref}
      onBlur={(event) => {
        // Internal text and mouse-clicked buttons in macOS WebKit can blur
        // without a new focus target. Outside pointer clicks are handled above.
        if (
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          setOpen(false);
      }}
    >
      <button
        ref={trigger}
        className={`icon-button transfer-tasks-trigger ${active.length ? "is-active" : ""} ${open ? "on" : ""} ${highlighting ? "is-highlighted" : ""}`}
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        {active.length ? (
          <LoaderCircle size={18} className="spin" />
        ) : (
          <ArrowDownUp size={18} />
        )}
        {active.length > 0 && <span>{label}</span>}
      </button>
      {open && (
        <section
          className="transfer-tasks-popover"
          id={id}
          role="dialog"
          aria-label="传输任务列表"
        >
          <div className="transfer-tasks-header">
            <h2>传输记录</h2>
            <span className="muted">
              {active.length ? summary : "最近任务"}
            </span>
            <button
              ref={closeButton}
              className="icon-button"
              aria-label="关闭任务列表"
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <X size={16} />
            </button>
          </div>
          {actionError && (
            <p className="transfer-tasks-message error-text" role="alert">
              {actionError}
            </p>
          )}
          {error && (
            <p className="transfer-tasks-message error-text" role="alert">
              无法刷新任务列表 <button onClick={onRetry}>重试</button>
            </p>
          )}
          {loading && (
            <p className="transfer-tasks-message muted">正在读取任务…</p>
          )}
          {!loading && !error && jobs.length === 0 && (
            <p className="transfer-tasks-message muted">
              暂无传输任务，上传或下载后可在这里查看进度。
            </p>
          )}
          <div className="transfer-tasks-list" ref={list}>
            {batchJobs.length > 0 && (
              <p
                className={`transfer-batch-label ${highlighting ? "is-highlighted" : ""}`}
                role="status"
              >
                本次传输 · {batchJobs.length} 项
              </p>
            )}
            {visible.map((job, index) => {
              const upload = uploadIds.has(job.id);
              const name = job.source.logical_path.split("/").at(-1);
              return (
                <Fragment key={job.id}>
                  {batchJobs.length > 0 && index === batchJobs.length && (
                    <p className="transfer-batch-label">其他任务</p>
                  )}
                  <article
                    className={`transfer-item ${highlighting && batchIds.has(job.id) ? "is-highlighted" : ""}`}
                    data-transfer-id={job.id}
                  >
                    <div className="transfer-heading">
                      {activeTransfer(job) ? (
                        <LoaderCircle size={16} className="spin" />
                      ) : job.state === "completed" ? (
                        <CircleCheck size={16} />
                      ) : (
                        <CircleX size={16} />
                      )}
                      <strong title={name}>{name}</strong>
                      <span className={`transfer-state ${job.state}`}>
                        {upload && job.state === "running"
                          ? "上传中"
                          : transferStateLabels[job.state]}
                      </span>
                    </div>
                    <TransferProgress
                      showSpeed
                      job={job}
                      operation={
                        upload ? "上传" : job.kind === "move" ? "移动" : "传输"
                      }
                    />
                    {job.state === "completed" && (
                      <div className="transfer-item-actions">
                        <button
                          disabled={pendingAction !== null}
                          onClick={() => void openResult(job, false)}
                        >
                          <FileSymlink size={14} />
                          打开文件
                        </button>
                        <button
                          disabled={pendingAction !== null}
                          onClick={() => void openResult(job, true)}
                        >
                          <FolderOpen size={14} />
                          所在目录
                        </button>
                      </div>
                    )}
                    {job.error_message && (
                      <p
                        className="error-text transfer-tasks-error"
                        title={job.error_message}
                      >
                        {job.error_message}
                      </p>
                    )}
                  </article>
                </Fragment>
              );
            })}
          </div>
          <button
            className="transfer-tasks-all"
            onClick={() => {
              setOpen(false);
              onViewAll();
            }}
          >
            查看全部任务
          </button>
        </section>
      )}
    </div>
  );
}
