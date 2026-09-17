import { useEffect, useRef, useState } from "react";
import { Modal } from "./components";
import { browsingApi, type SearchState } from "./browsingApi";
import { errorMessage } from "./api";
import type { Entry, Locator } from "./types";
export function ContentSearchDialog({
  parent,
  showHidden,
  onClose,
  onPreview,
}: {
  parent: Locator;
  showHidden: boolean;
  onClose: () => void;
  onPreview: (entry: Entry, siblings: Entry[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef<string | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
      if (active.current)
        void browsingApi.searchStatus(active.current, true).catch(() => {});
    },
    [],
  );
  async function start() {
    const run = ++generation.current;
    setBusy(true);
    setError("");
    setState(null);
    try {
      if (active.current)
        await browsingApi.searchStatus(active.current, true).catch(() => {});
      const id = await browsingApi.search(parent, query, showHidden);
      if (run !== generation.current) {
        void browsingApi.searchStatus(id, true);
        return;
      }
      active.current = id;
      const poll = async () => {
        if (run !== generation.current) return;
        try {
          const next = await browsingApi.searchStatus(id);
          if (run !== generation.current) return;
          setState(next);
          if (next.done) {
            setBusy(false);
            active.current = null;
          } else setTimeout(() => void poll(), 500);
        } catch (e) {
          if (run === generation.current) {
            setError(errorMessage(e));
            setBusy(false);
          }
        }
      };
      void poll();
    } catch (e) {
      if (run === generation.current) {
        setError(errorMessage(e));
        setBusy(false);
      }
    }
  }
  return (
    <Modal className="advanced-modal" title="搜索文件内容" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <p className="field-help">
          搜索当前目录及子文件夹的文本内容，{showHidden ? "包含" : "不包含"}
          隐藏文件。S3 文件需读取内容，会产生流量。关闭窗口会停止搜索。
        </p>
        <label className="field-label" htmlFor="content-query">
          查找内容
        </label>
        <input
          id="content-query"
          className="text-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          required
          maxLength={1024}
        />
        <div className="modal-footer">
          <button className="primary" disabled={busy || !query.trim()}>
            开始搜索
          </button>
          {busy && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                if (active.current)
                  void browsingApi.searchStatus(active.current, true);
              }}
            >
              停止搜索
            </button>
          )}
        </div>
      </form>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {state && (
        <>
          <p role="status">
            {state.done
              ? state.cancelled
                ? "已停止"
                : "搜索完成"
              : "正在搜索…"}{" "}
            · 已检查 {state.scanned} 个文件 · {state.hits.length} 个匹配 · 跳过{" "}
            {state.skipped} 个无法读取或二进制文件
          </p>
          {state.limited && (
            <p>
              已达到本次上限（1,000 个结果或 100,000
              个文件/目录），请缩小目录范围。
            </p>
          )}
          {state.errors.length > 0 && (
            <details>
              <summary>部分内容未能搜索</summary>
              {state.errors.map((e, i) => (
                <p key={i}>{e}</p>
              ))}
            </details>
          )}
          <div className="content-results">
            {state.hits.map((hit) => (
              <button
                key={hit.entry.locator.logical_path}
                onClick={() =>
                  onPreview(
                    hit.entry,
                    state.hits.map((result) => result.entry),
                  )
                }
              >
                <strong>
                  {hit.entry.locator.logical_path} · 第 {hit.line} 行
                </strong>
                <span>{hit.snippet}</span>
              </button>
            ))}
            {state.done && !state.hits.length && !state.errors.length && (
              <p>没有匹配的文本内容。</p>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
