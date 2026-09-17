import {
  ArrowUp,
  ArrowDown,
  ChevronRight,
  CircleHelp,
  FolderOpen,
  HardDrive,
  LoaderCircle,
  MoreHorizontal,
  Upload,
} from "lucide-react";
import { Thumbnail } from "./PreviewDialog";
import { errorMessage } from "./api";
import { formatDate, formatSize, typeName } from "./components";
import { useBrowser } from "./store";
import { type Entry, type Volume } from "./types";
import { useFileSelection } from "./useFileSelection";
import { useExternalFileDrop } from "./useExternalFileDrop";
import { canWriteVolume, type ClipboardMode } from "./fileClipboard";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import type { useDirectoryQuery } from "./useDirectoryQuery";
import { useVirtualRows } from "./useVirtualRows";
import { DetailsPanel } from "./DetailsPanel";
import { StorageTypeLabel } from "./StorageProvider";

import type { EntrySort } from "./types";
import { browserRows } from "./browserRows";
import { DirectoryMenu, type MenuPosition } from "./DirectoryMenu";
export type { EntrySort } from "./types";

export function FileBrowser({
  volume,
  path,
  entries,
  entriesQuery,
  search,
  sort,
  setSort,
  selection,
  selectedEntries,
  clipboardMode,
  clipboardCount,
  clipboardPaths,
  pastePending,
  onPreview,
  onPaste,
  canPaste,
  onCreateFolder,
  onViewOptions,
  uploadPending,
  onFileDrop,
  onDropError,
  menu,
  setMenu,
  openEntry,
  showEntryMenu,
  navigate,
}: {
  volume: Volume;
  path: string;
  entries: Entry[];
  entriesQuery: ReturnType<typeof useDirectoryQuery>;
  search: string;
  sort: EntrySort;
  setSort: (sort: EntrySort) => void;
  selection: ReturnType<typeof useFileSelection>;
  selectedEntries: Entry[];
  clipboardMode: ClipboardMode | null;
  clipboardCount: number;
  clipboardPaths: Set<string>;
  pastePending: boolean;
  onPreview: () => void;
  onPaste: () => void;
  canPaste: boolean;
  onCreateFolder: () => void;
  onViewOptions: () => void;
  uploadPending: boolean;
  onFileDrop: (paths: string[]) => void;
  onDropError: (message: string) => void;
  menu: string | null;
  setMenu: (path: string | null) => void;
  openEntry: (entry: Entry) => void;
  showEntryMenu: (
    entry: Entry,
    x: number,
    y: number,
    trigger: HTMLElement,
  ) => void;
  navigate: (volumeId: string, path: string) => void;
}) {
  const state = useBrowser();
  const { selectedPaths } = selection;
  const writable = canWriteVolume(volume);
  const dropMessage = useExternalFileDrop({
    areaRef: selection.areaRef,
    readOnly: !writable,
    blockedMessage: volume.read_only
      ? "当前目录为只读，无法上传"
      : "当前目录不支持写入，无法上传",
    busy: uploadPending,
    onDrop: onFileDrop,
    onError: onDropError,
  });
  const [directoryMenu, setDirectoryMenu] = useState<MenuPosition | null>(null);
  const closeDirectoryMenu = useCallback(() => setDirectoryMenu(null), []);
  const displayRows = useMemo(
    () => browserRows(entries, state.useGroups),
    [entries, state.useGroups],
  );
  const rows = useVirtualRows(selection.areaRef, displayRows.length);
  const showDirectoryMenu = (x: number, y: number, trigger: HTMLElement) => {
    setMenu(null);
    selection.setSelection(null);
    setDirectoryMenu({ x, y, trigger });
  };
  useLayoutEffect(() => {
    selection.focusPendingRow();
  });
  useEffect(() => {
    if (
      rows.end >= displayRows.length - 10 &&
      entriesQuery.hasNextPage &&
      !entriesQuery.isFetching &&
      !entriesQuery.isError
    ) {
      void entriesQuery.fetchNextPage();
    }
  }, [
    rows.end,
    displayRows.length,
    entriesQuery.hasNextPage,
    entriesQuery.isFetching,
    entriesQuery.isError,
    entriesQuery.fetchNextPage,
  ]);
  return (
    <>
      <div className="browser-body">
        <div
          className={`file-area${dropMessage ? " file-drop-active" : ""}`}
          ref={selection.areaRef}
          tabIndex={0}
          aria-label="文件列表"
          onContextMenu={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest("[data-entry-path], thead, button, input, a")
            )
              return;
            event.preventDefault();
            showDirectoryMenu(
              event.clientX,
              event.clientY,
              event.currentTarget,
            );
          }}
          onPointerDown={(event) => {
            selection.onPointerDown(event);
            if (event.defaultPrevented) setMenu(null);
          }}
          onClickCapture={selection.onClickCapture}
          onKeyDown={(event) => {
            if (
              event.target === event.currentTarget &&
              ((event.shiftKey && event.key === "F10") ||
                event.key === "ContextMenu")
            ) {
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              showDirectoryMenu(
                rect.left + 30,
                rect.top + 40,
                event.currentTarget,
              );
              return;
            }
            if (
              event.key === " " &&
              !event.altKey &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              !event.defaultPrevented &&
              event.target instanceof HTMLElement &&
              (event.target === event.currentTarget ||
                event.target.matches("[data-entry-path]")) &&
              selectedEntries.length > 0
            ) {
              event.preventDefault();
              if (!event.repeat) onPreview();
              return;
            }
            selection.onKeyDown(event);
          }}
        >
          {entriesQuery.isPending ? (
            <div className="empty-state">
              <LoaderCircle className="spin" size={27} />
              <h3>正在读取文件</h3>
            </div>
          ) : entriesQuery.isError && entries.length === 0 ? (
            <div className="empty-state error" role="alert">
              <CircleHelp size={32} />
              <h3>暂时无法打开目录</h3>
              <p>{errorMessage(entriesQuery.error)}</p>
              <button
                className="secondary"
                onClick={() => void entriesQuery.refetch()}
              >
                重新加载
              </button>
            </div>
          ) : (
            <table className="file-table">
              <thead>
                <tr>
                  <th>
                    <button onClick={() => setSort("name")}>
                      名称 {sort === "name" && <ArrowUp size={12} />}
                    </button>
                  </th>
                  <th>
                    <button onClick={() => setSort("size")}>
                      大小 {sort === "size" && <ArrowDown size={12} />}
                    </button>
                  </th>
                  <th>种类</th>
                  <th>
                    <button onClick={() => setSort("modified")}>
                      修改时间 {sort === "modified" && <ArrowDown size={12} />}
                    </button>
                  </th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {rows.before > 0 && (
                  <tr className="virtual-spacer" aria-hidden="true">
                    <td colSpan={5} style={{ height: rows.before }} />
                  </tr>
                )}
                {displayRows.slice(rows.start, rows.end).map((row, index) => {
                  if (!row.entry)
                    return (
                      <tr className="file-group" key={`group-${row.label}`}>
                        <td colSpan={5}>{row.label}</td>
                      </tr>
                    );
                  const entry = row.entry;
                  return (
                    <tr
                      key={entry.locator.logical_path}
                      data-entry-path={entry.locator.logical_path}
                      className={`${selectedPaths.has(entry.locator.logical_path) ? "selected" : (rows.start + index) % 2 === 0 ? "stripe" : ""}${clipboardMode === "cut" && clipboardPaths.has(entry.locator.logical_path) ? " cut" : ""}`}
                      tabIndex={0}
                      aria-selected={selectedPaths.has(
                        entry.locator.logical_path,
                      )}
                      onClick={(event) => {
                        selection.select(entry.locator.logical_path, event);
                        setMenu(null);
                      }}
                      onDoubleClick={() => openEntry(entry)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        showEntryMenu(
                          entry,
                          event.clientX,
                          event.clientY,
                          event.currentTarget,
                        );
                      }}
                      onKeyDown={(event) => {
                        if (
                          (event.shiftKey && event.key === "F10") ||
                          event.key === "ContextMenu"
                        ) {
                          event.preventDefault();
                          const rect =
                            event.currentTarget.getBoundingClientRect();
                          showEntryMenu(
                            entry,
                            rect.left + 30,
                            rect.bottom,
                            event.currentTarget,
                          );
                        }
                        if (
                          event.key === "Enter" &&
                          event.target === event.currentTarget
                        )
                          openEntry(entry);
                      }}
                    >
                      <td>
                        <span className="file-name">
                          <Thumbnail entry={entry} />
                          <span title={entry.name}>{entry.name}</span>
                        </span>
                      </td>
                      <td className="mono">{formatSize(entry.size)}</td>
                      <td>{typeName(entry)}</td>
                      <td>{formatDate(entry.modified_at)}</td>
                      <td className="row-actions">
                        <button
                          className="icon-button"
                          aria-label={`${entry.name} 操作菜单`}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (menu === entry.locator.logical_path)
                              setMenu(null);
                            else {
                              const rect =
                                event.currentTarget.getBoundingClientRect();
                              showEntryMenu(
                                entry,
                                rect.right - 200,
                                rect.bottom,
                                event.currentTarget,
                              );
                            }
                          }}
                        >
                          <MoreHorizontal size={17} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {rows.after > 0 && (
                  <tr className="virtual-spacer" aria-hidden="true">
                    <td colSpan={5} style={{ height: rows.after }} />
                  </tr>
                )}
              </tbody>
            </table>
          )}
          {entriesQuery.isFetchingNextPage && (
            <p className="directory-more" role="status">
              正在加载更多…
            </p>
          )}
          {entriesQuery.isError && entries.length > 0 && (
            <div className="directory-more error-text" role="alert">
              {errorMessage(entriesQuery.error)}
              <button onClick={() => void entriesQuery.fetchNextPage()}>
                重试加载
              </button>
              <button onClick={() => void entriesQuery.refetch()}>
                刷新目录
              </button>
            </div>
          )}
          {!entriesQuery.isPending &&
            !entriesQuery.isError &&
            entries.length === 0 && (
              <div className="empty-state">
                <FolderOpen size={40} strokeWidth={1.3} />
                <h3>{search ? "没有匹配的文件" : "这里还没有可见文件"}</h3>
                <p>
                  {search
                    ? "尝试其他名称，筛选仅作用于当前目录。"
                    : "可以新建文件夹，或打开隐藏文件开关。"}
                </p>
              </div>
            )}
          {selection.rectangle && (
            <div
              className="selection-rectangle"
              aria-hidden="true"
              style={{
                left: selection.rectangle.x,
                top: selection.rectangle.y,
                width: selection.rectangle.width,
                height: selection.rectangle.height,
              }}
            />
          )}
        </div>
        {dropMessage && (
          <div className="file-drop-overlay" role="status">
            <Upload size={28} aria-hidden="true" />
            <strong>{dropMessage}</strong>
          </div>
        )}
        {state.showDetails && (
          <DetailsPanel
            volume={volume}
            path={path}
            selectedEntries={selectedEntries}
            entryCount={entriesQuery.total}
          />
        )}
      </div>
      {directoryMenu && (
        <DirectoryMenu
          position={directoryMenu}
          onClose={closeDirectoryMenu}
          canCreate={writable && volume.capabilities.create_directory}
          canPaste={canPaste}
          refreshing={entriesQuery.isFetching}
          onCreate={onCreateFolder}
          onPaste={onPaste}
          onRefresh={() => void entriesQuery.refetch()}
          onDetails={() => {
            selection.setSelection(null);
            if (!state.showDetails) state.toggleDetails();
          }}
          onOptions={onViewOptions}
        />
      )}
      <nav className="pathbar" aria-label="当前路径">
        <button
          onClick={() => navigate(volume.id, "")}
          title={
            volume.root.type === "local" ? volume.root.root_path : volume.name
          }
        >
          <HardDrive size={14} />
          {volume.name}
        </button>
        {path
          .split("/")
          .filter(Boolean)
          .map((part, i, parts) => (
            <span key={i}>
              <ChevronRight size={12} />
              <button
                onClick={() =>
                  navigate(volume.id, parts.slice(0, i + 1).join("/"))
                }
              >
                {part}
              </button>
            </span>
          ))}
      </nav>
      <footer className="statusbar">
        <span>
          {entriesQuery.hasNextPage
            ? `已加载 ${entries.length} / ${entriesQuery.total} 项 · 全选仅选择已加载项`
            : `${entriesQuery.total} 个项目`}
          {selectedEntries.length > 0
            ? ` · 已选择 ${selectedEntries.length} 项`
            : ""}
          {clipboardMode === "cut" && clipboardCount > 0 && (
            <span className="clipboard-status">
              {" "}
              · 剪切待粘贴 {clipboardCount} 项
            </span>
          )}
          {clipboardMode === "copy" && clipboardCount > 0 && (
            <span className="clipboard-status">
              {" "}
              · 已复制 {clipboardCount} 项
            </span>
          )}
        </span>
        <span>
          <span className="status-dot" />
          <StorageTypeLabel volume={volume} />
          {volume.read_only && " · 只读访问"}
          {pastePending && (
            <span className="clipboard-status pending"> · 正在粘贴</span>
          )}
          <span className="status-separator">/</span>双击打开文件或文件夹
        </span>
      </footer>
    </>
  );
}
