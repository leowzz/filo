import {
  ArrowDownUp,
  HardDrive,
  LayoutGrid,
  LockKeyhole,
  Plus,
  Settings2,
} from "lucide-react";
import { type LocationMenuTarget } from "./LocationMenu";
import { useBrowser } from "./store";
import { type Volume } from "./types";

export function Sidebar({
  volumes,
  volume,
  pendingTransfers,
  onAdd,
  openVolume,
  onLocationMenu,
}: {
  volumes: Volume[];
  volume?: Volume;
  pendingTransfers: number;
  onAdd: () => void;
  openVolume: (volume: Volume) => void;
  onLocationMenu: (target: LocationMenuTarget) => void;
}) {
  const state = useBrowser();
  return (
    <aside className="sidebar">
      <div className="sidebar-titlebar" data-tauri-drag-region>
        <span data-tauri-drag-region>Filo</span>
      </div>
      <div className="section-label">个人收藏</div>
      <nav className="main-nav" aria-label="主导航">
        <button
          className={state.page === "overview" ? "nav-item active" : "nav-item"}
          onClick={() => state.setPage("overview")}
        >
          <LayoutGrid size={17} />
          概览
        </button>
        <button
          className={
            state.page === "transfers" ? "nav-item active" : "nav-item"
          }
          onClick={() => state.setPage("transfers")}
        >
          <ArrowDownUp size={17} />
          传输任务
          {pendingTransfers > 0 && (
            <span className="soon">{pendingTransfers}</span>
          )}
        </button>
      </nav>
      <div className="section-label">
        位置{" "}
        <button
          title="添加存储空间"
          aria-label="添加存储空间"
          onClick={() => onAdd()}
        >
          <Plus size={16} />
        </button>
      </div>
      <nav className="volume-nav" aria-label="存储空间">
        {volumes.map((item) => (
          <button
            key={item.id}
            title={item.root.type === "local" ? item.root.root_path : item.name}
            className={`nav-item ${state.page === "browser" && volume?.id === item.id ? "active" : ""}`}
            onClick={() => openVolume(item)}
            onContextMenu={(event) => {
              event.preventDefault();
              onLocationMenu({
                volume: item,
                x: event.clientX,
                y: event.clientY,
                trigger: event.currentTarget,
              });
            }}
            onKeyDown={(event) => {
              if (
                (event.shiftKey && event.key === "F10") ||
                event.key === "ContextMenu"
              ) {
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                onLocationMenu({
                  volume: item,
                  x: rect.right,
                  y: rect.top,
                  trigger: event.currentTarget,
                });
              }
            }}
            aria-haspopup="menu"
          >
            <HardDrive size={17} />
            <span className="truncate">{item.name}</span>
            {item.read_only ? (
              <LockKeyhole size={12} className="muted" />
            ) : (
              <span className="status-dot" />
            )}
          </button>
        ))}
        <button className="add-location" onClick={() => onAdd()}>
          <Plus size={15} />
          添加存储空间
        </button>
      </nav>
      <div className="sidebar-bottom">
        <button
          className={`nav-item ${state.page === "settings" ? "active" : ""}`}
          onClick={() => state.setPage("settings")}
        >
          <Settings2 size={17} />
          设置<span className="muted">v0.1.0</span>
        </button>
      </div>
    </aside>
  );
}
