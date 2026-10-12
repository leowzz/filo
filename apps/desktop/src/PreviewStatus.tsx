import { FileWarning, LoaderCircle } from "lucide-react";

export function PreviewStatus({
  message,
  error = false,
  onRetry,
}: {
  message: string;
  error?: boolean;
  onRetry?: () => void;
}) {
  return (
    <div className="preview-status" role={error ? "alert" : "status"}>
      {error ? (
        <FileWarning size={28} strokeWidth={1.5} aria-hidden="true" />
      ) : (
        <LoaderCircle
          className="spin"
          size={24}
          strokeWidth={1.7}
          aria-hidden="true"
        />
      )}
      <p>{message}</p>
      {onRetry && (
        <button className="secondary" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}
