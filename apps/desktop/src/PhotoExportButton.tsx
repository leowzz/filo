import { useRef, useState } from "react";
import { FolderOpen, FolderOutput, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "./api";
import { Modal } from "./components";
import {
  pickPhotoDirectory,
  reviewApi,
  type PhotoExport,
  type PhotoExportFilter,
  type PhotoProgress,
  type PhotoSession,
} from "./photoApi";
import {
  loadExportDirectories,
  saveExportDirectories,
  type ExportDirectories,
} from "./photoExportDirectories";

export function PhotoExportButton({
  session,
  disabled = false,
  beforeExport,
}: {
  session: PhotoSession;
  disabled?: boolean;
  beforeExport?: () => Promise<void>;
}) {
  const client = useQueryClient();
  const running = useRef(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [destinations, setDestinations] = useState(loadExportDirectories);
  const [filter, setFilter] = useState<PhotoExportFilter>({
    rating_mode: "at_least",
    rating: 3,
    flag: null,
  });
  const [progress, setProgress] = useState<PhotoProgress | null>(null);
  const [result, setResult] = useState<PhotoExport | null>(null);
  const [error, setError] = useState("");
  const selected = destinations.directories.find(
    (value) => value.path === destinations.selectedPath,
  );
  const blocked = busy || picking;
  const updateDirectories = (value: ExportDirectories) => {
    setDestinations(value);
    setResult(null);
    setError("");
    try {
      saveExportDirectories(value);
    } catch {
      setError("目录列表未能保存，重新打开后需再次选择。");
    }
  };
  const changeFilter = (value: Partial<PhotoExportFilter>) => {
    setFilter((previous) => ({ ...previous, ...value }));
    setResult(null);
    setError("");
  };
  const pick = async () => {
    if (running.current) return;
    running.current = true;
    setPicking(true);
    setError("");
    try {
      const directory = await pickPhotoDirectory(false, "选择 RAW 导出目录");
      if (!directory) return;
      const existing = destinations.directories.findIndex(
        (value) => value.path === directory.path,
      );
      const directories = [...destinations.directories];
      if (existing >= 0) directories[existing] = directory;
      else directories.push(directory);
      updateDirectories({ directories, selectedPath: directory.path });
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      running.current = false;
      setPicking(false);
    }
  };
  const start = async () => {
    if (running.current || !selected) return;
    running.current = true;
    setBusy(true);
    setError("");
    setResult(null);
    setProgress(null);
    try {
      await beforeExport?.();
      const exported = await reviewApi.export(
        session.id,
        selected.locator,
        filter,
        setProgress,
      );
      setResult(exported);
      await client.invalidateQueries({ queryKey: ["photo-reviews"] });
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <button
        className="secondary"
        disabled={disabled}
        onClick={() => {
          setResult(null);
          setError("");
          setDestinations(loadExportDirectories());
          setFilter({ rating_mode: "at_least", rating: 3, flag: null });
          setOpen(true);
        }}
      >
        <FolderOutput size={16} />
        导出到目录
      </button>
      {open && (
        <Modal
          title="导出到目录"
          onClose={() => setOpen(false)}
          busy={blocked}
          className="photo-export-dialog"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
          >
            <div className="photo-export-content">
              <fieldset className="photo-export-filters" disabled={blocked}>
                <legend>筛选 RAW</legend>
                <div className="photo-export-rating">
                  <label>
                    星级条件
                    <select
                      aria-label="星级条件"
                      value={filter.rating_mode}
                      onChange={(event) =>
                        changeFilter({
                          rating_mode: event.target
                            .value as PhotoExportFilter["rating_mode"],
                        })
                      }
                    >
                      <option value="at_least">大于等于</option>
                      <option value="exactly">等于</option>
                      <option value="at_most">小于等于</option>
                      <option value="any">不限星级</option>
                    </select>
                  </label>
                  <label>
                    星级
                    <select
                      aria-label="导出星级"
                      value={filter.rating}
                      disabled={blocked || filter.rating_mode === "any"}
                      onChange={(event) =>
                        changeFilter({ rating: Number(event.target.value) })
                      }
                    >
                      <option value={0}>未评分（0 星）</option>
                      {[1, 2, 3, 4, 5].map((rating) => (
                        <option key={rating} value={rating}>
                          {rating} 星
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label>
                  旗标
                  <select
                    aria-label="导出旗标"
                    value={filter.flag ?? "all"}
                    onChange={(event) =>
                      changeFilter({
                        flag:
                          event.target.value === "all"
                            ? null
                            : (event.target.value as PhotoExportFilter["flag"]),
                      })
                    }
                  >
                    <option value="all">不限旗标</option>
                    <option value="pick">保留</option>
                    <option value="reject">待删除</option>
                    <option value="none">无旗标</option>
                  </select>
                </label>
              </fieldset>
              <fieldset className="photo-export-directories" disabled={blocked}>
                <legend>导出目录</legend>
                {destinations.directories.map((directory) => (
                  <div className="photo-export-directory" key={directory.path}>
                    <button
                      type="button"
                      className="photo-export-directory-choice"
                      aria-pressed={directory.path === selected?.path}
                      onClick={() =>
                        updateDirectories({
                          ...destinations,
                          selectedPath: directory.path,
                        })
                      }
                    >
                      <FolderOpen size={16} />
                      <span>{directory.path}</span>
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`移除常用目录 ${directory.path}`}
                      onClick={() => {
                        const directories = destinations.directories.filter(
                          (value) => value.path !== directory.path,
                        );
                        updateDirectories({
                          directories,
                          selectedPath:
                            selected?.path === directory.path
                              ? (directories[0]?.path ?? null)
                              : destinations.selectedPath,
                        });
                      }}
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void pick()}
                >
                  <FolderOpen size={16} />
                  {picking ? "正在选择…" : "添加目录"}
                </button>
              </fieldset>
              <p className="muted">复制 RAW，保留子目录结构。</p>
              {busy && (
                <div role="status">
                  {progress ? (
                    <>
                      <p>
                        正在复制 {progress.completed} / {progress.total}
                      </p>
                      <progress
                        value={progress.completed}
                        max={progress.total}
                      />
                      <p className="photo-export-path">{progress.path}</p>
                    </>
                  ) : (
                    "正在准备导出…"
                  )}
                </div>
              )}
              {result && (
                <div role="status">
                  <p>
                    {result.failures.length
                      ? result.copied + result.skipped > 0
                        ? "部分导出完成"
                        : "导出失败"
                      : "导出完成"}
                    ：已复制 {result.copied} 个，跳过 {result.skipped}{" "}
                    个相同文件。
                  </p>
                  {result.failures.length > 0 && (
                    <details open>
                      <summary>{result.failures.length} 个文件未导出</summary>
                      {result.failures.map((failure, index) => (
                        <p className="form-error" key={index}>
                          {failure}
                        </p>
                      ))}
                    </details>
                  )}
                </div>
              )}
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
            </div>
            <div className="modal-actions">
              <button
                className="secondary"
                type="button"
                disabled={blocked}
                onClick={() => setOpen(false)}
              >
                关闭
              </button>
              <button
                className="primary"
                type="submit"
                disabled={blocked || !selected}
              >
                {busy ? "正在导出…" : result ? "再次导出" : "开始导出"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
