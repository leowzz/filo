import { useEffect, useState } from "react";
import "highlight.js/styles/github.css";

export function TextPreview({
  name,
  content,
}: {
  name: string;
  content: string;
}) {
  const [result, setResult] = useState<{
    name: string;
    content: string;
    html: string;
  } | null>(null);

  useEffect(() => {
    // Bound generated DOM size; the full preview remains readable as plain text.
    if (!content || content.length > 200_000) return;
    let worker: Worker;
    try {
      worker = new Worker(
        new URL("./textHighlight.worker.ts", import.meta.url),
        {
          type: "module",
        },
      );
    } catch {
      return;
    }
    const timeout = window.setTimeout(() => worker.terminate(), 3_000);
    worker.onmessage = ({ data }: MessageEvent<string | null>) => {
      if (data !== null) setResult({ name, content, html: data });
      window.clearTimeout(timeout);
      worker.terminate();
    };
    worker.onerror = () => {
      window.clearTimeout(timeout);
      worker.terminate();
    };
    worker.postMessage({ name, content });
    return () => {
      window.clearTimeout(timeout);
      worker.terminate();
    };
  }, [name, content]);

  const html =
    result?.name === name && result.content === content ? result.html : null;
  return (
    <pre className="text-preview">
      {html !== null ? (
        // Only highlight.js output enters HTML; it escapes all source markup.
        <code dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <code>{content}</code>
      )}
    </pre>
  );
}
