import { activeTransfer, type TransferJob } from "./types";

export const transferStateLabels: Record<TransferJob["state"], string> = {
  queued: "等待中",
  running: "传输中",
  verifying: "校验中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
  skipped: "已跳过",
};

export function transferPercent(job: TransferJob): number | undefined {
  if (job.state === "completed") return 100;
  if (job.state === "queued") return 0;
  if (job.bytes_total === null) return undefined;
  if (job.bytes_total === 0) return job.state === "verifying" ? 100 : 0;
  return Math.max(
    0,
    Math.min(100, (job.bytes_transferred / job.bytes_total) * 100),
  );
}

export function transferSummary(jobs: TransferJob[]) {
  const active = jobs.filter(activeTransfer);
  const queued = active.filter((job) => job.state === "queued").length;
  const running = active.length - queued;
  return {
    active,
    queued,
    running,
    label: [
      running ? `${running} 项传输中` : "",
      queued ? `${queued} 项等待中` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

export function sortTransfers(jobs: TransferJob[]) {
  return [...jobs].sort(
    (a, b) =>
      Number(activeTransfer(b)) - Number(activeTransfer(a)) ||
      b.created_at.localeCompare(a.created_at) ||
      a.id.localeCompare(b.id),
  );
}

/** Keep a stable list order and ignore a delayed event from an older snapshot. */
export function updateTransfer(current: TransferJob[] = [], job: TransferJob) {
  const index = current.findIndex((item) => item.id === job.id);
  if (index < 0) return [job, ...current];
  const previous = current[index];
  if (
    previous.updated_at > job.updated_at ||
    (!activeTransfer(previous) && activeTransfer(job))
  )
    return current;
  return current.map((item) => (item.id === job.id ? job : item));
}
