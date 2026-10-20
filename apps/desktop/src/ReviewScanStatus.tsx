import type { useReviewScan } from "./useReviewScan";

export function ReviewScanStatus({
  scan,
}: {
  scan: ReturnType<typeof useReviewScan>;
}) {
  const p = scan.progress;
  const message =
    !p || p.stage === "connecting"
      ? "正在连接照片目录…"
      : p.stage === "listing"
        ? `正在列出照片 · 已发现 ${p.found} 个照片文件`
        : p.stage === "pairing"
          ? `正在整理照片 · ${p.completed} / ${p.total ?? "…"}`
          : "正在保存审图记录…";
  return (
    <div className="review-scan-status">
      <p role="status">{scan.cancelling ? "正在取消…" : message}</p>
      {p?.path && <p className="muted review-scan-path">{p.path}</p>}
      {scan.error && (
        <p className="form-error" role="alert">
          {scan.error}
        </p>
      )}
      <div className="modal-actions">
        <button
          className="secondary"
          disabled={!scan.canCancel}
          onClick={() => void scan.cancel()}
        >
          取消打开
        </button>
      </div>
    </div>
  );
}
