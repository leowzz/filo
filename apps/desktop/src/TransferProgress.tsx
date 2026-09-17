import { useEffect, useRef, useState } from "react";
import { formatSize } from "./components";
import { transferPercent } from "./transferPresentation";
import { activeTransfer, type TransferJob } from "./types";

export function TransferProgress({
  job,
  operation,
  showSpeed = false,
}: {
  job: TransferJob;
  operation?: string;
  showSpeed?: boolean;
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
        {showSpeed && job.state === "running" && (
          <TransferSpeed key={job.id} bytes={job.bytes_transferred} />
        )}
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

/** Sample byte deltas over real elapsed time; waiting and verification are excluded. */
function TransferSpeed({ bytes }: { bytes: number }) {
  const latestBytes = useRef(bytes);
  const [speed, setSpeed] = useState<number | null>(null);
  useEffect(() => {
    latestBytes.current = bytes;
  }, [bytes]);
  useEffect(() => {
    let previousBytes = latestBytes.current;
    let previousTime = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const elapsed = now - previousTime;
      if (elapsed <= 0) return;
      setSpeed(
        (Math.max(0, latestBytes.current - previousBytes) * 1000) / elapsed,
      );
      previousBytes = latestBytes.current;
      previousTime = now;
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="transfer-speed" aria-label="传输速度">
      {speed === null ? "测速中…" : `${formatSize(Math.round(speed))}/s`}
    </span>
  );
}
