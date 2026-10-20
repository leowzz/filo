import { lazy, Suspense } from "react";
import { ChevronUp, ChevronDown } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  Modal,
  EntryIcon,
  formatDate,
  formatSize,
  typeName,
} from "./components";
import { PreviewStatus } from "./PreviewStatus";
import { browsingApi } from "./browsingApi";
import { errorMessage } from "./api";
import type { Entry, ListOptions } from "./types";
import { isDirectory } from "./types";
import { TextPreview } from "./TextPreview";
import { useDirectoryQuery } from "./useDirectoryQuery";
const PdfPreview = lazy(() => import("./PdfPreview"));

function nextSibling(siblings: Entry[], current: Entry[], delta: number) {
  if (siblings.length === 0 || current.length === 0) return;
  const selected = new Set(current.map((entry) => entry.locator.logical_path));
  const indices = siblings.flatMap((entry, index) =>
    selected.has(entry.locator.logical_path) ? [index] : [],
  );
  if (indices.length === 0) return;
  const from = delta > 0 ? indices[indices.length - 1] : indices[0];
  const next = from + delta;
  if (next < 0 || next >= siblings.length) return;
  return siblings[next];
}

export function PreviewDialog({
  entries,
  siblings = entries,
  listOptions,
  onClose,
  onSelect,
}: {
  entries: Entry[];
  siblings?: Entry[];
  listOptions: ListOptions;
  onClose: () => void;
  onSelect: (entry: Entry) => void;
}) {
  const entry = entries.length === 1 ? entries[0] : undefined;
  const directory = entry ? isDirectory(entry) : false;
  const previous = nextSibling(siblings, entries, -1);
  const next = nextSibling(siblings, entries, 1);
  return (
    <Modal
      className={
        entry && !directory ? "preview-modal" : "selection-preview-modal"
      }
      title={entry ? entry.name : `${entries.length} 个项目`}
      titleContent={
        entry ? (
          <>
            <EntryIcon entry={entry} size={22} />
            <span className="preview-heading-copy">
              <span className="preview-filename">{entry.name}</span>
              <span className="preview-metadata">
                {typeName(entry)}
                {!directory && entry.size !== null
                  ? ` · ${formatSize(entry.size)}`
                  : ""}
              </span>
            </span>
          </>
        ) : undefined
      }
      headerActions={
        siblings.length > 1 ? (
          <div
            className="preview-navigation"
            role="group"
            aria-label="切换预览文件"
            onClick={(event) => event.currentTarget.closest("dialog")?.focus()}
          >
            <button
              className="icon-button"
              aria-label="上一个项目"
              title="上一个项目（↑）"
              disabled={!previous}
              onClick={() => previous && onSelect(previous)}
            >
              <ChevronUp size={18} />
            </button>
            <button
              className="icon-button"
              aria-label="下一个项目"
              title="下一个项目（↓）"
              disabled={!next}
              onClick={() => next && onSelect(next)}
            >
              <ChevronDown size={18} />
            </button>
          </div>
        ) : undefined
      }
      onClose={onClose}
      onKeyDown={(event) => {
        if (
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          event.altKey ||
          event.metaKey ||
          event.ctrlKey
        )
          return;
        if (event.key === " ") {
          if (
            event.target instanceof Element &&
            event.target.closest("input, textarea, select, [contenteditable]")
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) onClose();
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const next = nextSibling(
          siblings,
          entries,
          event.key === "ArrowDown" ? 1 : -1,
        );
        if (!next) return;
        event.preventDefault();
        event.currentTarget.focus();
        onSelect(next);
      }}
    >
      {entry ? (
        directory ? (
          <DirectoryPreview entry={entry} listOptions={listOptions} />
        ) : (
          <FilePreview entry={entry} />
        )
      ) : (
        <SelectionPreview entries={entries} />
      )}
    </Modal>
  );
}

function SelectionPreview({ entries }: { entries: Entry[] }) {
  const files = entries.filter((entry) => entry.kind === "file");
  const knownFiles = files.filter((entry) => entry.size !== null);
  const unknownCount = files.length - knownFiles.length;
  const totalSize = knownFiles.reduce(
    (total, entry) => total + (entry.size ?? 0),
    0,
  );
  return (
    <div className="preview-content">
      <dl className="selection-preview-stats">
        <div>
          <dt>文件数量</dt>
          <dd>{files.length} 个</dd>
        </div>
        <div>
          <dt>{unknownCount ? "已知文件大小" : "总占用空间"}</dt>
          <dd>
            {files.length > 0 && knownFiles.length === 0
              ? "未知"
              : formatSize(totalSize)}
          </dd>
        </div>
      </dl>
      {unknownCount > 0 && (
        <p className="modal-description">
          {unknownCount} 个文件大小未知，未计入合计。
        </p>
      )}
      {files.length < entries.length && (
        <p className="modal-description">
          另选中 {entries.length - files.length}{" "}
          个文件夹或链接，未计入文件数量和空间合计。
        </p>
      )}
    </div>
  );
}

function DirectoryPreview({
  entry,
  listOptions,
}: {
  entry: Entry;
  listOptions: ListOptions;
}) {
  const query = useDirectoryQuery(entry.locator, {
    ...listOptions,
    search: "",
    folders_only: false,
  });
  const visible = query.entries.slice(0, 12);
  return (
    <div className="preview-content directory-preview">
      <div className="directory-preview-heading">
        <EntryIcon entry={entry} size={36} />
        <div>
          <strong>{entry.name}</strong>
          <p className="modal-description">
            {query.isPending
              ? "正在读取文件夹…"
              : query.isError
                ? "无法读取文件夹"
                : !query.totalIsExact
                  ? `已加载 ${query.total} 项，打开文件夹查看全部`
                  : query.total
                    ? `${query.total} 个项目`
                    : "空文件夹"}
          </p>
        </div>
      </div>
      {query.isError && (
        <div className="preview-status" role="alert">
          <p>{errorMessage(query.error)}</p>
          <button
            className="secondary"
            type="button"
            onClick={() => void query.refetch()}
          >
            重试
          </button>
        </div>
      )}
      {visible.length > 0 && (
        <ul className="directory-preview-list">
          {visible.map((child) => (
            <li key={child.locator.logical_path}>
              <EntryIcon entry={child} />
              <span>{child.name}</span>
            </li>
          ))}
        </ul>
      )}
      {query.total > visible.length && (
        <p className="modal-description">
          仅显示部分项目，打开文件夹查看全部。
        </p>
      )}
      {entry.modified_at && (
        <p className="modal-description">
          修改时间 {formatDate(entry.modified_at)}
        </p>
      )}
    </div>
  );
}

function FilePreview({ entry }: { entry: Entry }) {
  const query = useQuery({
    queryKey: [
      "preview",
      entry.locator,
      entry.modified_at,
      entry.etag,
      entry.size,
    ],
    queryFn: () => browsingApi.preview(entry.locator),
    retry: false,
    staleTime: 30_000,
    gcTime: 30_000,
    refetchOnWindowFocus: false,
  });
  return (
    <div
      className={`preview-content file-preview-content${query.data ? ` preview-${query.data.kind}` : " is-pending"}`}
    >
      {query.isPending && <PreviewStatus message="正在读取预览…" />}
      {query.isError && (
        <PreviewStatus
          error
          message={errorMessage(query.error)}
          onRetry={() => void query.refetch()}
        />
      )}
      {query.data?.kind === "image" && (
        <img
          className="image-preview"
          src={`data:${query.data.mime};base64,${query.data.content}`}
          alt={entry.name}
        />
      )}
      {query.data?.kind === "text" && (
        <>
          <TextPreview name={entry.name} content={query.data.content} />
          {query.data.truncated && (
            <p className="preview-note">
              仅预览前 1 MiB，完整内容请打开或下载文件。
            </p>
          )}
        </>
      )}
      {query.data?.kind === "pdf" && (
        <Suspense fallback={<PreviewStatus message="正在加载 PDF 预览…" />}>
          <PdfPreview content={query.data.content} />
        </Suspense>
      )}
    </div>
  );
}
export function Thumbnail({ entry }: { entry: Entry }) {
  const image =
    entry.kind === "file" && /\.(png|jpe?g|gif|webp|nef)$/i.test(entry.name);
  const query = useQuery({
    queryKey: ["thumbnail", entry.locator, entry.modified_at, entry.etag],
    queryFn: () => browsingApi.preview(entry.locator, true),
    enabled: image,
    retry: false,
    staleTime: 60000,
    gcTime: 60000,
    refetchOnWindowFocus: false,
  });
  return query.data ? (
    <img
      className="file-thumbnail"
      alt=""
      src={`data:${query.data.mime};base64,${query.data.content}`}
    />
  ) : (
    <EntryIcon entry={entry} />
  );
}
