import { LoaderCircle } from "lucide-react";
import type { useReviewScan } from "./useReviewScan";

export function ReviewScanStatus({
  scan,
}: {
  scan: ReturnType<typeof useReviewScan>;
}) {
  return (
    <div className="review-scan-status">
      <LoaderCircle
        size={18}
        className="review-scan-spinner"
        aria-hidden="true"
      />
      <span role="status">
        {scan.cancelling ? "正在取消…" : "正在打开照片…"}
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
