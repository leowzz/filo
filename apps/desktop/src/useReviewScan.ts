import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./api";
import {
  reviewApi,
  type PhotoReviewInput,
  type PhotoReviewProgress,
} from "./photoApi";

export function useReviewScan() {
  const active = useRef<{
    id: string;
    cancelled: boolean;
    progress: PhotoReviewProgress | null;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<PhotoReviewProgress | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  useEffect(
    () => () => {
      const run = active.current;
      if (run && run.progress?.stage !== "saving") {
        run.cancelled = true;
        void reviewApi.cancelScan(run.id).catch(() => {});
      }
      active.current = null;
    },
    [],
  );
  const open = async (input: PhotoReviewInput) => {
    if (active.current) return null;
    const run = {
      id: crypto.randomUUID(),
      cancelled: false,
      progress: null as PhotoReviewProgress | null,
    };
    active.current = run;
    setPending(true);
    setProgress(null);
    setCancelling(false);
    setError("");
    try {
      const session = await reviewApi.scan(run.id, input, (next) => {
        if (run.cancelled) {
          void reviewApi.cancelScan(run.id).catch(() => {});
          return;
        }
        if (active.current !== run) return;
        run.progress = next;
        setProgress(next);
      });
      return run.cancelled || active.current !== run ? null : session;
    } catch (error) {
      if (!run.cancelled && active.current === run) throw error;
      return null;
    } finally {
      if (active.current === run) {
        active.current = null;
        setPending(false);
      }
    }
  };
  const cancel = useCallback(async () => {
    const run = active.current;
    if (!run || run.progress?.stage === "saving" || run.cancelled) return;
    run.cancelled = true;
    setCancelling(true);
    try {
      await reviewApi.cancelScan(run.id);
    } catch (error) {
      if (active.current === run) {
        run.cancelled = false;
        setCancelling(false);
        setError(errorMessage(error));
      }
    }
  }, []);
  useEffect(() => {
    if (!pending) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void cancel();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [pending, cancel]);
  return {
    open,
    cancel,
    pending,
    progress,
    cancelling,
    error,
    canCancel: pending && progress?.stage !== "saving" && !cancelling,
  };
}
