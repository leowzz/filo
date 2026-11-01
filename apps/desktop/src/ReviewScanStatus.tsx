import { LoaderCircle } from "lucide-react";
import type { useReviewScan } from "./useReviewScan";

export function ReviewScanStatus({
  scan,
}: {
  scan: ReturnType<typeof useReviewScan>;
}) {
  const progress = scan.progress;
  const status = !scan.pending
    ? "正在载入审图界面…"
    : !progress || progress.stage === "connecting"
      ? "正在连接照片目录…"
      : progress.stage === "listing"
        ? `正在扫描目录 · 已找到 ${progress.found} 个照片文件`
        : progress.stage === "pairing"
          ? `正在核对照片 · ${progress.completed} / ${progress.total ?? "…"}`
          : "正在保存审图进度…";
  return (
    <div className="review-scan-status">
      <LoaderCircle
        size={18}
        className="review-scan-spinner"
        aria-hidden="true"
      />
      <span role="status">
        {scan.cancelling ? "正在取消…" : status}
      </span>
      <button
        className="review-scan-cancel"
        disabled={!scan.canCancel}
        onClick={() => void scan.cancel()}
      >
        取消
      </button>
      {scan.error && (
        <p className="form-error" role="alert">
          {scan.error}
        </p>
      )}
    </div>
  );
}
