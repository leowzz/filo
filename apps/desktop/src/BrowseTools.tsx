import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { browsingApi } from "./browsingApi";
import { errorMessage } from "./api";
import type { Entry, Locator, Volume } from "./types";
export function BrowseTools({
  parent,
  volume,
  selected,
  onPreview,
  onSearch,
  onManage,
}: {
  parent: Locator;
  volume: Volume;
  selected?: Entry;
  onPreview: () => void;
  onSearch: () => void;
  onManage: (object: boolean) => void;
}) {
  const client = useQueryClient();
  const [enabled, setEnabled] = useState(true);
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
        timer = setTimeout(
          () => void poll(),
          volume.root.type === "s3" ? 15000 : 5000,
        );
    }
    if (enabled) void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [
    parent.volume_id,
    parent.logical_path,
    volume.root.type,
    client,
    enabled,
  ]);
  return (
    <div className="browse-tools">
      <button
        className="secondary"
        disabled={selected?.kind !== "file"}
        onClick={onPreview}
      >
        预览
      </button>
      <button className="secondary" onClick={onSearch}>
        搜索文件内容
      </button>
      {volume.root.type === "s3" && (
        <>
          <button
            className="secondary"
            disabled={selected?.kind !== "file"}
            onClick={() => onManage(true)}
          >
            对象管理
          </button>
          <button className="secondary" onClick={() => onManage(false)}>
            {parent.logical_path ||
            (volume.root.type === "s3" && volume.root.prefix)
              ? "目录版本"
              : "Bucket 管理"}
          </button>
        </>
      )}
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        自动刷新（{volume.root.type === "s3" ? "15" : "5"} 秒）
      </label>
      {error && (
        <span role="alert" className="error-text">
          检查变化失败：{error}{" "}
          <button
            onClick={() => {
              setEnabled(false);
              setTimeout(() => setEnabled(true), 0);
            }}
          >
            重试
          </button>
        </span>
      )}
    </div>
  );
}
