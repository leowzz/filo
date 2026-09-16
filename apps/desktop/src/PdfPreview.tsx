import { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, type RenderTask } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { errorMessage } from "./api";
GlobalWorkerOptions.workerSrc = pdfWorker;
export default function PdfPreview({ content }: { content: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [number, setNumber] = useState(1);
  const [pages, setPages] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    let rendering: RenderTask | undefined;
    const task = getDocument({
      data: Uint8Array.from(atob(content), (c) => c.charCodeAt(0)),
      disableAutoFetch: true,
    });
    void task.promise
      .then(async (doc) => {
        if (stopped) return;
        setPages(doc.numPages);
        const page = await doc.getPage(number);
        if (stopped || !canvas.current) return;
        const viewport = page.getViewport({
          scale: Math.min(1.3, 740 / page.getViewport({ scale: 1 }).width),
        });
        canvas.current.width = viewport.width;
        canvas.current.height = viewport.height;
        rendering = page.render({ canvas: canvas.current, viewport });
        await rendering.promise;
      })
      .catch((e) => {
        if (!stopped) setError(errorMessage(e));
      });
    return () => {
      stopped = true;
      rendering?.cancel();
      void task.destroy();
    };
  }, [content, number]);
  return (
    <>
      <div className="preview-pages">
        <button disabled={number <= 1} onClick={() => setNumber(number - 1)}>
          上一页
        </button>
        <span>
          {number} / {pages || "…"}
        </span>
        <button
          disabled={number >= pages}
          onClick={() => setNumber(number + 1)}
        >
          下一页
        </button>
      </div>
      {error ? (
        <p role="alert">PDF 预览失败：{error}</p>
      ) : (
        <canvas ref={canvas} className="pdf-preview" />
      )}
    </>
  );
}
