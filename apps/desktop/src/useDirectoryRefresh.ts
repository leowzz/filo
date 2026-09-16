import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { browsingApi } from "./browsingApi";
import { errorMessage } from "./api";
import type { Locator } from "./types";

export function useDirectoryRefresh(
  parent: Locator,
  remote: boolean,
  active: boolean,
) {
  const client = useQueryClient();
  const [enabled, setEnabled] = useState(true);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState("");
  const stamp = useRef<string | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    stamp.current = null;
    async function poll() {
      if (stopped) return;
      if (!document.hidden) {
        try {
          const value = await browsingApi.stamp(parent);
          if (stopped) return;
          if (stamp.current !== null && value !== stamp.current) {
            await client.invalidateQueries({
              queryKey: ["entries", parent.volume_id, parent.logical_path],
            });
            void client.invalidateQueries({ queryKey: ["thumbnail"] });
          }
          stamp.current = value;
          setError("");
        } catch (e) {
          if (!stopped) {
            setError(errorMessage(e));
            return;
          }
        }
      }
      if (!stopped)
        timer = setTimeout(() => void poll(), remote ? 15000 : 5000);
    }
    if (enabled && active) void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [
    parent.volume_id,
    parent.logical_path,
    remote,
    active,
    enabled,
    retry,
    client,
  ]);
  return {
    enabled,
    setEnabled,
    error,
    retry: () => setRetry((value) => value + 1),
  };
}
