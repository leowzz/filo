import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { api, desktop, errorMessage } from "./api";
import { formatSize } from "./components";
import type { PreviewCacheSettings } from "./types";

const cacheKey = ["preview-cache"];
const gb = 1024 ** 3;

export function PreviewCacheSettingsCard() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: cacheKey, queryFn: api.previewCache });
  const save = useMutation({
    mutationFn: api.savePreviewCacheSettings,
    onSuccess: (info) => client.setQueryData(cacheKey, info),
  });
  const clear = useMutation({
    mutationFn: api.clearPreviewCache,
    onSuccess: (info) => client.setQueryData(cacheKey, info),
  });
  const open = useMutation({ mutationFn: api.openPreviewCacheDirectory });
  const pending = save.isPending || clear.isPending || open.isPending;
  return (
    <section className="settings-card preview-cache-settings">
      <h2>
        <HardDrive size={19} />
        缓存设置
      </h2>
      {query.isPending && <p role="status">正在读取缓存设置…</p>}
      {query.isError && (
        <p className="error-text" role="alert">
          {errorMessage(query.error)}{" "}
          <button className="secondary" onClick={() => void query.refetch()}>
            重试
          </button>
        </p>
      )}
      {query.data && (
        <CacheForm
          key={JSON.stringify(query.data.settings)}
          initial={query.data.settings}
          pending={pending}
          saving={save.isPending}
          clearing={clear.isPending}
          opening={open.isPending}
          usedBytes={query.data.used_bytes}
          onSave={(settings) => {
            clear.reset();
            open.reset();
            save.mutate(settings);
          }}
          onChange={() => {
            save.reset();
            clear.reset();
            open.reset();
          }}
          onClear={() => {
            save.reset();
            open.reset();
            clear.mutate();
          }}
          onOpen={() => open.mutate()}
        />
      )}
      {(save.isError || clear.isError || open.isError) && (
        <p className="error-text" role="alert">
          {errorMessage(open.error ?? save.error ?? clear.error)}
        </p>
      )}
      {save.isSuccess && (
        <p className="transfer-settings-saved" role="status">
          缓存设置已保存。
        </p>
      )}
    </section>
  );
}

function CacheForm({
  initial,
  pending,
  saving,
  clearing,
  opening,
  usedBytes,
  onSave,
  onChange,
  onClear,
  onOpen,
}: {
  initial: PreviewCacheSettings;
  pending: boolean;
  saving: boolean;
  clearing: boolean;
  opening: boolean;
  usedBytes: number;
  onSave: (settings: PreviewCacheSettings) => void;
  onChange: () => void;
  onClear: () => void;
  onOpen: () => void;
}) {
  const [size, setSize] = useState(String(initial.max_bytes / gb));
  const [days, setDays] = useState(String(initial.max_age_days));
  const valid =
    size.trim() !== "" &&
    Number.isFinite(Number(size)) &&
    Number(size) >= 0.01 &&
    Number(size) <= 1024 &&
    /^\d+$/.test(days) &&
    Number(days) >= 1 &&
    Number(days) <= 3650;
  return (
    <form
      className="transfer-settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !pending)
          onSave({
            max_bytes: Math.round(Number(size) * gb),
            max_age_days: Number(days),
          });
      }}
    >
      <label htmlFor="preview-cache-size">
        <strong>磁盘空间上限</strong>
        <span className="transfer-speed-input">
          <input
            id="preview-cache-size"
            aria-label="缓存空间上限"
            type="number"
            min="0.01"
            max="1024"
            step="any"
            required
            value={size}
            disabled={pending}
            onChange={(event) => {
              setSize(event.target.value);
              onChange();
            }}
          />
          <span>GB</span>
        </span>
      </label>
      <label htmlFor="preview-cache-days">
        <strong>未访问的缓存保留</strong>
        <span className="transfer-speed-input">
          <input
            id="preview-cache-days"
            aria-label="缓存保留天数"
            type="number"
            min="1"
            max="3650"
            step="1"
            required
            value={days}
            disabled={pending}
            onChange={(event) => {
              setDays(event.target.value);
              onChange();
            }}
          />
          <span>天</span>
        </span>
      </label>
      <p className="field-help">
        缓存保存在此电脑，空间不足时优先清理最久未访问的预览。
      </p>
      <div className="settings-form-footer">
        <p>已使用 {formatSize(usedBytes)}</p>
        <div className="transfer-settings-actions">
          <button
            type="button"
            className="secondary"
            disabled={pending || !desktop}
            onClick={onOpen}
          >
            {opening && <LoaderCircle size={14} className="spin" />}
            打开缓存位置
          </button>
          <button
            type="button"
            className="secondary"
            disabled={pending || usedBytes === 0}
            onClick={onClear}
          >
            {clearing && <LoaderCircle size={14} className="spin" />}
            清空磁盘缓存
          </button>
          <button className="primary" disabled={!valid || pending}>
            {saving && <LoaderCircle size={14} className="spin" />}保存缓存设置
          </button>
        </div>
      </div>
    </form>
  );
}
