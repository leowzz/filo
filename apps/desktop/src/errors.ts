import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import { describeError } from "./errorDiagnostics";

type ErrorSource =
  "backend" | "script" | "promise" | "render" | "notifications";
export type AppError = {
  id: string;
  source: ErrorSource;
  location: string;
  details: string;
  count: number;
};
type BackendError = { id: string; location: string };
const seen = new Set<string>();

export const useAppErrors = create<{
  errors: AppError[];
  dismiss: () => void;
}>((set) => ({ errors: [], dismiss: () => set({ errors: [] }) }));

export function reportAppError(
  source: ErrorSource,
  location = "",
  id: string = crypto.randomUUID(),
  reason?: unknown,
) {
  if (seen.has(id)) return;
  seen.add(id);
  if (seen.size > 100) seen.delete(seen.values().next().value!);
  const details = describeError(reason);
  console.error("Filo diagnostic", { id, source, location, details });
  useAppErrors.setState(({ errors }) => {
    const previous = errors.find(
      (error) =>
        error.source === source &&
        error.location === location &&
        error.details === details,
    );
    const report = {
      id,
      source,
      location,
      details,
      count: (previous?.count ?? 0) + 1,
    };
    return {
      errors: [...errors.filter((error) => error !== previous), report].slice(
        -20,
      ),
    };
  });
}

export function installGlobalErrors() {
  const onError = (event: ErrorEvent) => {
    let file = "";
    try {
      file = new URL(event.filename).pathname.split("/").pop() ?? "";
    } catch {
      /* no source */
    }
    reportAppError(
      "script",
      file ? `${file}:${event.lineno}:${event.colno}` : "",
      undefined,
      event.error ?? event.message,
    );
  };
  const onRejection = (event: PromiseRejectionEvent) =>
    reportAppError("promise", "", undefined, event.reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  let disposed = false;
  let unlisten: UnlistenFn | undefined;
  if (isTauri()) {
    const receive = (error: BackendError) => {
      if (!disposed) reportAppError("backend", error.location, error.id);
    };
    void (async () => {
      unlisten = await listen<BackendError>("backend-error", (event) =>
        receive(event.payload),
      );
      if (disposed) {
        await unlisten();
        return;
      }
      // Subscribe first so startup reports and live events cannot fall into a gap.
      const recent = await invoke<BackendError[]>("recent_backend_errors");
      recent.forEach(receive);
    })().catch((error) => {
      if (!disposed) reportAppError("notifications", "", undefined, error);
    });
  }
  return () => {
    disposed = true;
    if (unlisten)
      void Promise.resolve()
        .then(unlisten)
        .catch(() => {});
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
