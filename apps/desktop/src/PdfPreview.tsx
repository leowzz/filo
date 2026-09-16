import { useEffect, useRef, useState } from "react";
// System WebViews may lack APIs required by PDF.js's modern build.
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorker from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { errorMessage } from "./api";
GlobalWorkerOptions.workerSrc = pdfWorker;
export default function PdfPreview({ content }: { content: string }) {
  const [loaded, setLoaded] = useState<{
    content: string;
    document?: PDFDocumentProxy;
    error?: string;
  } | null>(null);
  useEffect(() => {
    let stopped = false;
    const binary = atob(content);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
    const task = getDocument({
      data,
      disableAutoFetch: true,
    });
    void task.promise
      .then((document) => {
        if (!stopped) setLoaded({ content, document });
      })
      .catch((e) => {
        if (!stopped) setLoaded({ content, error: errorMessage(e) });
      });
    return () => {
      stopped = true;
      void task.destroy();
    };
  }, [content]);
  if (loaded?.content !== content)
    return <p role="status">正在加载 PDF 预览…</p>;
  if (loaded.error) return <p role="alert">PDF 预览失败：{loaded.error}</p>;
  return loaded.document ? <PdfPages document={loaded.document} /> : null;
}

function PdfPages({ document }: { document: PDFDocumentProxy }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [number, setNumber] = useState(1);
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    let rendering: RenderTask | undefined;
    // Each page owns its canvas so cancelled renders cannot race the next page.
    const target = canvas.current;
    void document
      .getPage(number)
      .then(async (page) => {
        if (stopped || !target) return;
        const viewport = page.getViewport({
          scale: Math.min(1.3, 740 / page.getViewport({ scale: 1 }).width),
        });
        target.width = viewport.width;
        target.height = viewport.height;
        rendering = page.render({ canvas: target, viewport });
        await rendering.promise;
      })
      .catch((e) => {
        if (!stopped) setError(errorMessage(e));
      });
    return () => {
      stopped = true;
      rendering?.cancel();
    };
  }, [document, number]);
  return (
    <>
      <div className="preview-pages">
        <button disabled={number <= 1} onClick={() => setNumber(number - 1)}>
          上一页
        </button>
        <span>
          {number} / {document.numPages}
        </span>
        <button
          disabled={number >= document.numPages}
          onClick={() => setNumber(number + 1)}
        >
          下一页
        </button>
      </div>
      {error ? (
        <p role="alert">PDF 预览失败：{error}</p>
      ) : (
        <canvas key={number} ref={canvas} className="pdf-preview" />
      )}
    </>
  );
}
