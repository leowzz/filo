import { useEffect, useState, type ReactNode } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useWindowMenu, windowsDesktop } from "./windowChrome";

export function WindowTitlebar({ children }: { children?: ReactNode }) {
  const menus = useWindowMenu((state) => state.items);
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!windowsDesktop) return;
    const appWindow = getCurrentWindow();
    let disposed = false;
    const sync = async () => {
      const value = await appWindow.isMaximized();
      if (!disposed) setMaximized(value);
    };
    const changed = () => setFullscreen(!!document.fullscreenElement);
    changed();
    void sync();
    const resized = appWindow.onResized(() => void sync());
    document.addEventListener("fullscreenchange", changed);
    return () => {
      disposed = true;
      void resized.then((unlisten) => unlisten());
      document.removeEventListener("fullscreenchange", changed);
    };
  }, []);

  if (!windowsDesktop) return null;
  const restore = fullscreen || maximized;
  return (
    <header
      className={`window-titlebar${children ? "" : " window-titlebar-default"}`}
      data-tauri-drag-region
    >
      <nav className="window-menu" aria-label="应用菜单" data-tauri-drag-region>
        {menus.map(({ label, menu }) => (
          <button
            key={menu.id}
            type="button"
            aria-haspopup="menu"
            onClick={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              void menu.popup(new LogicalPosition(bounds.left, bounds.bottom));
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                event.currentTarget.click();
              } else if (
                event.key === "ArrowLeft" ||
                event.key === "ArrowRight"
              ) {
                event.preventDefault();
                const buttons = Array.from(
                  event.currentTarget.parentElement!.querySelectorAll("button"),
                );
                const index = buttons.indexOf(event.currentTarget);
                buttons[
                  (index +
                    (event.key === "ArrowRight" ? 1 : -1) +
                    buttons.length) %
                    buttons.length
                ].focus();
              }
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="window-title" data-tauri-drag-region>
        {children ?? "Filo · 菲洛"}
      </div>
      <div className="window-controls" role="group" aria-label="窗口控制">
        <button
          type="button"
          aria-label="最小化"
          title="最小化"
          onClick={() => void getCurrentWindow().minimize()}
        >
          <Minus size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={restore ? "还原" : "最大化"}
          title={restore ? "还原" : "最大化"}
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen();
            else void getCurrentWindow().toggleMaximize();
          }}
        >
          {restore ? (
            <Copy size={12} aria-hidden="true" />
          ) : (
            <Square size={12} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="window-close"
          aria-label="关闭窗口"
          title="关闭窗口"
          onClick={() => void getCurrentWindow().close()}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
