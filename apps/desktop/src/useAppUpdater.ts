import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, desktop } from "./api";
import { activeTransfer } from "./types";
import { version as previewVersion } from "../package.json";

type Phase =
  | "idle"
  | "checking"
  | "available"
  | "current"
  | "downloading"
  | "installing"
  | "restart"
  | "error";

export function useAppUpdater() {
  const enabled = desktop && !import.meta.env.DEV;
  const [version, setVersion] = useState(previewVersion);
  const [phase, setPhase] = useState<Phase>("idle");
  const [availableVersion, setAvailableVersion] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<number>();
  const update = useRef<Update | null>(null);
  const downloadedUpdate = useRef(false);
  const working = useRef(false);
  const generation = useRef(0);

  const checkForUpdate = useCallback(async () => {
    if (!enabled || working.current) return;
    working.current = true;
    const id = ++generation.current;
    setPhase("checking");
    setError("");
    try {
      const found = await check({ timeout: 15_000 });
      if (generation.current !== id) {
        await found?.close();
        return;
      }
      await update.current?.close();
      update.current = found;
      downloadedUpdate.current = false;
      setAvailableVersion(found?.version ?? "");
      setPhase(found ? "available" : "current");
    } catch (cause) {
      if (generation.current !== id) return;
      console.error("Update check failed", cause);
      setError("暂时无法检查更新，请稍后重试。");
      setPhase("error");
    } finally {
      if (generation.current === id) working.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    if (desktop) void getVersion().then(setVersion).catch(console.error);
    // Give initial storage loading priority; development never contacts releases.
    const timer = window.setTimeout(() => void checkForUpdate(), 5_000);
    return () => {
      window.clearTimeout(timer);
      generation.current++;
      working.current = false;
      void update.current?.close();
      update.current = null;
    };
  }, [checkForUpdate]);

  const install = async () => {
    if (!update.current || working.current) return;
    working.current = true;
    setPhase("downloading");
    setProgress(undefined);
    setError("");
    try {
      const ensureIdle = async () => {
        if ((await api.transfers()).some(activeTransfer)) {
          throw new Error("请等待传输完成，或取消传输后再安装更新。");
        }
      };
      await ensureIdle();
      let downloaded = 0;
      let total: number | undefined;
      if (!downloadedUpdate.current)
        await update.current.download(
          (event) => {
            if (event.event === "Started") total = event.data.contentLength;
            if (event.event === "Progress") {
              downloaded += event.data.chunkLength;
              if (total)
                setProgress(
                  Math.min(100, Math.round((downloaded / total) * 100)),
                );
            }
          },
          { timeout: 120_000 },
        );
      downloadedUpdate.current = true;
      await ensureIdle();
      setPhase("installing");
      await update.current.install();
      downloadedUpdate.current = false;
      setPhase("restart");
      await relaunch();
    } catch (cause) {
      console.error("Update installation failed", cause);
      const message =
        cause instanceof Error && cause.message.startsWith("请等待传输")
          ? cause.message
          : "更新未完成，请重试或手动安装新版本。";
      setError(message);
      // Keep the update resource available for retry; never report failure as latest.
      setPhase((current) => (current === "restart" ? "restart" : "available"));
    } finally {
      working.current = false;
    }
  };

  return {
    enabled,
    version,
    phase,
    availableVersion,
    error,
    progress,
    check: checkForUpdate,
    install,
    restart: () =>
      relaunch().catch(() => setError("无法自动重启，请退出并重新打开 Filo。")),
    busy: phase === "downloading" || phase === "installing",
  };
}

export type AppUpdater = ReturnType<typeof useAppUpdater>;
