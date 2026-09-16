import { formatSize } from "./components";
import { transferPercent } from "./transferPresentation";
import { activeTransfer, type TransferJob } from "./types";

export function TransferProgress({ job }: { job: TransferJob }) {
  const percent = transferPercent(job);
  return (
    <div className={`transfer-progress ${job.state}`}>
      <progress
        max={100}
        value={percent ?? (activeTransfer(job) ? undefined : 0)}
        aria-label={`${job.source.logical_path.split("/").at(-1)} 传输进度`}
      />
      <div className="transfer-meta">
        <span>
          {formatSize(job.bytes_transferred)}
          {job.bytes_total !== null && ` / ${formatSize(job.bytes_total)}`}
        </span>
        <span className="transfer-percent">
          {job.state === "queued"
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
