import { formatSize } from "./components";
import { transferPercent } from "./transferPresentation";
import { activeTransfer, type TransferJob } from "./types";

export function TransferProgress({
  job,
  operation,
}: {
  job: TransferJob;
  operation?: string;
}) {
  const percent = transferPercent(job);
  if (job.state === "skipped") {
    return <p className="field-help">目标已存在，已跳过；源内容保持不变。</p>;
  }
  return (
    <div className={`transfer-progress ${job.state}`}>
      <progress
        max={100}
        value={
          job.state === "verifying"
            ? undefined
            : (percent ?? (activeTransfer(job) ? undefined : 0))
        }
        aria-label={`${job.source.logical_path.split("/").at(-1)} ${job.state === "verifying" ? "校验进度" : "传输进度"}`}
      />
      <div className="transfer-meta">
        <span>
          {operation && <>{operation} · </>}
          {formatSize(job.bytes_transferred)}
          {job.bytes_total !== null && ` / ${formatSize(job.bytes_total)}`}
        </span>
        <span className="transfer-percent">
          {job.state === "verifying"
            ? "正在校验"
            : job.state === "queued"
              ? "等待开始"
              : percent === undefined
                ? activeTransfer(job)
                  ? "正在计算大小"
                  : "—"
                : `${Math.floor(percent)}%`}
        </span>
      </div>
    </div>
  );
}
