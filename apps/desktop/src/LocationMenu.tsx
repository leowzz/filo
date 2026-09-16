import { useEffect, useRef } from "react";
import { Pencil, Unplug } from "lucide-react";
import type { Volume } from "./types";

export type LocationMenuTarget = {
  volume: Volume;
  x: number;
  y: number;
  trigger: HTMLElement;
};

export function LocationMenu({
  target,
  onEdit,
  onRemove,
  onClose,
}: {
  target: LocationMenuTarget;
  onEdit: (volume: Volume) => void;
  onRemove: (volume: Volume) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target))
        onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        onClose();
        target.trigger.focus();
      }
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", escape);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose, target]);
  return (
    <div
      ref={ref}
      className="location-context-menu"
      role="menu"
      aria-label={`${target.volume.name} 连接菜单`}
      style={{
        left: Math.max(8, Math.min(target.x, window.innerWidth - 200)),
        top: Math.max(8, Math.min(target.y, window.innerHeight - 120)),
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="location-menu-name">{target.volume.name}</div>
      <button role="menuitem" onClick={() => onEdit(target.volume)}>
        <Pencil size={14} />
        编辑连接…
      </button>
      <button role="menuitem" onClick={() => onRemove(target.volume)}>
        <Unplug size={14} />
        移除位置…
      </button>
    </div>
  );
}
