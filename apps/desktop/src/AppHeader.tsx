import {
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FolderInput,
  FolderPlus,
  LockKeyhole,
  PanelRight,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useBrowser } from "./store";
import {
  isDirectory,
  type DeleteMode,
  type Entry,
  type Locator,
  type TransferKind,
  type Volume,
} from "./types";

import type { Dialog } from "./StorageActionDialog";

export function AppHeader({
  volume,
  path,
  selected,
  parent,
  search,
  setSearch,
  onStep,
  navigate,
  openingPending,
  transferPending,
  openEntry,
  openDialog,
  setTransferDialog,
  setDeleteDialog,
  onFileTransfer,
  onRefresh,
  isFetching,
}: {
  volume?: Volume;
  path: string;
  selected?: Entry;
  parent: Locator;
  search: string;
  setSearch: (search: string) => void;
  onStep: (direction: -1 | 1) => void;
  navigate: (volumeId: string, path: string) => void;
  openingPending: boolean;
  transferPending: boolean;
  openEntry: (entry: Entry) => void;
  openDialog: (dialog: Dialog) => void;
  setTransferDialog: (dialog: { entry: Entry; kind: TransferKind }) => void;
  setDeleteDialog: (dialog: { entry: Entry; mode: DeleteMode }) => void;
  onFileTransfer: (request: { remote: Locator; upload: boolean }) => void;
  onRefresh: () => void;
  isFetching: boolean;
}) {
  const state = useBrowser();
  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="topbar-title" data-tauri-drag-region>
        {state.page === "browser" && volume && (
          <div className="navigation-buttons">
            <button
              className="icon-button"
              aria-label="后退"
              title="后退"
              disabled={state.index <= 0}
              onClick={() => {
                onStep(-1);
              }}
            >
              <ChevronLeft size={23} />
            </button>
            <button
              className="icon-button"
              aria-label="前进"
              title="前进"
              disabled={state.index >= state.history.length - 1}
              onClick={() => {
                onStep(1);
              }}
            >
              <ChevronRight size={23} />
            </button>
          </div>
        )}
        <h1 data-tauri-drag-region>
          {state.page === "browser"
            ? (path.split("/").filter(Boolean).at(-1) ??
              volume?.name ??
              "存储浏览器")
            : { overview: "概览", transfers: "传输任务", settings: "设置" }[
                state.page
              ]}
        </h1>
        {state.page === "browser" && volume?.read_only && (
          <span className="readonly-label">
            <LockKeyhole size={12} />
            只读
          </span>
        )}
      </div>
      {state.page === "browser" && volume ? (
        <div className="toolbar-actions">
          <button
            className="icon-button"
            title="上级目录"
            aria-label="上级目录"
            disabled={!path}
            onClick={() =>
              navigate(volume.id, path.split("/").slice(0, -1).join("/"))
            }
          >
            <ArrowUp size={18} />
          </button>
          <button
            className="icon-button"
            title="打开"
            aria-label="打开"
            disabled={
              !selected ||
              selected.kind === "symlink" ||
              (!isDirectory(selected) && !volume.capabilities.native_open) ||
              openingPending
            }
            onClick={() => selected && openEntry(selected)}
          >
            <ExternalLink size={18} />
          </button>
          {volume.root.type === "s3" && (
            <>
              <button
                className="icon-button"
                title="上传文件"
                aria-label="上传文件"
                disabled={volume.read_only || transferPending}
                onClick={() => onFileTransfer({ remote: parent, upload: true })}
              >
                <Upload size={18} />
              </button>
              <button
                className="icon-button"
                title="下载文件"
                aria-label="下载文件"
                disabled={selected?.kind !== "file" || transferPending}
                onClick={() =>
                  selected &&
                  onFileTransfer({
                    remote: selected.locator,
                    upload: false,
                  })
                }
              >
                <Download size={18} />
              </button>
            </>
          )}
          <button
            className="icon-button"
            title="新建文件夹"
            aria-label="新建文件夹"
            disabled={!volume.capabilities.create_directory}
            onClick={() => openDialog({ type: "folder" })}
          >
            <FolderPlus size={20} />
          </button>
          <button
            className="icon-button"
            title="重命名"
            aria-label="重命名"
            disabled={
              !selected ||
              selected.kind !== "file" ||
              volume.capabilities.rename === "unsupported"
            }
            onClick={() =>
              selected && openDialog({ type: "rename", entry: selected })
            }
          >
            <Pencil size={18} />
          </button>
          <button
            className="icon-button"
            title="复制到…"
            aria-label="复制到"
            disabled={selected?.kind !== "file"}
            onClick={() =>
              selected && setTransferDialog({ entry: selected, kind: "copy" })
            }
          >
            <Copy size={18} />
          </button>
          <button
            className="icon-button"
            title="移动到…"
            aria-label="移动到"
            disabled={selected?.kind !== "file" || volume.read_only}
            onClick={() =>
              selected && setTransferDialog({ entry: selected, kind: "move" })
            }
          >
            <FolderInput size={18} />
          </button>
          <button
            className="icon-button"
            title={volume.capabilities.trash ? "移入回收站" : "删除"}
            aria-label={volume.capabilities.trash ? "移入回收站" : "删除"}
            disabled={
              !selected ||
              selected.kind === "symlink" ||
              !volume.capabilities.delete
            }
            onClick={() =>
              selected && setDeleteDialog({ entry: selected, mode: "default" })
            }
          >
            <Trash2 size={18} />
          </button>
          <span className="toolbar-separator" />
          <button
            className={`icon-button ${state.showHidden ? "on" : ""}`}
            title="显示 / 隐藏隐藏文件"
            aria-label="显示或隐藏隐藏文件"
            aria-pressed={state.showHidden}
            onClick={state.toggleHidden}
          >
            <Eye size={19} />
          </button>
          <button
            className={`icon-button ${state.showDetails ? "on" : ""}`}
            title="切换详情面板"
            aria-label="切换详情面板"
            aria-pressed={state.showDetails}
            onClick={state.toggleDetails}
          >
            <PanelRight size={19} />
          </button>
          <button
            className="icon-button"
            title="刷新"
            aria-label="刷新"
            onClick={() => void onRefresh()}
          >
            <RefreshCw size={18} className={isFetching ? "spin" : ""} />
          </button>
          <label className="search-input">
            <Search size={15} />
            <input
              aria-label="筛选当前目录"
              placeholder="搜索当前目录"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {search && (
              <button aria-label="清除筛选" onClick={() => setSearch("")}>
                <X size={12} />
              </button>
            )}
          </label>
        </div>
      ) : (
        <button
          className="icon-button"
          title="添加存储空间"
          aria-label="添加存储空间"
          onClick={() => openDialog({ type: "add" })}
        >
          <Plus size={21} />
        </button>
      )}
    </header>
  );
}
