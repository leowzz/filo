import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { Modal } from "./components";
import { errorMessage } from "./api";
import {
  photoApi,
  pickPhotoDirectory,
  type PhotoDirectory,
  type PhotoPlan,
} from "./photoApi";
import type { Volume } from "./types";

export function PhotoImportDialog({
  preset,
  volumes,
  onClose,
  onPlanned,
  onPicked,
}: {
  preset: PhotoPlan | null;
  volumes: Volume[];
  onClose: () => void;
  onPlanned: (id: string) => void;
  onPicked: () => void;
}) {
  const [name, setName] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}_拍摄`;
  });
  const [cardName, setCardName] = useState(preset?.card_name || "主卡");
  const [directories, setDirectories] = useState<
    Partial<Record<"source" | "jpg" | "raw", PhotoDirectory>>
  >(() =>
    preset
      ? Object.fromEntries(
          (["source", "jpg", "raw"] as const).map((field) => {
            const volume = volumes.find(
              (v) => v.id === preset[field].volume_id,
            );
            return [
              field,
              {
                locator: preset[field],
                path:
                  volume?.root.type === "local"
                    ? volume.root.root_path
                    : "请重新选择目录",
              },
            ];
          }),
        )
      : {},
  );
  const [layout, setLayout] = useState<PhotoPlan["layout"]>(
    preset?.layout ?? "date",
  );
  const [keep, setKeep] = useState(preset?.keep_hierarchy ?? false);
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const choose = async (field: "source" | "jpg" | "raw") => {
    try {
      const value = await pickPhotoDirectory(field === "source");
      if (value) {
        setDirectories((old) => ({ ...old, [field]: value }));
        onPicked();
      }
    } catch (error) {
      setError(errorMessage(error));
    }
  };
  const submit = async () => {
    const { source, jpg, raw } = directories;
    if (!source || !jpg || !raw) return;
    setBusy(true);
    setError("");
    try {
      const session = await photoApi.plan({
        name,
        card_name: cardName,
        source: source.locator,
        jpg: jpg.locator,
        raw: raw.locator,
        layout,
        keep_hierarchy: keep,
        date_override: date || null,
      });
      onPlanned(session.id);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const presets = [
    { label: "按拍摄日期", layout: "date", keep: false },
    { label: "按日期并保留层级", layout: "date", keep: true },
    { label: "按批次并保留层级", layout: "batch", keep: true },
    { label: "保留原始目录", layout: "original", keep: true },
  ] as const;
  return (
    <Modal
      title="从存储卡导入"
      onClose={onClose}
      busy={busy}
      className="photo-import-dialog"
    >
      <div className="photo-import-fields">
        <div className="photo-two-fields">
          <label>
            拍摄批次
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            存储卡别名
            <input
              value={cardName}
              onChange={(e) => setCardName(e.target.value)}
              disabled={busy}
            />
          </label>
        </div>
        {(["source", "jpg", "raw"] as const).map((field) => (
          <div className="photo-directory-field" key={field}>
            <span>
              {field === "source"
                ? "照片来源"
                : field === "jpg"
                  ? "JPG 根目录"
                  : "RAW 根目录"}
            </span>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void choose(field)}
            >
              <FolderOpen size={16} />
              <span>{directories[field]?.path ?? "选择目录"}</span>
            </button>
          </div>
        ))}
        <p className="muted">
          RAW 目录请放在图库扫描范围之外。导入会保留存储卡上的文件。
        </p>
        <fieldset className="photo-presets">
          <legend>整理预设</legend>
          {presets.map((p) => (
            <button
              key={p.label}
              disabled={busy}
              className={
                layout === p.layout && keep === p.keep ? "selected" : ""
              }
              onClick={() => {
                setLayout(p.layout);
                setKeep(p.keep);
              }}
            >
              {p.label}
            </button>
          ))}
        </fieldset>
        <div className="photo-layout-options">
          <label>
            归档方式
            <select
              disabled={busy}
              value={layout}
              onChange={(e) => setLayout(e.target.value as PhotoPlan["layout"])}
            >
              <option value="date">拍摄日期</option>
              <option value="batch">自定义批次</option>
              <option value="original">不新增分组</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              disabled={busy}
              checked={keep}
              onChange={(e) => setKeep(e.target.checked)}
            />
            保留原始文件夹层级
          </label>
        </div>
        <label>
          缺失或冲突的拍摄日期
          <input
            type="date"
            disabled={busy}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <span className="muted">时间或相机矛盾仍需检查配对。</span>
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="modal-actions">
        <button className="secondary" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          className="primary"
          disabled={
            busy ||
            !name.trim() ||
            !directories.source ||
            !directories.jpg ||
            !directories.raw
          }
          onClick={() => void submit()}
        >
          {busy ? "正在扫描并校验来源内容…" : "扫描并预览实际路径"}
        </button>
      </div>
    </Modal>
  );
}
