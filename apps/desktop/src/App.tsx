import { useCallback, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownUp,
  ChevronLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronRight,
  CircleHelp,
  Cloud,
  Database,
  Eye,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Info,
  LayoutGrid,
  LoaderCircle,
  LockKeyhole,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { api, desktop, errorMessage } from "./api";
import { useBrowser } from "./store";
import {
  EntryIcon,
  formatDate,
  formatSize,
  Modal,
  typeName,
} from "./components";
import { isDirectory, type Entry, type Locator, type Volume } from "./types";
import { LocationMenu, type LocationMenuTarget } from "./LocationMenu";
import { EditLocationDialog } from "./EditLocationDialog";

type Dialog =
  | { type: "add" }
  | { type: "folder" }
  | { type: "rename" | "delete"; entry: Entry };

export default function App() {
  const state = useBrowser();
  const client = useQueryClient();
  const volumesQuery = useQuery({
    queryKey: ["volumes"],
    queryFn: api.volumes,
  });
  const volumes = volumesQuery.data ?? [];
  const location = state.history[state.index];
  const volume = volumes.find((item) => item.id === location?.volumeId);
  const path = location?.path ?? "";
  const parent: Locator = {
    volume_id: volume?.id ?? "",
    logical_path: path,
    version_id: null,
  };
  const entriesQuery = useQuery({
    queryKey: ["entries", parent.volume_id, path],
    queryFn: () => api.entries(parent),
    enabled: !!volume && state.page === "browser",
  });
  const [selection, setSelection] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [name, setName] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [notice, setNotice] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const [sort, setSort] = useState<"name" | "size" | "modified">("name");
  const [locationMenu, setLocationMenu] = useState<LocationMenuTarget | null>(
    null,
  );
  const [editingLocation, setEditingLocation] = useState<Volume | null>(null);
  const closeLocationMenu = useCallback(() => setLocationMenu(null), []);
  const entries = (entriesQuery.data ?? [])
    .filter(
      (entry) =>
        (state.showHidden || !entry.name.startsWith(".")) &&
        entry.name.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) => {
      if (isDirectory(a) !== isDirectory(b)) return isDirectory(a) ? -1 : 1;
      if (sort === "size") return (b.size ?? 0) - (a.size ?? 0);
      if (sort === "modified")
        return (b.modified_at ?? "").localeCompare(a.modified_at ?? "");
      return a.name.localeCompare(b.name, "zh-CN", { numeric: true });
    });
  const selected = entries.find(
    (entry) => entry.locator.logical_path === selection,
  );
  const mutation = useMutation({
    mutationFn: async () => {
      if (dialog?.type === "add") return api.addLocal(readOnly);
      if (dialog?.type === "folder") return api.createDirectory(parent, name);
      if (dialog?.type === "rename")
        return api.rename(dialog.entry.locator, name);
      if (dialog?.type === "delete") return api.delete(dialog.entry.locator);
    },
    onSuccess: async (added) => {
      await client.invalidateQueries({ queryKey: ["volumes"] });
      await client.invalidateQueries({ queryKey: ["entries"] });
      if (added) navigate(added.id, "");
      if (dialog?.type !== "add")
        setNotice(
          dialog?.type === "delete"
            ? "已删除所选项目"
            : dialog?.type === "rename"
              ? "文件已重命名"
              : "文件夹已创建",
        );
      setDialog(null);
      setSelection(null);
    },
  });
  function navigate(volumeId: string, logicalPath: string) {
    state.navigate({ volumeId, path: logicalPath });
    setSelection(null);
    setSearch("");
    setMenu(null);
    setNotice("");
  }
  function openDialog(next: Dialog) {
    mutation.reset();
    setName(next.type === "rename" ? next.entry.name : "");
    setDialog(next);
    setMenu(null);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!mutation.isPending) mutation.mutate();
  }
  function openEntry(entry: Entry) {
    if (isDirectory(entry) && volume)
      navigate(volume.id, entry.locator.logical_path);
    else {
      setSelection(entry.locator.logical_path);
      if (!state.showDetails) state.toggleDetails();
    }
  }
  const openVolume = (item: Volume) => navigate(item.id, "");

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-titlebar" data-tauri-drag-region>
          <span data-tauri-drag-region>Filo</span>
        </div>
        <div className="section-label">个人收藏</div>
        <nav className="main-nav" aria-label="主导航">
          <button
            className={
              state.page === "overview" ? "nav-item active" : "nav-item"
            }
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
            传输任务<span className="soon">即将支持</span>
          </button>
        </nav>
        <div className="section-label">
          位置{" "}
          <button
            title="添加存储空间"
            aria-label="添加存储空间"
            onClick={() => openDialog({ type: "add" })}
          >
            <Plus size={16} />
          </button>
        </div>
        <nav className="volume-nav" aria-label="存储空间">
          {volumes.map((item) => (
            <button
              key={item.id}
              title={
                item.root.type === "local" ? item.root.root_path : item.name
              }
              className={`nav-item ${state.page === "browser" && volume?.id === item.id ? "active" : ""}`}
              onClick={() => openVolume(item)}
              onContextMenu={(event) => {
                event.preventDefault();
                setLocationMenu({
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
                  setLocationMenu({
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
          <button
            className="add-location"
            onClick={() => openDialog({ type: "add" })}
          >
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

      <main className="main-content">
        <header className="topbar" data-tauri-drag-region>
          <div className="topbar-title" data-tauri-drag-region>
            {state.page === "browser" && volume && (
              <div className="navigation-buttons">
                <button
                  className="icon-button"
                  aria-label="后退"
                  title="后退"
                  disabled={state.index <= 0}
                  onClick={() => {
                    state.step(-1);
                    setSelection(null);
                    setSearch("");
                    setMenu(null);
                  }}
                >
                  <ChevronLeft size={23} />
                </button>
                <button
                  className="icon-button"
                  aria-label="前进"
                  title="前进"
                  disabled={state.index >= state.history.length - 1}
                  onClick={() => {
                    state.step(1);
                    setSelection(null);
                    setSearch("");
                    setMenu(null);
                  }}
                >
                  <ChevronRight size={23} />
                </button>
              </div>
            )}
            <h1 data-tauri-drag-region>
              {state.page === "browser"
                ? (path.split("/").filter(Boolean).at(-1) ??
                  volume?.name ??
                  "存储浏览器")
                : { overview: "概览", transfers: "传输任务", settings: "设置" }[
                    state.page
                  ]}
            </h1>
            {state.page === "browser" && volume?.read_only && (
              <span className="readonly-label">
                <LockKeyhole size={12} />
                只读
              </span>
            )}
          </div>
          {state.page === "browser" && volume ? (
            <div className="toolbar-actions">
              <button
                className="icon-button"
                title="上级目录"
                aria-label="上级目录"
                disabled={!path}
                onClick={() =>
                  navigate(volume.id, path.split("/").slice(0, -1).join("/"))
                }
              >
                <ArrowUp size={18} />
              </button>
              <button
                className="icon-button"
                title="新建文件夹"
                aria-label="新建文件夹"
                disabled={!volume.capabilities.create_directory}
                onClick={() => openDialog({ type: "folder" })}
              >
                <FolderPlus size={20} />
              </button>
              <button
                className="icon-button"
                title="重命名"
                aria-label="重命名"
                disabled={
                  !selected ||
                  selected.kind !== "file" ||
                  volume.capabilities.rename === "unsupported"
                }
                onClick={() =>
                  selected && openDialog({ type: "rename", entry: selected })
                }
              >
                <Pencil size={18} />
              </button>
              <button
                className="icon-button"
                title="删除"
                aria-label="删除"
                disabled={
                  !selected ||
                  selected.kind === "symlink" ||
                  !volume.capabilities.delete
                }
                onClick={() =>
                  selected && openDialog({ type: "delete", entry: selected })
                }
              >
                <Trash2 size={18} />
              </button>
              <span className="toolbar-separator" />
              <button
                className={`icon-button ${state.showHidden ? "on" : ""}`}
                title="显示 / 隐藏隐藏文件"
                aria-label="显示或隐藏隐藏文件"
                aria-pressed={state.showHidden}
                onClick={state.toggleHidden}
              >
                <Eye size={19} />
              </button>
              <button
                className={`icon-button ${state.showDetails ? "on" : ""}`}
                title="切换详情面板"
                aria-label="切换详情面板"
                aria-pressed={state.showDetails}
                onClick={state.toggleDetails}
              >
                <PanelRight size={19} />
              </button>
              <button
                className="icon-button"
                title="刷新"
                aria-label="刷新"
                onClick={() => void entriesQuery.refetch()}
              >
                <RefreshCw
                  size={18}
                  className={entriesQuery.isFetching ? "spin" : ""}
                />
              </button>
              <label className="search-input">
                <Search size={15} />
                <input
                  aria-label="筛选当前目录"
                  placeholder="搜索当前目录"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                {search && (
                  <button aria-label="清除筛选" onClick={() => setSearch("")}>
                    <X size={12} />
                  </button>
                )}
              </label>
            </div>
          ) : (
            <button
              className="icon-button"
              title="添加存储空间"
              aria-label="添加存储空间"
              onClick={() => openDialog({ type: "add" })}
            >
              <Plus size={21} />
            </button>
          )}
        </header>

        {volumesQuery.isError && (
          <div className="error-banner" role="alert">
            {errorMessage(volumesQuery.error)}
            <button onClick={() => void volumesQuery.refetch()}>重试</button>
          </div>
        )}
        {!desktop && (
          <div className="browser-banner">
            <Info size={16} />
            当前为界面预览。请运行 <code>make dev</code>
            ，在桌面窗口中选择真实目录。
          </div>
        )}

        {state.page === "overview" && (
          <div className="overview page-scroll">
            <div className="page-heading">
              <div>
                <h2>这台 Mac 上的存储空间</h2>
                <p>连接已有目录，浏览和管理你的文件。</p>
              </div>
              <button
                className="primary"
                onClick={() => openDialog({ type: "add" })}
              >
                <Plus size={17} />
                添加存储空间
              </button>
            </div>
            <div className="stats">
              <div>
                <span>
                  <HardDrive size={17} />
                  存储空间
                </span>
                <strong>
                  {volumes.length.toString().padStart(2, "0")}
                  <small>个目录</small>
                </strong>
              </div>
              <div>
                <span>
                  <Database size={17} />
                  已保存连接
                </span>
                <strong>
                  {new Set(volumes.map((item) => item.connection_id)).size
                    .toString()
                    .padStart(2, "0")}
                  <small>个本地连接</small>
                </strong>
              </div>
              <div>
                <span>
                  <ShieldCheck size={17} />
                  数据访问
                </span>
                <strong className="text-stat">
                  仅限所选目录<small>无需上传，无需云端</small>
                </strong>
              </div>
            </div>
            <div className="section-heading">
              <h2>
                你的存储空间 <span>{volumes.length}</span>
              </h2>
              <span className="muted">所有已添加的位置</span>
            </div>
            {volumesQuery.isPending ? (
              <div className="empty-state">
                <LoaderCircle className="spin" />
                正在读取存储空间…
              </div>
            ) : (
              <div className="volume-grid">
                {volumes.map((item) => (
                  <button
                    className="volume-card"
                    key={item.id}
                    onClick={() => openVolume(item)}
                  >
                    <div className="card-top">
                      <span className="drive-tile">
                        <HardDrive size={25} />
                      </span>
                      <span className="pill">
                        {item.read_only ? "只读" : "本地目录"}
                      </span>
                    </div>
                    <h3>{item.name}</h3>
                    <p
                      title={
                        item.root.type === "local" ? item.root.root_path : ""
                      }
                    >
                      {item.root.type === "local"
                        ? item.root.root_path
                        : item.name}
                    </p>
                    <div className="card-bottom">
                      <span>打开文件浏览器</span>
                      <ArrowRight size={17} />
                    </div>
                  </button>
                ))}
                <button
                  className="new-volume-card"
                  onClick={() => openDialog({ type: "add" })}
                >
                  <span>
                    <Plus size={25} />
                  </span>
                  <h3>
                    {volumes.length ? "连接另一个目录" : "从一个本地目录开始"}
                  </h3>
                  <p>选择已有目录，直接浏览其中的文件</p>
                </button>
              </div>
            )}
            <div className="overview-footer">
              <ShieldCheck size={14} />
              <span>连接信息仅保存在此设备，文件保留在原始位置。</span>
            </div>
          </div>
        )}

        {state.page === "browser" && volume && (
          <>
            {notice && (
              <div className="notice" role="status">
                <Check size={15} />
                {notice}
                <button aria-label="关闭提示" onClick={() => setNotice("")}>
                  <X size={14} />
                </button>
              </div>
            )}
            <div className="browser-body">
              <div className="file-area">
                {entriesQuery.isPending ? (
                  <div className="empty-state">
                    <LoaderCircle className="spin" size={27} />
                    <h3>正在读取文件</h3>
                  </div>
                ) : entriesQuery.isError ? (
                  <div className="empty-state error" role="alert">
                    <CircleHelp size={32} />
                    <h3>暂时无法打开目录</h3>
                    <p>{errorMessage(entriesQuery.error)}</p>
                    <button
                      className="secondary"
                      onClick={() => void entriesQuery.refetch()}
                    >
                      重新加载
                    </button>
                  </div>
                ) : (
                  <table className="file-table">
                    <thead>
                      <tr>
                        <th>
                          <button onClick={() => setSort("name")}>
                            名称 {sort === "name" && <ArrowUp size={12} />}
                          </button>
                        </th>
                        <th>
                          <button onClick={() => setSort("size")}>大小</button>
                        </th>
                        <th>种类</th>
                        <th>
                          <button onClick={() => setSort("modified")}>
                            修改时间
                          </button>
                        </th>
                        <th aria-label="操作" />
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((entry) => (
                        <tr
                          key={entry.locator.logical_path}
                          className={selected === entry ? "selected" : ""}
                          tabIndex={0}
                          aria-selected={selected === entry}
                          onClick={() => {
                            setSelection(entry.locator.logical_path);
                            setMenu(null);
                          }}
                          onDoubleClick={() => openEntry(entry)}
                          onKeyDown={(event) => {
                            if (
                              event.key === "Enter" &&
                              event.target === event.currentTarget
                            )
                              openEntry(entry);
                          }}
                        >
                          <td>
                            <span className="file-name">
                              <EntryIcon entry={entry} />
                              <span title={entry.name}>{entry.name}</span>
                            </span>
                          </td>
                          <td className="mono">{formatSize(entry.size)}</td>
                          <td>{typeName(entry)}</td>
                          <td>{formatDate(entry.modified_at)}</td>
                          <td className="row-actions">
                            <button
                              className="icon-button"
                              aria-label={`${entry.name} 操作菜单`}
                              onClick={(event) => {
                                event.stopPropagation();
                                setSelection(entry.locator.logical_path);
                                setMenu(
                                  menu === entry.locator.logical_path
                                    ? null
                                    : entry.locator.logical_path,
                                );
                              }}
                            >
                              <MoreHorizontal size={17} />
                            </button>
                            {menu === entry.locator.logical_path && (
                              <div
                                className="entry-menu"
                                role="menu"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <button
                                  role="menuitem"
                                  onClick={() => {
                                    openEntry(entry);
                                    setMenu(null);
                                  }}
                                >
                                  {isDirectory(entry)
                                    ? "打开文件夹"
                                    : "查看详情"}
                                </button>
                                {entry.kind === "file" &&
                                  volume.capabilities.rename !==
                                    "unsupported" && (
                                    <button
                                      role="menuitem"
                                      onClick={() =>
                                        openDialog({ type: "rename", entry })
                                      }
                                    >
                                      重命名
                                    </button>
                                  )}
                                {entry.kind !== "symlink" &&
                                  volume.capabilities.delete && (
                                    <button
                                      role="menuitem"
                                      className="danger-text"
                                      onClick={() =>
                                        openDialog({ type: "delete", entry })
                                      }
                                    >
                                      删除…
                                    </button>
                                  )}
                                <button
                                  role="menuitem"
                                  onClick={() => setMenu(null)}
                                >
                                  关闭菜单
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {!entriesQuery.isPending &&
                  !entriesQuery.isError &&
                  entries.length === 0 && (
                    <div className="empty-state">
                      <FolderOpen size={40} strokeWidth={1.3} />
                      <h3>
                        {search ? "没有匹配的文件" : "这里还没有可见文件"}
                      </h3>
                      <p>
                        {search
                          ? "尝试其他名称，筛选仅作用于当前目录。"
                          : "可以新建文件夹，或打开隐藏文件开关。"}
                      </p>
                    </div>
                  )}
              </div>
              {state.showDetails && (
                <aside className="details-panel">
                  <div className="details-heading">
                    {selected ? "项目详情" : "存储详情"}
                    <Info size={15} />
                  </div>
                  <div className={`detail-icon ${selected ? "" : "drive"}`}>
                    {selected ? (
                      <EntryIcon entry={selected} size={54} />
                    ) : (
                      <HardDrive size={48} strokeWidth={1.2} />
                    )}
                  </div>
                  <h3>{selected?.name ?? volume.name}</h3>
                  <span className="pill">
                    {selected ? typeName(selected) : "本地文件系统"}
                  </span>
                  <dl>
                    <dt>位置</dt>
                    <dd>
                      {selected?.locator.logical_path ??
                        (volume.root.type === "local"
                          ? volume.root.root_path
                          : "/")}
                    </dd>
                    {selected ? (
                      <>
                        <dt>大小</dt>
                        <dd>{formatSize(selected.size)}</dd>
                        <dt>修改时间</dt>
                        <dd>{formatDate(selected.modified_at)}</dd>
                      </>
                    ) : (
                      <>
                        <dt>当前目录</dt>
                        <dd>{path || "/"}</dd>
                        <dt>项目数</dt>
                        <dd>{entriesQuery.data?.length ?? "—"}</dd>
                      </>
                    )}
                    <dt>访问权限</dt>
                    <dd>{volume.read_only ? "只读" : "可读写"}</dd>
                  </dl>
                  <div className="detail-tip">
                    <ShieldCheck size={16} />
                    <p>
                      {selected?.kind === "symlink"
                        ? "符号链接仅展示，不允许通过链接访问或修改文件。"
                        : "文件保留在原始目录，所有更改直接应用到本地文件系统。"}
                    </p>
                  </div>
                </aside>
              )}
            </div>
            <nav className="pathbar" aria-label="当前路径">
              <button
                onClick={() => navigate(volume.id, "")}
                title={
                  volume.root.type === "local"
                    ? volume.root.root_path
                    : volume.name
                }
              >
                <HardDrive size={14} />
                {volume.name}
              </button>
              {path
                .split("/")
                .filter(Boolean)
                .map((part, i, parts) => (
                  <span key={i}>
                    <ChevronRight size={12} />
                    <button
                      onClick={() =>
                        navigate(volume.id, parts.slice(0, i + 1).join("/"))
                      }
                    >
                      {part}
                    </button>
                  </span>
                ))}
            </nav>
            <footer className="statusbar">
              <span>
                {entries.length} 个项目{selected ? " · 已选择 1 项" : ""}
                {!state.showHidden &&
                (entriesQuery.data ?? []).some((entry) =>
                  entry.name.startsWith("."),
                )
                  ? " · 隐藏文件已收起"
                  : ""}
              </span>
              <span>
                <span className="status-dot" />
                {volume.read_only ? "只读访问" : "本地文件系统"}
                <span className="status-separator">/</span>双击打开文件夹
              </span>
            </footer>
          </>
        )}

        {state.page === "transfers" && (
          <div className="page-scroll simple-page">
            <h1>传输任务</h1>
            <div className="feature-placeholder">
              <ArrowDownUp size={40} strokeWidth={1.2} />
              <h2>暂未启用文件传输</h2>
              <p>
                当前版本先完成本地目录管理。
                <br />
                文件复制、移动及跨存储传输将在后续版本接入。
              </p>
              <span className="pill">尚未启用</span>
            </div>
          </div>
        )}
        {state.page === "settings" && (
          <div className="page-scroll simple-page">
            <h1>设置</h1>
            <section className="settings-card">
              <h2>
                <SlidersHorizontal size={19} />
                浏览偏好
              </h2>
              <label>
                <div>
                  <strong>显示隐藏文件</strong>
                  <p>显示名称以「.」开头的文件和目录</p>
                </div>
                <input
                  type="checkbox"
                  checked={state.showHidden}
                  onChange={state.toggleHidden}
                />
              </label>
              <label>
                <div>
                  <strong>显示详情面板</strong>
                  <p>在文件列表右侧展示项目属性</p>
                </div>
                <input
                  type="checkbox"
                  checked={state.showDetails}
                  onChange={state.toggleDetails}
                />
              </label>
            </section>
            <section className="settings-card">
              <h2>
                <ShieldCheck size={19} />
                关于这个版本
              </h2>
              <p>Filo 0.1.0 · LocalFS Demo</p>
              <p>
                存储连接保存在设备上的 SQLite
                数据库。只能访问通过系统选择器添加的目录，不跟随符号链接；删除操作需要确认。
              </p>
              <p>当前不提供文件预览、目录递归操作、S3 和文件传输。</p>
            </section>
          </div>
        )}
      </main>

      {locationMenu && (
        <LocationMenu
          target={locationMenu}
          onClose={closeLocationMenu}
          onEdit={(item) => {
            setLocationMenu(null);
            setEditingLocation(item);
          }}
        />
      )}
      {editingLocation && (
        <EditLocationDialog
          key={editingLocation.id}
          volume={editingLocation}
          onClose={() => setEditingLocation(null)}
          onSaved={(rootChanged) => {
            if (volume?.id === editingLocation.id) {
              setNotice("连接信息已保存");
              if (rootChanged) {
                setSelection(null);
                setSearch("");
                setMenu(null);
              }
            }
            setEditingLocation(null);
          }}
        />
      )}
      {dialog && (
        <Modal
          title={
            dialog.type === "add"
              ? "添加存储空间"
              : dialog.type === "folder"
                ? "新建文件夹"
                : dialog.type === "rename"
                  ? "重命名文件"
                  : "删除项目"
          }
          busy={mutation.isPending}
          onClose={() => setDialog(null)}
        >
          <form onSubmit={submit}>
            {dialog.type === "add" ? (
              <>
                <p className="modal-description">
                  把已有目录连接到 Filo，文件会留在原来的位置。
                </p>
                <div className="provider-choice">
                  <span className="drive-tile">
                    <HardDrive size={23} />
                  </span>
                  <div>
                    <strong>本地文件系统</strong>
                    <p>选择这台电脑上的任意已有目录</p>
                  </div>
                  <Check size={19} />
                </div>
                <div className="provider-soon">
                  <Cloud size={19} />
                  <span>S3 兼容存储</span>
                  <span className="pill">后续版本</span>
                </div>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={readOnly}
                    onChange={(event) => setReadOnly(event.target.checked)}
                  />
                  以只读方式添加<span>适合先浏览现有文件</span>
                </label>
                {!desktop && (
                  <p className="error-text">
                    请在桌面应用中使用系统目录选择器。
                  </p>
                )}
              </>
            ) : dialog.type === "delete" ? (
              <>
                <div className="delete-icon">
                  <Trash2 size={25} />
                </div>
                <p className="modal-description">
                  确定永久删除 <strong>{dialog.entry.name}</strong>？
                </p>
                <p className="delete-warning">
                  此操作会直接删除本地项目，不会放入系统回收站。文件夹仅允许在为空时删除。
                </p>
              </>
            ) : (
              <>
                <label className="field-label" htmlFor="entry-name">
                  {dialog.type === "folder" ? "文件夹名称" : "文件名称"}
                </label>
                <input
                  id="entry-name"
                  autoFocus
                  className="text-input"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  maxLength={255}
                  placeholder="输入名称"
                />
                <p className="field-help">
                  {dialog.type === "folder"
                    ? "将在当前目录中创建，不会覆盖已有项目。"
                    : "只修改当前文件的名称，不会覆盖同名项目。"}
                </p>
              </>
            )}
            {mutation.isError && (
              <p className="error-text" role="alert">
                {errorMessage(mutation.error)}
              </p>
            )}
            <div className="modal-footer">
              <button
                type="button"
                className="secondary"
                disabled={mutation.isPending}
                onClick={() => setDialog(null)}
              >
                取消
              </button>
              <button
                type="submit"
                className={dialog.type === "delete" ? "danger" : "primary"}
                disabled={
                  mutation.isPending ||
                  (dialog.type === "add" && !desktop) ||
                  ((dialog.type === "folder" || dialog.type === "rename") &&
                    (!name.trim() ||
                      name === "." ||
                      name === ".." ||
                      /[/\\:\0]/.test(name)))
                }
              >
                {mutation.isPending ? (
                  <LoaderCircle size={16} className="spin" />
                ) : dialog.type === "add" ? (
                  <FolderOpen size={16} />
                ) : null}
                {mutation.isPending
                  ? "正在处理…"
                  : dialog.type === "add"
                    ? "选择本地目录"
                    : dialog.type === "delete"
                      ? "确认永久删除"
                      : dialog.type === "folder"
                        ? "创建文件夹"
                        : "保存名称"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
