import { FloatingNotice } from "./FloatingNotice";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownUp,
  ArrowRight,
  CircleCheck,
  CircleMinus,
  CircleX,
  FileSymlink,
  FolderOpen,
  LoaderCircle,
  Play,
  RotateCw,
  X,
} from "lucide-react";
import { api, errorMessage } from "./api";
import { formatSize, Modal } from "./components";
import { TransferProgress } from "./TransferProgress";
import {
  sortTransfers,
  transferStateLabels,
  transferSummary,
  updateTransfer,
} from "./transferPresentation";
import {
  activeTransfer,
  type Volume,
  type Locator,
  type TransferJob,
  type ConflictPolicy,
} from "./types";

export function TransfersPage({
  volumes,
  onOpenDirectory,
}: {
  volumes: Volume[];
  onOpenDirectory: (job: TransferJob) => Promise<string | null | void>;
}) {
  const client = useQueryClient();
  const [retryJob, setRetryJob] = useState<TransferJob | null>(null);
  const [retryPolicy, setRetryPolicy] = useState<ConflictPolicy>("reject");
  const query = useQuery({
    queryKey: ["transfers"],
    queryFn: api.transfers,
    refetchInterval: (query) =>
      query.state.data?.some(activeTransfer) ? 1000 : false,
  });
  const cancel = useMutation({
    mutationFn: api.cancelTransfer,
    onSuccess: () => client.invalidateQueries({ queryKey: ["transfers"] }),
  });
  const opening = useMutation({
    mutationFn: async ({
      job,
      directory,
    }: {
      job: TransferJob;
      directory: boolean;
    }) =>
      (await (directory
        ? onOpenDirectory(job)
        : api.openTransferFile(job.id, false))) ?? null,
  });
  const retry = useMutation({
    mutationFn: ({
      job,
      policy,
    }: {
      job: TransferJob;
      policy: ConflictPolicy;
    }) =>
      api.retryTransfer(job.id, policy, (progress) => {
        client.setQueryData<TransferJob[]>(["transfers"], (current) =>
          updateTransfer(current, progress),
        );
        if (!activeTransfer(progress))
          void client.invalidateQueries({ queryKey: ["entries"] });
      }),
    onSuccess: (job) => {
      client.setQueryData<TransferJob[]>(["transfers"], (current) =>
        updateTransfer(current, job),
      );
      setRetryJob(null);
    },
  });
  const locationName = (locator: Locator, directory = false) => {
    const path = directory
      ? locator.logical_path.split("/").slice(0, -1).join("/")
      : locator.logical_path;
    return [
      volumes.find((volume) => volume.id === locator.volume_id)?.name ??
        "所选文件或已移除的位置",
      path,
    ]
      .filter(Boolean)
      .join(" / ");
  };
  const summary = transferSummary(query.data ?? []);
  return (
    <div className="page-scroll simple-page transfers-page">
      <h1>传输任务</h1>
      <p className="muted">最近 200 项任务</p>
      {summary.active.length > 0 && (
        <p className="transfer-summary" role="status">
          {summary.label}
        </p>
      )}
      {(query.isError || cancel.isError) && (
        <FloatingNotice key={errorMessage(query.error ?? cancel.error)}>
          {errorMessage(query.error ?? cancel.error)}
          <button className="secondary" onClick={() => void query.refetch()}>
            刷新
          </button>
        </FloatingNotice>
      )}
      {(opening.isError || opening.data) && (
        <FloatingNotice
          key={opening.submittedAt}
          onDismiss={() => opening.reset()}
        >
          {opening.isError ? errorMessage(opening.error) : opening.data}
        </FloatingNotice>
      )}
      {query.isPending && <p className="muted">正在读取任务…</p>}
      {query.data?.length === 0 && (
        <div className="feature-placeholder">
          <ArrowDownUp size={40} strokeWidth={1.2} />
          <h2>还没有传输任务</h2>
          <p>在文件列表选中文件，点击“复制到…”或“移动到…”开始。</p>
        </div>
      )}
      <div className="transfer-list">
        {sortTransfers(query.data ?? []).map((job) => {
          const filename = job.source.logical_path.split("/").at(-1);
          const destinationName = job.destination.logical_path
            .split("/")
            .at(-1);
          const fileLocations =
            job.kind === "move"
              ? [job.destination]
              : [job.destination, job.source];
          const canOpenFile = fileLocations.some((locator) => {
            const volume = volumes.find(
              (item) => item.id === locator.volume_id,
            );
            return !volume || volume.root.type === "local";
          });
          return (
            <article
              key={job.id}
              className="transfer-item"
              data-transfer-id={job.id}
            >
              <div className="transfer-heading">
                {activeTransfer(job) ? (
                  <LoaderCircle size={18} className="spin" />
                ) : job.state === "completed" ? (
                  <CircleCheck size={18} />
                ) : job.state === "skipped" ? (
                  <CircleMinus size={18} />
                ) : (
                  <CircleX size={18} />
                )}
                <strong>
                  {job.kind === "copy" ? "复制" : "移动"} · {filename}
                </strong>
                <span className={`transfer-state ${job.state}`}>
                  {transferStateLabels[job.state]}
                </span>
                {(job.state === "failed" || job.state === "interrupted") && (
                  <div className="transfer-item-actions">
                    <button
                      className="icon-button"
                      title={job.state === "failed" ? "重试传输" : "继续传输"}
                      aria-label={
                        job.state === "failed" ? "重试传输" : "继续传输"
                      }
                      disabled={retry.isPending}
                      onClick={() => {
                        retry.reset();
                        setRetryPolicy("reject");
                        setRetryJob(job);
                      }}
                    >
                      {job.state === "failed" ? (
                        <RotateCw size={14} />
                      ) : (
                        <Play size={14} />
                      )}
                    </button>
                  </div>
                )}
                {job.state === "completed" && (
                  <div className="transfer-item-actions">
                    {canOpenFile && (
                      <button
                        className="icon-button"
                        title="打开文件"
                        aria-label="打开文件"
                        disabled={opening.isPending}
                        onClick={() =>
                          opening.mutate({ job, directory: false })
                        }
                      >
                        <FileSymlink size={14} />
                      </button>
                    )}
                    <button
                      className="icon-button"
                      title="打开所在目录"
                      aria-label="打开所在目录"
                      disabled={opening.isPending}
                      onClick={() => opening.mutate({ job, directory: true })}
                    >
                      <FolderOpen size={14} />
                    </button>
                  </div>
                )}
                {activeTransfer(job) && (
                  <button
                    className="icon-button"
                    aria-label={`取消 ${job.source.logical_path}`}
                    title="取消传输"
                    disabled={cancel.isPending}
                    onClick={() => cancel.mutate(job.id)}
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
              <div className="transfer-item-summary">
                <p className="transfer-route">
                  <span title={`从 ${locationName(job.source)}`}>
                    {locationName(job.source, true)}
                  </span>
                  <ArrowRight size={12} aria-label="到" />
                  <span title={`到 ${locationName(job.destination)}`}>
                    {locationName(
                      job.destination,
                      destinationName === filename,
                    )}
                  </span>
                </p>
                {job.state === "completed" && (
                  <span className="transfer-size">
                    {formatSize(job.bytes_total ?? job.bytes_transferred)}
                  </span>
                )}
              </div>
              {activeTransfer(job) && <TransferProgress job={job} />}
              {job.error_message && (
                <p
                  className={
                    job.state === "failed" ? "error-text" : "field-help"
                  }
                >
                  {job.error_message}
                </p>
              )}
            </article>
          );
        })}
      </div>
      {retryJob && (
        <Modal
          title={retryJob.state === "failed" ? "重试传输" : "继续传输"}
          onClose={() => setRetryJob(null)}
          busy={retry.isPending}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!retry.isPending)
                retry.mutate({ job: retryJob, policy: retryPolicy });
            }}
          >
            <p className="transfer-retry-name">
              {retryJob.source.logical_path.split("/").at(-1)}
            </p>
            <p className="field-help">
              {retryPolicy === "rename"
                ? "使用新名称重新传输，保留已有内容。"
                : "校验并跳过内容一致的完整文件，未完成的文件重新传输。"}
            </p>
            <fieldset disabled={retry.isPending}>
              <label className="field-label" htmlFor="retry-conflict-policy">
                遇到不同内容的同名项目
              </label>
              <select
                id="retry-conflict-policy"
                className="text-input"
                value={retryPolicy}
                onChange={(event) =>
                  setRetryPolicy(event.target.value as ConflictPolicy)
                }
              >
                <option value="reject">停止，保留已有内容</option>
                <option value="overwrite">覆盖同名文件</option>
                {volumes.some(
                  (volume) => volume.id === retryJob.destination.volume_id,
                ) && <option value="rename">自动改名，保留两份</option>}
              </select>
              {retryPolicy === "overwrite" && (
                <p className="delete-warning">
                  不同内容的同名文件将被替换，旧内容无法在 Filo 中撤销。
                </p>
              )}
            </fieldset>
            {retry.isError && (
              <p className="error-text" role="alert">
                {errorMessage(retry.error)}
              </p>
            )}
            <div className="modal-footer">
              <button
                type="button"
                className="secondary"
                disabled={retry.isPending}
                onClick={() => setRetryJob(null)}
              >
                取消
              </button>
              <button
                type="submit"
                className="primary"
                disabled={retry.isPending}
              >
                {retry.isPending
                  ? "正在提交…"
                  : retryJob.state === "failed"
                    ? "重试"
                    : "继续"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
