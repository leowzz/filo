import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Info, X } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";
import { api, desktop, errorMessage } from "./api";
import { DeleteEntryDialog } from "./DeleteEntryDialog";
import { EditLocationDialog } from "./EditLocationDialog";
import { EntryMenu } from "./EntryMenu";
import { LocationMenu, type LocationMenuTarget } from "./LocationMenu";
import { RemoveLocationDialog } from "./RemoveLocationDialog";
import { S3StorageDialog } from "./S3StorageDialog";
import { useBrowser } from "./store";
import { TransferDialog } from "./TransferDialog";
import { TransfersPage } from "./TransfersPage";
import {
  activeTransfer,
  isDirectory,
  type DeleteMode,
  type Entry,
  type Locator,
  type TransferJob,
  type TransferKind,
  type Volume,
} from "./types";
import { useFileSelection } from "./useFileSelection";

import { AppHeader } from "./AppHeader";
import { FileBrowser, type EntrySort } from "./FileBrowser";
import { OverviewPage } from "./OverviewPage";
import { SettingsPage } from "./SettingsPage";
import { Sidebar } from "./Sidebar";
import { StorageActionDialog, type Dialog } from "./StorageActionDialog";

export default function App() {
  const state = useBrowser();
  const client = useQueryClient();
  const volumesQuery = useQuery({
    queryKey: ["volumes"],
    queryFn: api.volumes,
  });
  const volumes = volumesQuery.data ?? [];
  const transfersQuery = useQuery({
    queryKey: ["transfers"],
    queryFn: api.transfers,
    refetchInterval: (query) =>
      query.state.data?.some(activeTransfer) ? 1000 : false,
  });
  const pendingTransfers =
    transfersQuery.data?.filter(activeTransfer).length ?? 0;
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
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [name, setName] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [addingS3, setAddingS3] = useState(false);
  const [notice, setNotice] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{
    x: number;
    y: number;
    trigger: HTMLElement;
  } | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<{
    entry: Entry;
    mode: DeleteMode;
  } | null>(null);
  const closeEntryMenu = useCallback(() => setMenu(null), []);
  const [sort, setSort] = useState<EntrySort>("name");
  const [locationMenu, setLocationMenu] = useState<LocationMenuTarget | null>(
    null,
  );
  const [editingLocation, setEditingLocation] = useState<Volume | null>(null);
  const [removingLocation, setRemovingLocation] = useState<Volume | null>(null);
  const [transferDialog, setTransferDialog] = useState<{
    entry: Entry;
    kind: TransferKind;
  } | null>(null);
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
  const selection = useFileSelection(
    JSON.stringify([
      state.page,
      parent.volume_id,
      path,
      search,
      state.showHidden,
    ]),
    entries.map((entry) => entry.locator.logical_path),
  );
  const { setSelection, selectedPaths } = selection;
  const selectedEntries = entries.filter((entry) =>
    selectedPaths.has(entry.locator.logical_path),
  );
  const selected =
    selectedEntries.length === 1 ? selectedEntries[0] : undefined;
  const mutation = useMutation({
    mutationFn: async () => {
      if (dialog?.type === "add") return api.addLocal(readOnly);
      if (dialog?.type === "folder") return api.createDirectory(parent, name);
      if (dialog?.type === "rename")
        return api.rename(dialog.entry.locator, name);
    },
    onSuccess: async (added) => {
      await client.invalidateQueries({ queryKey: ["volumes"] });
      await client.invalidateQueries({ queryKey: ["entries"] });
      if (added) navigate(added.id, "");
      if (dialog?.type !== "add")
        setNotice(dialog?.type === "rename" ? "文件已重命名" : "文件夹已创建");
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
  const opening = useMutation({
    mutationFn: api.open,
    onSuccess: () => setNotice("已交给系统默认应用打开"),
    onError: (error) => setNotice(errorMessage(error)),
  });
  function showDetails(entry: Entry) {
    setSelection(entry.locator.logical_path);
    if (!state.showDetails) state.toggleDetails();
  }
  const fileTransfer = useMutation({
    mutationFn: ({ remote, upload }: { remote: Locator; upload: boolean }) =>
      api.transferLocalFile(remote, upload, (job) => {
        client.setQueryData<TransferJob[]>(["transfers"], (current) => [
          job,
          ...(current ?? []).filter((item) => item.id !== job.id),
        ]);
        if (!activeTransfer(job))
          void client.invalidateQueries({ queryKey: ["entries"] });
      }),
    onSuccess: (job) => {
      if (job) {
        void client.invalidateQueries({ queryKey: ["transfers"] });
        state.setPage("transfers");
      }
    },
    onError: (error) => setNotice(errorMessage(error)),
  });
  function openEntry(entry: Entry) {
    if (isDirectory(entry) && volume)
      navigate(volume.id, entry.locator.logical_path);
    else if (
      entry.kind === "file" &&
      volume?.capabilities.native_open &&
      !opening.isPending
    )
      opening.mutate(entry.locator);
    else if (entry.kind === "symlink" || entry.kind === "file")
      showDetails(entry);
  }
  function showEntryMenu(
    entry: Entry,
    x: number,
    y: number,
    trigger: HTMLElement,
  ) {
    setSelection(entry.locator.logical_path);
    setMenuPosition({ x, y, trigger });
    setMenu(entry.locator.logical_path);
  }
  const menuEntry = entries.find(
    (entry) => entry.locator.logical_path === menu,
  );
  const openVolume = (item: Volume) => navigate(item.id, "");

  return (
    <div className="app-shell">
      <Sidebar
        volumes={volumes}
        volume={volume}
        pendingTransfers={pendingTransfers}
        onAdd={() => openDialog({ type: "add" })}
        openVolume={openVolume}
        onLocationMenu={setLocationMenu}
      />

      <main className="main-content">
        <AppHeader
          volume={volume}
          path={path}
          selected={selected}
          parent={parent}
          search={search}
          setSearch={setSearch}
          onStep={(direction) => {
            state.step(direction);
            setSelection(null);
            setSearch("");
            setMenu(null);
          }}
          navigate={navigate}
          openingPending={opening.isPending}
          transferPending={fileTransfer.isPending}
          openEntry={openEntry}
          openDialog={openDialog}
          setTransferDialog={setTransferDialog}
          setDeleteDialog={setDeleteDialog}
          onFileTransfer={fileTransfer.mutate}
          onRefresh={() => void entriesQuery.refetch()}
          isFetching={entriesQuery.isFetching}
        />

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
          <OverviewPage
            volumes={volumes}
            loading={volumesQuery.isPending}
            openVolume={openVolume}
            onAdd={() => openDialog({ type: "add" })}
          />
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
            <FileBrowser
              volume={volume}
              path={path}
              entries={entries}
              entriesQuery={entriesQuery}
              search={search}
              sort={sort}
              setSort={setSort}
              selection={selection}
              selectedEntries={selectedEntries}
              menu={menu}
              setMenu={setMenu}
              openEntry={openEntry}
              showEntryMenu={showEntryMenu}
              navigate={navigate}
            />
          </>
        )}

        {state.page === "transfers" && <TransfersPage volumes={volumes} />}
        {state.page === "settings" && <SettingsPage />}
      </main>

      {menuEntry && volume && menuPosition && (
        <EntryMenu
          entry={menuEntry}
          volume={volume}
          position={menuPosition}
          onClose={closeEntryMenu}
          onOpen={() => openEntry(menuEntry)}
          onDetails={() => showDetails(menuEntry)}
          onRename={() => openDialog({ type: "rename", entry: menuEntry })}
          onTransfer={(kind) => setTransferDialog({ entry: menuEntry, kind })}
          onDelete={(mode) => setDeleteDialog({ entry: menuEntry, mode })}
        />
      )}
      {deleteDialog && volume && (
        <DeleteEntryDialog
          {...deleteDialog}
          volume={volume}
          onClose={() => setDeleteDialog(null)}
          onDeleted={(outcome) => {
            setNotice(
              outcome === "trashed" ? "已移入系统回收站" : "已永久删除",
            );
            setSelection(null);
            setDeleteDialog(null);
          }}
        />
      )}
      {transferDialog && (
        <TransferDialog
          {...transferDialog}
          volumes={volumes}
          onClose={() => setTransferDialog(null)}
          onStarted={() => {
            setTransferDialog(null);
            setMenu(null);
            state.setPage("transfers");
          }}
        />
      )}
      {locationMenu && (
        <LocationMenu
          target={locationMenu}
          onClose={closeLocationMenu}
          onEdit={(item) => {
            setLocationMenu(null);
            setEditingLocation(item);
          }}
          onRemove={(item) => {
            setLocationMenu(null);
            setRemovingLocation(item);
          }}
        />
      )}
      {addingS3 && (
        <S3StorageDialog
          onClose={() => setAddingS3(false)}
          onSaved={(saved) => {
            setAddingS3(false);
            navigate(saved.id, "");
          }}
        />
      )}
      {editingLocation?.root.type === "s3" && (
        <S3StorageDialog
          volume={editingLocation}
          onClose={() => setEditingLocation(null)}
          onSaved={(saved) => {
            setEditingLocation(null);
            navigate(saved.id, "");
          }}
        />
      )}
      {editingLocation?.root.type === "local" && (
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
      {removingLocation && (
        <RemoveLocationDialog
          volume={removingLocation}
          onClose={() => setRemovingLocation(null)}
          onRemoved={() => {
            if (volume?.id === removingLocation.id) {
              setSelection(null);
              setSearch("");
              setMenu(null);
              setNotice("");
            }
            setRemovingLocation(null);
          }}
        />
      )}
      {dialog && (
        <StorageActionDialog
          dialog={dialog}
          mutation={mutation}
          submit={submit}
          name={name}
          setName={setName}
          readOnly={readOnly}
          setReadOnly={setReadOnly}
          onClose={() => setDialog(null)}
          onAddS3={() => setAddingS3(true)}
        />
      )}
    </div>
  );
}
