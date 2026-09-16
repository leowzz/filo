import {
  BrowserActionsMenu,
  useNativeBrowserMenu,
  type BrowserAction,
} from "./BrowserActionsMenu";
import { useDirectoryRefresh } from "./useDirectoryRefresh";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  FileSearch,
  FolderPlus,
  LockKeyhole,
  PanelRight,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useBrowser } from "./store";
import { TransferTasksMenu } from "./TransferTasksMenu";
import {
  isDirectory,
  type DeleteMode,
  type Entry,
  type Locator,
  type TransferKind,
  type TransferJob,
  type Volume,
} from "./types";

import type { Dialog } from "./StorageActionDialog";

export function AppHeader({
  volume,
  path,
  selected,
  selectedEntries,
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
  onPreview,
  onContentSearch,
  onManage,
  onRefresh,
  isFetching,
  transfers,
  uploadIds,
  recentUpload,
  transfersLoading,
  transfersError,
  onRetryTransfers,
}: {
  volume?: Volume;
  path: string;
  selected?: Entry;
  selectedEntries: Entry[];
  parent: Locator;
  search: string;
  setSearch: (search: string) => void;
  onStep: (direction: -1 | 1) => void;
  navigate: (volumeId: string, path: string) => void;
  openingPending: boolean;
  transferPending: boolean;
  openEntry: (entry: Entry) => void;
  openDialog: (dialog: Dialog) => void;
  setTransferDialog: (dialog: { entries: Entry[]; kind: TransferKind }) => void;
  setDeleteDialog: (dialog: { entries: Entry[]; mode: DeleteMode }) => void;
  onFileTransfer: (request: { remote: Locator; upload: boolean }) => void;
  onPreview: () => void;
  onContentSearch: () => void;
  onManage: (object: boolean) => void;
  onRefresh: () => void;
  isFetching: boolean;
  transfers: TransferJob[];
  uploadIds: Set<string>;
  recentUpload: { id: number; jobIds: string[] } | null;
  transfersLoading: boolean;
  transfersError: boolean;
  onRetryTransfers: () => void;
}) {
  const state = useBrowser();
  const canOperate =
    selectedEntries.length > 0 &&
    selectedEntries.every((entry) => entry.kind !== "symlink");
  const browsing = state.page === "browser" && !!volume;
  const refresh = useDirectoryRefresh(
    parent,
    volume?.root.type === "s3",
    browsing,
  );
  const actions: BrowserAction[] = [
    {
      id: "open",
      group: "文件",
      label: "打开",
      disabled:
        !browsing ||
        !selected ||
        selected.kind === "symlink" ||
        (!isDirectory(selected) && !volume?.capabilities.native_open) ||
        openingPending,
      run: () => selected && openEntry(selected),
    },
    {
      id: "rename",
      group: "文件",
      label: "重命名…",
      disabled:
        !browsing ||
        !selected ||
        selected.kind === "symlink" ||
        volume?.capabilities.rename === "unsupported",
      run: () => selected && openDialog({ type: "rename", entry: selected }),
    },
    {
      id: "copy",
      group: "文件",
      label: "复制到…",
      disabled: !browsing || !canOperate,
      run: () => setTransferDialog({ entries: selectedEntries, kind: "copy" }),
    },
    {
      id: "move",
      group: "文件",
      label: "移动到…",
      disabled: !browsing || !canOperate || volume?.read_only,
      run: () => setTransferDialog({ entries: selectedEntries, kind: "move" }),
    },
    {
      id: "parent",
      group: "显示",
      label: "上级目录",
      disabled: !browsing || !path,
      run: () =>
        volume && navigate(volume.id, path.split("/").slice(0, -1).join("/")),
    },
    {
      id: "hidden",
      group: "显示",
      label: "显示隐藏文件",
      disabled: !browsing,
      checked: state.showHidden,
      run: state.toggleHidden,
    },
    {
      id: "auto-refresh",
      group: "显示",
      label: `自动刷新（${volume?.root.type === "s3" ? "15" : "5"} 秒）`,
      disabled: !browsing,
      checked: refresh.enabled,
      run: () => refresh.setEnabled(!refresh.enabled),
    },
    {
      id: "object",
      group: "存储管理",
      label: "对象管理…",
      disabled:
        !browsing || volume?.root.type !== "s3" || selected?.kind !== "file",
      run: () => onManage(true),
    },
    {
      id: "bucket",
      group: "存储管理",
      label:
        path || (volume?.root.type === "s3" && volume.root.prefix)
          ? "目录版本…"
          : "Bucket 管理…",
      disabled: !browsing || volume?.root.type !== "s3",
      run: () => onManage(false),
    },
  ];
  const nativeFailed = useNativeBrowserMenu(actions);
  return (
    <>
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
              title="预览（空格）"
              aria-label="预览"
              disabled={selectedEntries.length < 2 && selected?.kind !== "file"}
              onClick={onPreview}
            >
              <Eye size={19} />
            </button>
            <button
              className="icon-button"
              title="搜索文件内容"
              aria-label="搜索文件内容"
              onClick={onContentSearch}
            >
              <FileSearch size={19} />
            </button>
            <span className="toolbar-separator" />
            {volume.root.type === "s3" && (
              <>
                <button
                  className="icon-button"
                  title="上传文件"
                  aria-label="上传文件"
                  disabled={volume.read_only || transferPending}
                  onClick={() =>
                    onFileTransfer({ remote: parent, upload: true })
                  }
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
              title={volume.capabilities.trash ? "移入回收站" : "删除"}
              aria-label={volume.capabilities.trash ? "移入回收站" : "删除"}
              disabled={!canOperate || !volume.capabilities.delete}
              onClick={() =>
                canOperate &&
                setDeleteDialog({ entries: selectedEntries, mode: "default" })
              }
            >
              <Trash2 size={18} />
            </button>
            <span className="toolbar-separator" />
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
            <BrowserActionsMenu actions={actions} nativeFailed={nativeFailed} />
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
        <TransferTasksMenu
          jobs={transfers}
          uploadIds={uploadIds}
          recentUpload={recentUpload}
          loading={transfersLoading}
          error={transfersError}
          onRetry={onRetryTransfers}
          onViewAll={() => state.setPage("transfers")}
        />
      </header>
      {browsing && refresh.error && (
        <div className="error-banner" role="alert">
          检查变化失败：{refresh.error}
          <button onClick={refresh.retry}>重试</button>
        </div>
      )}
    </>
  );
}
