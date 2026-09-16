import { useEffect, useLayoutEffect, useRef } from "react";
import {
  Copy,
  ExternalLink,
  FolderInput,
  Info,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import {
  isDirectory,
  type DeleteMode,
  type Entry,
  type TransferKind,
  type Volume,
} from "./types";

export function EntryMenu({
  entry,
  entries,
  volume,
  position,
  onClose,
  onOpen,
  onDetails,
  onRename,
  onTransfer,
  onDelete,
}: {
  entry: Entry;
  entries: Entry[];
  volume: Volume;
  position: { x: number; y: number; trigger: HTMLElement };
  onClose: () => void;
  onOpen: () => void;
  onDetails: () => void;
  onRename: () => void;
  onTransfer: (kind: TransferKind) => void;
  onDelete: (mode: DeleteMode) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current)
      ref.current.style.top = `${Math.max(8, Math.min(position.y, window.innerHeight - ref.current.offsetHeight - 8))}px`;
  }, [position]);
  useEffect(() => {
    ref.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target))
        onClose();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        onClose();
        position.trigger.focus();
      }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const buttons = Array.from(
          ref.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) ?? [],
        );
        const index = buttons.findIndex(
          (button) => button === document.activeElement,
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  buttons.length) %
                buttons.length;
        buttons[next]?.focus();
      }
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("keydown", keydown);
    };
  }, [onClose, position]);
  const perform = (action: () => void) => {
    onClose();
    action();
  };
  const canOpen =
    entries.length === 1 &&
    (isDirectory(entry) ||
      (entry.kind === "file" && volume.capabilities.native_open));
  const canOperate =
    entries.length > 0 && entries.every((item) => item.kind !== "symlink");
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={
        entries.length > 1
          ? `${entries.length} 项操作菜单`
          : `${entry.name} 操作菜单`
      }
      className="entry-menu"
      style={{
        left: Math.max(8, Math.min(position.x, window.innerWidth - 208)),
        top: position.y,
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        role="menuitem"
        disabled={!canOpen}
        onClick={() => perform(onOpen)}
      >
        <ExternalLink size={14} />
        {isDirectory(entry) ? "打开文件夹" : "打开"}
      </button>
      <button
        role="menuitem"
        disabled={entries.length !== 1}
        onClick={() => perform(onDetails)}
      >
        <Info size={14} />
        显示简介
      </button>
      {canOperate && (
        <>
          <div className="menu-separator" />
          <button
            role="menuitem"
            onClick={() => perform(() => onTransfer("copy"))}
          >
            <Copy size={14} />
            复制到…
          </button>
          <button
            role="menuitem"
            disabled={volume.read_only}
            onClick={() => perform(() => onTransfer("move"))}
          >
            <FolderInput size={14} />
            移动到…
          </button>
          <button
            role="menuitem"
            disabled={
              entries.length !== 1 ||
              volume.capabilities.rename === "unsupported"
            }
            onClick={() => perform(onRename)}
          >
            <Pencil size={14} />
            重命名
          </button>
        </>
      )}
      {canOperate && (
        <>
          <div className="menu-separator" />
          <button
            role="menuitem"
            disabled={!volume.capabilities.delete}
            onClick={() => perform(() => onDelete("default"))}
          >
            <Trash2 size={14} />
            {volume.capabilities.trash ? "移入回收站…" : "删除…"}
          </button>
          <button
            role="menuitem"
            className="danger-text"
            disabled={!volume.capabilities.delete}
            onClick={() => perform(() => onDelete("permanent"))}
          >
            <X size={14} />
            永久删除…
          </button>
        </>
      )}
    </div>
  );
}
