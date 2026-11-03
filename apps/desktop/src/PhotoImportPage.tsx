import { useEffect, useMemo, useState } from "react";
import { Check, Copy, RefreshCw, MemoryStick } from "lucide-react";
import { api, desktop, errorMessage } from "./api";
import { formatSize, Modal } from "./components";
import type { RemovableVolume } from "./types";

const settingsKey = "filo.card-copy-settings";

export type CardCopySettings = {
  sourceRelative: string;
  destination: string;
  autoPrompt: boolean;
};

const defaultSettings: CardCopySettings = {
  sourceRelative: "DCIM",
  destination: "Y:\\Camera",
  autoPrompt: true,
};

export function loadCardCopySettings(): CardCopySettings {
  if (typeof localStorage === "undefined") return defaultSettings;
  try {
    const value = JSON.parse(localStorage.getItem(settingsKey) ?? "null") as
      | Partial<CardCopySettings>
      | null;
    return {
      sourceRelative:
        typeof value?.sourceRelative === "string"
          ? value.sourceRelative
          : defaultSettings.sourceRelative,
      destination:
        typeof value?.destination === "string"
          ? value.destination
          : defaultSettings.destination,
      autoPrompt: value?.autoPrompt !== false,
    };
  } catch {
    return defaultSettings;
  }
}

function saveCardCopySettings(settings: CardCopySettings) {
  localStorage.setItem(settingsKey, JSON.stringify(settings));
}

function sourcePath(volume: RemovableVolume, relative: string) {
  const normalized = relative.trim().replaceAll("/", "\\").replace(/^\\+/, "");
  if (!normalized || /^[A-Za-z]:/.test(normalized))
    throw new Error("源目录请填写卡内相对路径，例如 DCIM");
  const parts = normalized.split("\\");
  if (parts.some((part) => part === ".." || part === "."))
    throw new Error("源目录不能包含 . 或 ..");
  return `${volume.path}${normalized}`;
}

function displaySourcePath(volume: RemovableVolume, relative: string) {
  try {
    return sourcePath(volume, relative);
  } catch {
    return "源目录配置无效";
  }
}

