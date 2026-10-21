import {
  Cloud,
  createLucideIcon,
  HardDrive,
  LayoutGrid,
  Images,
  LockKeyhole,
  Network,
  Plus,
  Settings2,
} from "lucide-react";
import { type LocationMenuTarget } from "./LocationMenu";
import { useBrowser } from "./store";
import { type Volume } from "./types";
import { FavoriteFolders } from "./FavoriteFolders";
import { isTauri } from "@tauri-apps/api/core";

const SdCard = createLucideIcon("SdCard", [
  [
    "path",
    {
      d: "M6 3h9l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z",
      fill: "none",
      key: "outline",
    },
  ],
  ["path", { d: "M8 3v5m3-5v5m3-5v5", key: "contacts" }],
]);

export function Sidebar({
  version,
  volumes,
  volume,
  onAdd,
  openVolume,
  navigate,
  onLocationMenu,
}: {
  version: string;
  volumes: Volume[];
  volume?: Volume;
  onAdd: () => void;
  openVolume: (volume: Volume) => void;
  navigate: (volumeId: string, path: string) => void;
  onLocationMenu: (target: LocationMenuTarget) => void;
}) {
  const state = useBrowser();
  const mac = isTauri() && navigator.platform.toLowerCase().includes("mac");
  const windows = navigator.platform.toLowerCase().includes("win");
  const navigation = [
    { page: "photo-library", label: "审图", Icon: Images },
    { page: "photo-import", label: "拷卡", Icon: SdCard },
    { page: "overview", label: "概览", Icon: LayoutGrid },
  ] as const;
  return (
    <aside
      className={`sidebar${mac ? " sidebar-macos" : ""}${windows ? " sidebar-windows" : ""}`}
    >
      <div className="sidebar-titlebar" data-tauri-drag-region>
        <nav className="sidebar-shortcuts" aria-label="主导航">
          {navigation.map(({ page, label, Icon }) => {
            const active =
              state.page === page ||
              (page === "photo-library" && state.page === "photo-review");
            return (
              <button
                key={page}
                className={`sidebar-shortcut${active ? " active" : ""}`}
                title={label}
                aria-label={label}
                aria-current={active ? "page" : undefined}
                onClick={() => state.setPage(page)}
              >
                <Icon size={18} />
              </button>
            );
          })}
        </nav>
        <span className="sidebar-brand" data-tauri-drag-region>
          Filo
        </span>
      </div>
      <div className="section-label">个人收藏</div>
      <FavoriteFolders volumes={volumes} navigate={navigate} />
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
            className={`nav-item ${(state.page === "browser" || state.page === "photo-review") && volume?.id === item.id ? "active" : ""}`}
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
            {item.root.type === "remote" ? (
              <Network size={17} />
            ) : item.root.type === "s3" ? (
              <Cloud size={17} />
            ) : (
              <HardDrive size={17} />
            )}
            <span className="truncate">{item.name}</span>
            {item.read_only && <LockKeyhole size={12} className="muted" />}
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <button
          className={`nav-item ${state.page === "settings" ? "active" : ""}`}
          onClick={() => state.setPage("settings")}
        >
          <Settings2 size={17} />
          设置<span className="muted">v{version}</span>
        </button>
      </div>
    </aside>
  );
}
