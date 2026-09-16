import { lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal, EntryIcon } from "./components";
import { browsingApi } from "./browsingApi";
import { errorMessage } from "./api";
import type { Entry } from "./types";
const PdfPreview = lazy(() => import("./PdfPreview"));
export function PreviewDialog({
  entry,
  onClose,
}: {
  entry: Entry;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ["preview", entry.locator, entry.modified_at, entry.etag],
    queryFn: () => browsingApi.preview(entry.locator),
    retry: false,
    gcTime: 0,
  });
  return (
    <Modal
      className="preview-modal"
      title={`预览 · ${entry.name}`}
      onClose={onClose}
    >
      <div className="preview-content">
        {query.isPending && <p role="status">正在读取预览…</p>}
        {query.isError && (
          <p role="alert">
            {errorMessage(query.error)}{" "}
            <button onClick={() => void query.refetch()}>重试</button>
          </p>
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
            <pre className="text-preview">{query.data.content}</pre>
            {query.data.truncated && (
              <p>仅预览前 1 MiB，完整内容请打开或下载文件。</p>
            )}
          </>
        )}
        {query.data?.kind === "pdf" && (
          <Suspense fallback={<p>正在加载 PDF 预览…</p>}>
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