export function PhotoImportPage() {
  const [settings, setSettings] = useState<CardCopySettings>(loadCardCopySettings);
  const [saved, setSaved] = useState(false);
  const [volumes, setVolumes] = useState<RemovableVolume[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      setVolumes(await api.removableVolumes());
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (desktop) void refresh();
  }, []);

  const valid =
    settings.sourceRelative.trim().length > 0 &&
    settings.destination.trim().length > 0 &&
    !settings.sourceRelative.includes("..") &&
    !/^[A-Za-z]:/.test(settings.sourceRelative.trim());

  return (
    <section className="card-copy-page">
      <div className="card-copy-page-head">
        <div>
          <h2>
            <MemoryStick size={19} />
            拷卡
          </h2>
          <p>插入新卡后，按这条规则把卡内目录复制到目标目录。</p>
        </div>
        <button className="secondary" onClick={() => void refresh()} disabled={loading || !desktop}>
          <RefreshCw size={15} className={loading ? "spin" : undefined} />
          刷新设备
        </button>
      </div>

      <div className="card-copy-form">
        <label>
          <strong>卡内源目录</strong>
          <span className="field-help">相对卡根目录填写，例如 DCIM</span>
          <input
            value={settings.sourceRelative}
            onChange={(event) => {
              setSettings((old) => ({ ...old, sourceRelative: event.target.value }));
              setSaved(false);
            }}
            placeholder="DCIM"
          />
        </label>
        <label>
          <strong>目标目录</strong>
          <span className="field-help">填写本机目录，例如 Y:\\Camera</span>
          <input
            value={settings.destination}
            onChange={(event) => {
              setSettings((old) => ({ ...old, destination: event.target.value }));
              setSaved(false);
            }}
            placeholder="Y:\\Camera"
          />
        </label>
        <label className="card-copy-checkbox">
          <input
            type="checkbox"
            checked={settings.autoPrompt}
            onChange={(event) => {
              setSettings((old) => ({ ...old, autoPrompt: event.target.checked }));
              setSaved(false);
            }}
          />
          插入新设备时自动弹出拷卡提示
        </label>
        <div className="card-copy-form-actions">
          <button
            className="primary"
            disabled={!valid}
            onClick={() => {
              saveCardCopySettings(settings);
              setSaved(true);
            }}
          >
            保存规则
          </button>
          {saved && (
            <span className="card-copy-saved" role="status">
              <Check size={15} /> 已保存
            </span>
          )}
        </div>
      </div>

      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="card-copy-devices">
        <div className="card-copy-devices-head">
          <strong>当前可移动设备</strong>
          <span>按卷序列号 + 容量识别</span>
        </div>
        {!desktop ? (
          <p className="muted">设备检测只在桌面应用中可用。</p>
        ) : volumes.length === 0 ? (
          <p className="muted">当前没有检测到可移动设备。</p>
        ) : (
          volumes.map((volume) => (
            <div className="card-copy-device" key={volume.id}>
              <span className="card-copy-device-icon"><MemoryStick size={18} /></span>
              <span>
                <strong>{volume.drive_letter}:{"\\"} {volume.label || "可移动设备"}</strong>
                <small>{volume.volume_serial} · {formatSize(volume.size)} · {volume.file_system || "未知文件系统"}</small>
              </span>
              <code>{displaySourcePath(volume, settings.sourceRelative)}</code>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export function CardCopyWatcher({ onNewVolume }: { onNewVolume: (volume: RemovableVolume) => void }) {
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    let known: Set<string> | null = null;
    const poll = async () => {
      try {
        const volumes = await api.removableVolumes();
        if (cancelled) return;
        const current = new Set(volumes.map((volume) => volume.id));
        if (known) {
          const settings = loadCardCopySettings();
          if (settings.autoPrompt) {
            for (const volume of volumes) {
              if (!known.has(volume.id)) onNewVolume(volume);
            }
          }
        }
        known = current;
      } catch {
        // A disconnected card or a transient WMI failure is retried on the next poll.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [onNewVolume]);
  return null;
}

export function CardCopyPrompt({
  volume,
  onClose,
}: {
  volume: RemovableVolume;
  onClose: () => void;
}) {
  const settings = useMemo(loadCardCopySettings, [volume.id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ files: number; bytes: number } | null>(null);
  const sourceState = useMemo(() => {
    try {
      return { source: sourcePath(volume, settings.sourceRelative), error: "" };
    } catch (value) {
      return { source: "", error: errorMessage(value) };
    }
  }, [settings.sourceRelative, volume]);
  const source = sourceState.source;

  const copy = async () => {
    if (!source) return;
    setBusy(true);
    setError("");
    try {
      setResult(await api.copyLocalDirectory(source, settings.destination));
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="检测到新设备" onClose={onClose} busy={busy} className="card-copy-prompt">
      <div className="card-copy-prompt-body">
        <div className="card-copy-prompt-device">
          <MemoryStick size={24} />
          <div>
            <strong>{volume.drive_letter}:{"\\"} {volume.label || "可移动设备"}</strong>
            <span>{volume.volume_serial} · {formatSize(volume.size)}</span>
          </div>
        </div>
        <div className="card-copy-route">
          <code>{source || "源目录配置无效"}</code>
          <span>→</span>
          <code>{settings.destination}</code>
        </div>
        {result && (
          <p className="card-copy-result" role="status">
            <Check size={16} /> 已复制 {result.files} 个文件（{formatSize(result.bytes)}）
          </p>
        )}
        {(error || sourceState.error) && (
          <p className="form-error" role="alert">{error || sourceState.error}</p>
        )}
      </div>
      <div className="modal-actions">
        <button className="secondary" disabled={busy} onClick={onClose}>稍后处理</button>
        {result ? (
          <button className="primary" onClick={onClose}>完成</button>
        ) : (
          <button className="primary" disabled={busy || !source} onClick={() => void copy()}>
            <Copy size={16} /> {busy ? "正在拷卡…" : "开始拷卡"}
          </button>
        )}
      </div>
    </Modal>
  );
}
