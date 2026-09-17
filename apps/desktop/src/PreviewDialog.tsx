import { lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal, EntryIcon, formatSize } from "./components";
import { browsingApi } from "./browsingApi";
import { errorMessage } from "./api";
import type { Entry } from "./types";
import { TextPreview } from "./TextPreview";
const PdfPreview = lazy(() => import("./PdfPreview"));
export function PreviewDialog({
  entries,
  onClose,
}: {
  entries: Entry[];
  onClose: () => void;
}) {
  const entry = entries.length === 1 ? entries[0] : undefined;
  if (!entry) {
    return (
      <Modal
        className="selection-preview-modal"
        title={`预览 · ${entries.length} 个项目`}
        onClose={onClose}
      >
        <SelectionPreview entries={entries} />
      </Modal>
    );
  }
  return <FilePreview entry={entry} onClose={onClose} />;
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

function FilePreview({
  entry,
  onClose,
}: {
  entry: Entry;
  onClose: () => void;
}) {
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
  const compact = !query.data;
  return (
    <Modal
      className={
        compact ? "preview-modal preview-modal-compact" : "preview-modal"
      }
      title={`预览 · ${entry.name}`}
      onClose={onClose}
    >
      <div className="preview-content">
        {query.isPending && (
          <p className="preview-status" role="status">
            正在读取预览…
          </p>
        )}
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
              <p>仅预览前 1 MiB，完整内容请打开或下载文件。</p>
            )}
          </>
        )}
        {query.data?.kind === "pdf" && (
          <Suspense
            fallback={<p className="preview-status">正在加载 PDF 预览…</p>}
          >
            <PdfPreview content={query.data.content} />
          </Suspense>
        )}
      </div>
    </Modal>
  );
}
export function Thumbnail({ entry }: { entry: Entry }) {
  const image =
    entry.kind === "file" && /\.(png|jpe?g|gif|webp)$/i.test(entry.name);
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
      src={`data:image/png;base64,${query.data.content}`}
    />
  ) : (
    <EntryIcon entry={entry} />
  );
}
