import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownUp,
  CircleCheck,
  CircleX,
  LoaderCircle,
  X,
} from "lucide-react";
import { api, errorMessage } from "./api";
import { formatDate, formatSize } from "./components";
import {
  activeTransfer,
  type TransferJob,
  type Volume,
  type Locator,
} from "./types";

const labels: Record<TransferJob["state"], string> = {
  queued: "等待中",
  running: "传输中",
  verifying: "校验中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

export function TransfersPage({ volumes }: { volumes: Volume[] }) {
  const client = useQueryClient();
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
  const locationName = (locator: Locator) =>
    `${volumes.find((volume) => volume.id === locator.volume_id)?.name ?? "已移除的位置"} / ${locator.logical_path}`;
  return (
    <div className="page-scroll simple-page transfers-page">
      <h1>传输任务</h1>
      <p className="muted">本地文件复制与移动 · 最近 200 项任务</p>
      {(query.isError || cancel.isError) && (
        <p className="error-text" role="alert">
          {errorMessage(query.error ?? cancel.error)}
          <button className="secondary" onClick={() => void query.refetch()}>
            刷新
          </button>
        </p>
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
        {query.data?.map((job) => {
          const percent =
            job.state === "completed"
              ? 100
              : job.bytes_total
                ? Math.min(100, (job.bytes_transferred / job.bytes_total) * 100)
                : 0;
          return (
            <article key={job.id} className="transfer-item">
              <div className="transfer-heading">
                {activeTransfer(job) ? (
                  <LoaderCircle size={18} className="spin" />
                ) : job.state === "completed" ? (
                  <CircleCheck size={18} />
                ) : (
                  <CircleX size={18} />
                )}
                <strong>
                  {job.kind === "copy" ? "复制" : "移动"} ·{" "}
                  {job.source.logical_path.split("/").at(-1)}
                </strong>
                <span className={`transfer-state ${job.state}`}>
                  {labels[job.state]}
                </span>
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
              <p className="transfer-path" title={locationName(job.source)}>
                从 {locationName(job.source)}
              </p>
              <p
                className="transfer-path"
                title={locationName(job.destination)}
              >
                到 {locationName(job.destination)}
              </p>
              <progress max={100} value={percent} aria-label="传输进度" />
              <div className="transfer-meta">
                <span>
                  {formatSize(job.bytes_transferred)} /{" "}
                  {formatSize(job.bytes_total)}
                </span>
                <time>{formatDate(job.created_at)}</time>
              </div>
              {job.error_message && (
                <p
                  className={
                    job.state === "failed" ? "error-text" : "field-help"
                  }
                >
                  {job.error_message}
                </p>
              )}
              {job.state === "interrupted" && (
                <p className="field-help">
                  应用关闭时任务尚未完成。请检查目标目录后重新发起，已有文件不会被覆盖。
                </p>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
