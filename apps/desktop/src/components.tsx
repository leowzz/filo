import { useEffect, useRef, type ReactNode } from "react";
import {
  File,
  FileArchive,
  FileCode2,
  FileImage,
  FileText,
  Folder,
  Link2,
  X,
} from "lucide-react";
import type { Entry } from "./types";
import { isDirectory } from "./types";

export function EntryIcon({
  entry,
  size = 20,
}: {
  entry: Entry;
  size?: number;
}) {
  if (isDirectory(entry))
    return (
      <Folder
        size={size}
        className="folder-icon"
        fill="currentColor"
        fillOpacity="0.17"
      />
    );
  if (entry.kind === "symlink") return <Link2 size={size} className="muted" />;
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "svg", "webp", "gif", "heic"].includes(ext))
    return <FileImage size={size} className="image-icon" />;
  if (
    [
      "ts",
      "tsx",
      "rs",
      "js",
      "json",
      "py",
      "html",
      "css",
      "toml",
      "yaml",
    ].includes(ext)
  )
    return <FileCode2 size={size} className="code-icon" />;
  if (["zip", "gz", "tar", "7z"].includes(ext))
    return <FileArchive size={size} className="archive-icon" />;
  if (["md", "txt", "pdf", "docx"].includes(ext))
    return <FileText size={size} className="text-icon" />;
  return <File size={size} className="muted" />;
}
export function formatSize(size: number | null) {
  if (size === null) return "—";
  if (size < 1024) return `${size} B`;
  const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), 4);
  return `${(size / 1024 ** index).toFixed(1)} ${["B", "KB", "MB", "GB", "TB"][index]}`;
}
export function formatDate(date: string | null) {
  return date
    ? new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(date))
    : "—";
}
export function typeName(entry: Entry) {
  if (isDirectory(entry)) return "文件夹";
  if (entry.kind === "symlink") return "符号链接";
  const dot = entry.name.lastIndexOf(".");
  return dot > 0 ? `${entry.name.slice(dot + 1).toUpperCase()} 文件` : "文件";
}

export function Modal({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    const element = ref.current;
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      aria-labelledby="modal-title"
    >
      <div className="modal-head">
        <h2 id="modal-title">{title}</h2>
        <button
          className="icon-button"
          aria-label="关闭"
          disabled={busy}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
