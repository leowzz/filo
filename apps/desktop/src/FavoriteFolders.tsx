import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Folder, X } from "lucide-react";
import {
  sameFolder,
  useFolderFavorites,
  type FolderFavorite,
} from "./folderFavorites";
import { useBrowser } from "./store";
import type { Volume } from "./types";

export function FavoriteFolders({
  volumes,
  navigate,
}: {
  volumes: Volume[];
  navigate: (volumeId: string, path: string) => void;
}) {
  const { favorites, remove, move } = useFolderFavorites();
  const state = useBrowser();
  const current = state.history[state.index];
  const list = useRef<HTMLElement>(null);
  const gesture = useRef<{
    folder: FolderFavorite;
    pointerId: number;
    x: number;
    y: number;
    active: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState<FolderFavorite | null>(null);
  const [insertion, setInsertion] = useState<number | null>(null);

  const cancelDrag = () => {
    gesture.current = null;
    setDragging(null);
    setInsertion(null);
  };
  useEffect(() => {
    if (!dragging) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelDrag();
      }
    };
    window.addEventListener("keydown", cancel);
    window.addEventListener("blur", cancelDrag);
    return () => {
      window.removeEventListener("keydown", cancel);
      window.removeEventListener("blur", cancelDrag);
    };
  }, [dragging]);

  function insertionAt(x: number, y: number) {
    const element = list.current;
    if (!element) return null;
    const bounds = element.getBoundingClientRect();
    if (
      x < bounds.left ||
      x > bounds.right ||
      y < bounds.top - 8 ||
      y > bounds.bottom + 8
    )
      return null;
    const rows = Array.from(
      element.querySelectorAll<HTMLElement>(".favorite-row"),
    );
    const index = rows.findIndex((row) => {
      const rect = row.getBoundingClientRect();
      return y < rect.top + rect.height / 2;
    });
    return index < 0 ? rows.length : index;
  }

  function pointerMove(event: PointerEvent<HTMLButtonElement>) {
    const drag = gesture.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (
      !drag.active &&
      Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6
    )
      return;
    drag.active = true;
    suppressClick.current = true;
    setDragging(drag.folder);
    const bounds = list.current?.getBoundingClientRect();
    if (
      bounds &&
      event.clientX >= bounds.left &&
      event.clientX <= bounds.right
    ) {
      if (event.clientY < bounds.top + 18) list.current?.scrollBy(0, -12);
      else if (event.clientY > bounds.bottom - 18)
        list.current?.scrollBy(0, 12);
    }
    setInsertion(insertionAt(event.clientX, event.clientY));
  }

  return (
    <nav
      ref={list}
      className={`favorite-nav${dragging ? " is-sorting" : ""}`}
      aria-label="收藏目录"
    >
      {favorites.length === 0 && (
        <p className="favorites-empty">右键目录可固定到这里</p>
      )}
      {favorites.map((folder, index) => {
        const target = volumes.find((item) => item.id === folder.volumeId);
        const active =
          state.page === "browser" && current && sameFolder(current, folder);
        const source = dragging && sameFolder(dragging, folder);
        return (
          <div
            className={`favorite-row${source ? " is-dragging" : ""}${insertion === index ? " insert-before" : ""}${insertion === favorites.length && index === favorites.length - 1 ? " insert-after" : ""}`}
            key={JSON.stringify([folder.volumeId, folder.path])}
          >
            <button
              className={`nav-item favorite-link${active ? " active" : ""}`}
              title={`${target?.name ?? "存储空间不可用"} / ${folder.path || folder.name}\n拖拽排序，或按 Alt + ↑ / ↓`}
              aria-current={active ? "page" : undefined}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              onClick={(event) => {
                if (suppressClick.current) {
                  event.preventDefault();
                  suppressClick.current = false;
                  return;
                }
                if (target) navigate(folder.volumeId, folder.path);
              }}
              onPointerDown={(event) => {
                if (event.button !== 0 || !event.isPrimary) return;
                suppressClick.current = false;
                gesture.current = {
                  folder,
                  pointerId: event.pointerId,
                  x: event.clientX,
                  y: event.clientY,
                  active: false,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={pointerMove}
              onPointerUp={(event) => {
                const drag = gesture.current;
                if (!drag || drag.pointerId !== event.pointerId) return;
                if (drag.active) {
                  const index = insertionAt(event.clientX, event.clientY);
                  if (index !== null)
                    move(drag.folder, favorites[index] ?? null);
                }
                cancelDrag();
              }}
              onPointerCancel={cancelDrag}
              onLostPointerCapture={cancelDrag}
              onKeyDown={(event) => {
                if (
                  !event.altKey ||
                  !["ArrowUp", "ArrowDown"].includes(event.key)
                )
                  return;
                event.preventDefault();
                if (event.key === "ArrowUp" && index > 0)
                  move(folder, favorites[index - 1]);
                if (event.key === "ArrowDown" && index < favorites.length - 1)
                  move(folder, favorites[index + 2] ?? null);
              }}
            >
              <Folder size={17} />
              <span className="truncate">{folder.name}</span>
            </button>
            <button
              className="favorite-remove"
              title="取消收藏"
              aria-label={`取消收藏 ${folder.name}`}
              onClick={() => remove(folder)}
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </nav>
  );
}
