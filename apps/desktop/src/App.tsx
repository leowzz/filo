import { PreviewDialog } from "./PreviewDialog";
import { ContentSearchDialog } from "./ContentSearchDialog";
import { S3ManagerDialog } from "./S3ManagerDialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Info, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { updateTransfer } from "./transferPresentation";
import { api, desktop, errorMessage } from "./api";
import { runBatch } from "./batch";
import { DeleteEntryDialog } from "./DeleteEntryDialog";
import { EditLocationDialog } from "./EditLocationDialog";
import { EntryMenu } from "./EntryMenu";
import { LocationMenu, type LocationMenuTarget } from "./LocationMenu";
import { RemoveLocationDialog } from "./RemoveLocationDialog";
import { RemoteStorageDialog } from "./RemoteStorageDialog";
import { S3StorageDialog } from "./S3StorageDialog";
import { ConflictPolicyField } from "./ConflictPolicyField";
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
import { UploadDialog } from "./UploadDialog";
import type { ConflictPolicy } from "./types";
import { useDirectoryQuery } from "./useDirectoryQuery";
import { useFileSelection } from "./useFileSelection";
import {
  canCutVolume,
  canWriteVolume,
  clipboardSignature,
  destinationFor,
  pasteBlockReason,
  type ClipboardMode,
  type FileClipboard,
} from "./fileClipboard";

import { AppHeader } from "./AppHeader";
import { FileBrowser } from "./FileBrowser";
import { OverviewPage } from "./OverviewPage";
import { SettingsPage } from "./SettingsPage";
import { useAppUpdater } from "./useAppUpdater";
import { UpdateProgressDialog } from "./AppUpdateCard";
import { Sidebar } from "./Sidebar";
import { StorageActionDialog, type Dialog } from "./StorageActionDialog";

function textInputFocused() {
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    !!active.closest("input, textarea, select, [contenteditable='true']")
  );
}

function shortcutLabel(key: string) {
  const platform =
    typeof navigator === "undefined"
      ? ""
      : `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  return platform.includes("mac") ? `⌘${key}` : `Ctrl+${key}`;
}

export default function App() {
  const updater = useAppUpdater();
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
  const [uploadIds, setUploadIds] = useState<Set<string>>(() => new Set());
  const transferSequence = useRef(0);
  const [recentTransfer, setRecentTransfer] = useState<{
    id: number;
    jobIds: string[];
  } | null>(null);
  const previousTransfers = useRef<TransferJob[] | undefined>(undefined);
  type TrackedPasteJob = {
    entry: Entry;
    mode: ClipboardMode;
  };
  type PasteRetry = {
    clipboard: FileClipboard;
    signature: string;
    destination: Locator;
    entries: Entry[];
  };
  type PasteRun = {
    clipboard: FileClipboard;
    destination: Locator;
    items: Entry[];
    remaining: Entry[];
    failures: { item: Entry; error: unknown }[];
    started: number;
    completed: number;
    collecting: boolean;
  };
  const pasteJobs = useRef(new Map<string, TrackedPasteJob>());
  const pasteTerminalJobs = useRef(
    new Map<string, { job: TransferJob; entry: Entry; mode: ClipboardMode }>(),
  );
  const pasteRun = useRef<PasteRun | null>(null);
  const [pastePending, setPastePending] = useState(false);
  const [pasteRetry, setPasteRetry] = useState<PasteRetry | null>(null);
  const [pastePolicy, setPastePolicy] = useState<ConflictPolicy>("reject");
  useEffect(() => {
    const jobs = transfersQuery.data;
    if (!jobs) return;
    const previous = previousTransfers.current;
    previousTransfers.current = jobs;
    for (const job of jobs) settlePasteJob(job);
    if (!previous) return;
    const completedIds = new Set(
      previous.filter((job) => job.state === "completed").map((job) => job.id),
    );
    for (const job of jobs) {
      if (job.state !== "completed" || completedIds.has(job.id)) continue;
      const refreshParent = (locator: Locator) =>
        client.invalidateQueries({
          queryKey: [
            "entries",
            locator.volume_id,
            locator.logical_path.split("/").slice(0, -1).join("/"),
          ],
        });
      void refreshParent(job.destination);
      if (job.kind === "move") void refreshParent(job.source);
    }
  }, [client, transfersQuery.data]);
  const location = state.history[state.index];
  const volume = volumes.find((item) => item.id === location?.volumeId);
  const path = location?.path ?? "";
  const parent: Locator = {
    volume_id: volume?.id ?? "",
    logical_path: path,
    version_id: null,
  };
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState<Entry[] | null>(null);
  const [contentSearch, setContentSearch] = useState(false);
  const [s3Manager, setS3Manager] = useState<{
    locator: Locator;
    object: boolean;
  } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [name, setName] = useState("");
  const [renamePolicy, setRenamePolicy] = useState<ConflictPolicy>("reject");
  const [readOnly, setReadOnly] = useState(false);
  const [notice, setNotice] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{
    x: number;
    y: number;
    trigger: HTMLElement;
  } | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<{
    entries: Entry[];
    mode: DeleteMode;
  } | null>(null);
  const closeEntryMenu = useCallback(() => setMenu(null), []);
  const [locationMenu, setLocationMenu] = useState<LocationMenuTarget | null>(
    null,
  );
  const [editingLocation, setEditingLocation] = useState<Volume | null>(null);
  const [removingLocation, setRemovingLocation] = useState<Volume | null>(null);
  const [transferDialog, setTransferDialog] = useState<{
    entries: Entry[];
    kind: TransferKind;
  } | null>(null);
  const closeLocationMenu = useCallback(() => setLocationMenu(null), []);
  const [debouncedSearch, setDebouncedSearch] = useState(search);

  function sameLocator(left: Locator, right: Locator) {
    return (
      left.volume_id === right.volume_id &&
      left.logical_path === right.logical_path
    );
  }

  function finalizePasteRun() {
    const run = pasteRun.current;
    if (!run || run.collecting || pasteJobs.current.size > 0) return;
    const remaining = run.remaining.filter(
      (entry, index, all) =>
        all.findIndex(
          (item) =>
            item.locator.volume_id === entry.locator.volume_id &&
            item.locator.logical_path === entry.locator.logical_path,
        ) === index,
    );
    pasteTerminalJobs.current.clear();
    const currentClipboard = useBrowser.getState().clipboard;
    let retryClipboard = run.clipboard;
    if (run.clipboard.mode === "cut" && currentClipboard === run.clipboard) {
      useBrowser.getState().setClipboard(remaining, "cut");
      retryClipboard = useBrowser.getState().clipboard ?? run.clipboard;
    }
    setPasteRetry(
      remaining.length
        ? {
            clipboard: retryClipboard,
            signature: clipboardSignature(retryClipboard),
            destination: run.destination,
            entries: remaining,
          }
        : null,
    );
    setPastePending(false);
    pasteRun.current = null;
    if (remaining.length) {
      const failures = run.failures
        .filter(
          ({ item }, index, all) =>
            all.findIndex(
              ({ item: candidate }) =>
                candidate.locator.volume_id === item.locator.volume_id &&
                candidate.locator.logical_path === item.locator.logical_path,
            ) === index,
        )
        .slice(0, 3)
        .map(({ item, error }) => `${item.name}：${errorMessage(error)}`)
        .join("；");
      setNotice(
        `${run.completed} 项已完成，${remaining.length} 项未完成。${failures ? `${failures}。` : ""}已完成项目不会重复提交。`,
      );
    } else {
      setNotice(
        `已完成${run.clipboard.mode === "cut" ? "移动" : "复制"} ${run.completed} 项。`,
      );
    }
  }

  function settlePasteJob(job: TransferJob) {
    const tracked = pasteJobs.current.get(job.id);
    if (!tracked || activeTransfer(job)) return;
    pasteJobs.current.delete(job.id);
    pasteTerminalJobs.current.delete(job.id);
    const run = pasteRun.current;
    if (!run) return;
    const key = (entry: Entry) =>
      `${entry.locator.volume_id}:${entry.locator.logical_path}`;
    if (job.state === "completed") {
      run.completed += 1;
      run.remaining = run.remaining.filter(
        (entry) => key(entry) !== key(tracked.entry),
      );
    } else {
      run.failures.push({
        item: tracked.entry,
        error: job.error_message ?? `任务状态：${job.state}`,
      });
    }
    finalizePasteRun();
  }

  function trackPasteProgress(
    job: TransferJob,
    entry: Entry,
    mode: ClipboardMode,
  ) {
    client.setQueryData<TransferJob[]>(["transfers"], (current) =>
      updateTransfer(current, job),
    );
    if (activeTransfer(job)) return;
    if (!pasteRun.current) return;
    if (!pasteJobs.current.has(job.id)) {
      pasteTerminalJobs.current.set(job.id, { job, entry, mode });
      return;
    }
    // `mode` is supplied by the per-item observer so a terminal event cannot
    // accidentally settle a job from a later paste batch.
    if (pasteJobs.current.get(job.id)?.mode === mode) settlePasteJob(job);
  }

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const entriesQuery = useDirectoryQuery(
    parent,
    {
      search: debouncedSearch,
      show_hidden: state.showHidden,
      folders_only: false,
      sort: state.sort,
    },
    !!volume && state.page === "browser",
  );
  const entries = entriesQuery.entries;
  const selection = useFileSelection(
    JSON.stringify([
      state.page,
      parent.volume_id,
      path,
      search,
      state.showHidden,
      state.sort,
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
        return api.rename(dialog.entry.locator, name, renamePolicy);
    },
    onSettled: () => client.invalidateQueries({ queryKey: ["entries"] }),
    onSuccess: async (added) => {
      await client.invalidateQueries({ queryKey: ["volumes"] });
      await client.invalidateQueries({ queryKey: ["entries"] });
      if (added && typeof added === "object") navigate(added.id, "");
      if (dialog?.type !== "add")
        setNotice(
          dialog?.type === "rename"
            ? added === "skipped"
              ? "已跳过：同名项目已存在"
              : "重命名完成"
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
    setRenamePolicy("reject");
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
  const [uploadRequest, setUploadRequest] = useState<{
    remote: Locator;
    paths: string[];
    conflicts: string[];
  } | null>(null);
  const fileTransfer = useMutation({
    mutationFn: async ({
      remote,
      upload,
      paths,
      conflictPolicy = "reject",
      conflictPaths,
    }: {
      remote: Locator;
      upload: boolean;
      paths?: string[];
      conflictPolicy?: ConflictPolicy;
      conflictPaths?: string[];
    }) => {
      const id = ++transferSequence.current;
      const jobIds = new Set<string>();
      const revealTransfer = (job: TransferJob) => {
        if (!jobIds.has(job.id)) {
          jobIds.add(job.id);
          setRecentTransfer((current) =>
            current && current.id > id ? current : { id, jobIds: [...jobIds] },
          );
          if (upload)
            setUploadIds((current) =>
              current.has(job.id) ? current : new Set([...current, job.id]),
            );
        }
      };
      const notifiedFailures = new Set<string>();
      const onProgress = (job: TransferJob) => {
        if (upload && job.state === "failed" && !notifiedFailures.has(job.id)) {
          notifiedFailures.add(job.id);
          const conflict =
            job.error_code === "already_exists" ||
            job.error_code === "conflict";
          setNotice(
            conflict
              ? `“${job.destination.logical_path}”上传发生冲突，未完成。${job.error_message ?? "目标已有同名项目"}。请检查后重新上传并选择处理方式。`
              : `“${job.destination.logical_path}”上传失败：${job.error_message ?? "请检查后重试"}`,
          );
        }
        revealTransfer(job);
        client.setQueryData<TransferJob[]>(["transfers"], (current) =>
          updateTransfer(current, job),
        );
      };
      const batch = paths
        ? await api.uploadDroppedFiles(
            remote,
            paths,
            onProgress,
            conflictPolicy,
            conflictPaths,
          )
        : await api.transferLocalFile(
            remote,
            upload,
            onProgress,
            conflictPolicy,
          );
      // Fast tasks may finish before their progress channel is delivered.
      for (const job of batch?.jobs ?? []) {
        onProgress(job);
      }
      return batch;
    },
    onSuccess: (batch, { upload }) => {
      if (batch) {
        if (upload)
          setUploadIds(
            (current) =>
              new Set([...current, ...batch.jobs.map((job) => job.id)]),
          );
        void client.invalidateQueries({ queryKey: ["transfers"] });
        if (batch.failures.length)
          setNotice(
            `已提交 ${batch.jobs.length} 项，${batch.failures.length} 项未开始：${batch.failures.join("；")}`,
          );
      }
    },
    onError: (error) => setNotice(errorMessage(error)),
  });
  const uploadPreparing = useRef(false);
  const prepareUpload = useMutation({
    mutationFn: ({ remote, paths }: { remote: Locator; paths?: string[] }) =>
      api.preflightUpload(remote, paths),
    onSuccess: (result, { remote }) => {
      if (!result) return;
      if (result.conflicts.length) {
        setUploadRequest({ remote, ...result });
      } else {
        fileTransfer.mutate({
          remote,
          paths: result.paths,
          upload: true,
          conflictPolicy: "reject",
          conflictPaths: [],
        });
      }
    },
    onError: (error) => setNotice(`上传预检测失败：${errorMessage(error)}`),
    onSettled: () => {
      uploadPreparing.current = false;
    },
  });
  function requestUpload(remote: Locator, paths?: string[]) {
    if (uploadPreparing.current || uploadRequest || fileTransfer.isPending)
      return;
    uploadPreparing.current = true;
    prepareUpload.mutate({ remote, paths });
  }
  const pasteMutation = useMutation({
    mutationFn: async ({
      clipboard,
      destination,
      items,
      conflictPolicy,
    }: {
      clipboard: FileClipboard;
      destination: Locator;
      items: Entry[];
      conflictPolicy: ConflictPolicy;
    }) => {
      const run: PasteRun = {
        clipboard,
        destination,
        items,
        remaining: [...items],
        failures: [],
        started: 0,
        completed: 0,
        collecting: true,
      };
      pasteRun.current = run;
      pasteTerminalJobs.current.clear();
      setPastePending(true);
      const result = await runBatch(items, async (item) => {
        const job = await api.startTransfer(
          clipboard.mode === "cut" ? "move" : "copy",
          item.locator,
          destinationFor(item, destination),
          (progress) => trackPasteProgress(progress, item, clipboard.mode),
          conflictPolicy,
        );
        pasteJobs.current.set(job.id, { entry: item, mode: clipboard.mode });
        run.started += 1;
        const terminal = pasteTerminalJobs.current.get(job.id);
        if (terminal && terminal.mode === clipboard.mode) {
          pasteTerminalJobs.current.delete(job.id);
          settlePasteJob(terminal.job);
        } else if (!activeTransfer(job)) {
          // Some providers can finish before the progress channel is
          // delivered. Settle the returned terminal snapshot immediately so
          // a fast copy or move cannot leave pastePending stuck forever.
          settlePasteJob(job);
        }
        return job;
      });
      run.failures.push(...result.failed);
      run.collecting = false;
      finalizePasteRun();
      return result;
    },
    onError: (error) => {
      pasteJobs.current.clear();
      pasteTerminalJobs.current.clear();
      pasteRun.current = null;
      setPastePending(false);
      setNotice(errorMessage(error));
    },
  });

  function copySelection() {
    if (textInputFocused()) return;
    if (!volume || selectedEntries.length === 0) return;
    if (selectedEntries.some((entry) => entry.kind === "symlink")) {
      setNotice("符号链接不能复制");
      return;
    }
    state.setClipboard(selectedEntries, "copy");
    setPasteRetry(null);
    setPastePolicy("reject");
    setNotice(
      `已复制 ${selectedEntries.length} 项，按 ${shortcutLabel("V")} 粘贴`,
    );
  }

  function cutSelection() {
    if (textInputFocused()) return;
    if (!volume || selectedEntries.length === 0) return;
    if (selectedEntries.some((entry) => entry.kind === "symlink")) {
      setNotice("符号链接不能剪切");
      return;
    }
    if (!canCutVolume(volume)) {
      setNotice(
        volume.read_only
          ? "只读位置不能剪切，请使用复制"
          : !volume.capabilities.delete
            ? "当前位置不支持删除，不能剪切"
            : "当前位置不能剪切",
      );
      return;
    }
    state.setClipboard(selectedEntries, "cut");
    setPasteRetry(null);
    setPastePolicy("reject");
    setNotice(
      `已剪切 ${selectedEntries.length} 项，切换目录后按 ${shortcutLabel("V")} 粘贴`,
    );
  }

  function pasteSelection() {
    if (textInputFocused()) return;
    const clipboard = state.clipboard;
    if (!clipboard || clipboard.entries.length === 0) {
      setNotice("没有可粘贴的项目");
      return;
    }
    if (!volume || pastePending || pasteMutation.isPending) return;
    const retryMatches =
      !!pasteRetry &&
      pasteRetry.clipboard === clipboard &&
      pasteRetry.signature === clipboardSignature(clipboard) &&
      sameLocator(pasteRetry.destination, parent);
    const items =
      retryMatches && pasteRetry ? pasteRetry.entries : clipboard.entries;
    const blockReason = pasteBlockReason(
      { ...clipboard, entries: items },
      parent,
      volume,
    );
    if (blockReason) {
      setNotice(blockReason);
      return;
    }
    setNotice(
      `正在${clipboard.mode === "cut" ? "移动" : "复制"} ${items.length} 项…`,
    );
    pasteMutation.mutate({
      clipboard,
      destination: parent,
      items,
      conflictPolicy: pastePolicy,
    });
  }

  useEffect(() => {
    const handleGlobalShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        !(event.metaKey || event.ctrlKey) ||
        state.page !== "browser" ||
        textInputFocused() ||
        document.querySelector("dialog[open], [role=menu], details[open]")
      )
        return;
      const key = event.key.toLowerCase();
      if (!(["c", "x", "v"] as string[]).includes(key)) return;
      event.preventDefault();
      if (key === "c") copySelection();
      else if (key === "x") cutSelection();
      else pasteSelection();
    };
    document.addEventListener("keydown", handleGlobalShortcut);
    return () => document.removeEventListener("keydown", handleGlobalShortcut);
  }, [
    pasteMutation.isPending,
    pastePending,
    pastePolicy,
    pasteRetry,
    selectedEntries,
    state.page,
    volume,
  ]);

  const pasteFromBrowser = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.repeat ||
      event.altKey ||
      !(event.metaKey || event.ctrlKey) ||
      event.key.toLowerCase() !== "v" ||
      state.page !== "browser" ||
      document.querySelector('dialog[open], [role="menu"]') ||
      (event.target instanceof Element &&
        event.target.closest("input, textarea, select, [contenteditable]"))
    )
      return;
    event.preventDefault();
    pasteSelection();
  });
  useEffect(() => {
    window.addEventListener("keydown", pasteFromBrowser);
    return () => window.removeEventListener("keydown", pasteFromBrowser);
  }, []);

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
    if (!selectedPaths.has(entry.locator.logical_path))
      setSelection(entry.locator.logical_path);
    setMenuPosition({ x, y, trigger });
    setMenu(entry.locator.logical_path);
  }
  const menuEntry = entries.find(
    (entry) => entry.locator.logical_path === menu,
  );
  const retryAvailable =
    !!pasteRetry &&
    pasteRetry.clipboard === state.clipboard &&
    !!state.clipboard &&
    pasteRetry.signature === clipboardSignature(state.clipboard) &&
    sameLocator(pasteRetry.destination, parent);
  const openVolume = (item: Volume) => navigate(item.id, "");

  return (
    <div className="app-shell">
      {updater.busy && <UpdateProgressDialog updater={updater} />}
      <Sidebar
        version={updater.version}
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
          selectedEntries={selectedEntries}
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
          transferPending={fileTransfer.isPending || prepareUpload.isPending}
          pastePending={pastePending}
          openEntry={openEntry}
          openDialog={openDialog}
          setTransferDialog={setTransferDialog}
          setDeleteDialog={setDeleteDialog}
          onFileTransfer={(request) =>
            request.upload
              ? requestUpload(request.remote)
              : fileTransfer.mutate({ ...request, conflictPolicy: "overwrite" })
          }
          onPreview={() => setPreview(selectedEntries)}
          onCopy={copySelection}
          onCut={cutSelection}
          onPaste={pasteSelection}
          onContentSearch={() => setContentSearch(true)}
          onManage={(object) =>
            setS3Manager({
              locator: object && selected ? selected.locator : parent,
              object,
            })
          }
          onRefresh={() => {
            void entriesQuery.refetch();
            void client.invalidateQueries({ queryKey: ["preview"] });
          }}
          isFetching={entriesQuery.isFetching}
          onOpenTransferDirectory={async (job) => {
            const target = volumes.find(
              (item) => item.id === job.destination.volume_id,
            );
            if (target && target.root.type !== "local") {
              navigate(
                target.id,
                job.destination.logical_path.split("/").slice(0, -1).join("/"),
              );
            } else {
              await api.openTransferFile(job.id, true);
            }
          }}
          transfers={transfersQuery.data ?? []}
          uploadIds={uploadIds}
          recentTransfer={recentTransfer}
          transfersLoading={transfersQuery.isPending}
          transfersError={transfersQuery.isError}
          onRetryTransfers={() => void transfersQuery.refetch()}
        />

        {volumesQuery.isError && (
          <div className="error-banner" role="alert">
            {errorMessage(volumesQuery.error)}
            <button onClick={() => void volumesQuery.refetch()}>重试</button>
          </div>
        )}
        {updater.availableVersion && state.page !== "settings" && (
          <div className="notice" role="status">
            <Info size={16} />
            Filo {updater.availableVersion} 已可用
            <button onClick={() => state.setPage("settings")}>查看更新</button>
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
            {retryAvailable && pasteRetry && (
              <div
                className="paste-retry-bar"
                role="group"
                aria-label="粘贴重试选项"
              >
                <span>还有 {pasteRetry.entries.length} 项未完成</span>
                <ConflictPolicyField
                  value={pastePolicy}
                  onChange={setPastePolicy}
                />
                <button
                  className="secondary"
                  disabled={pastePending}
                  onClick={pasteSelection}
                >
                  重试未完成项
                </button>
              </div>
            )}
            <FileBrowser
              key={JSON.stringify([
                volume.id,
                path,
                debouncedSearch,
                state.sort,
                state.showHidden,
              ])}
              volume={volume}
              path={path}
              entries={entries}
              entriesQuery={entriesQuery}
              search={search}
              sort={state.sort}
              setSort={state.setSort}
              selection={selection}
              selectedEntries={selectedEntries}
              clipboardMode={state.clipboard?.mode ?? null}
              clipboardCount={state.clipboard?.entries.length ?? 0}
              clipboardPaths={
                new Set(
                  state.clipboard?.entries.map(
                    (entry) => entry.locator.logical_path,
                  ) ?? [],
                )
              }
              pastePending={pastePending}
              onPreview={() => setPreview(selectedEntries)}
              onCopy={copySelection}
              onCut={cutSelection}
              onPaste={pasteSelection}
              uploadPending={fileTransfer.isPending || prepareUpload.isPending}
              onFileDrop={(paths) => {
                setMenu(null);
                requestUpload(parent, paths);
              }}
              onDropError={setNotice}
              menu={menu}
              setMenu={setMenu}
              openEntry={openEntry}
              showEntryMenu={showEntryMenu}
              navigate={navigate}
            />
          </>
        )}

        {state.page === "transfers" && <TransfersPage volumes={volumes} />}
        {state.page === "settings" && <SettingsPage updater={updater} />}
      </main>

      {preview && (
        <PreviewDialog entries={preview} onClose={() => setPreview(null)} />
      )}
      {contentSearch && volume && (
        <ContentSearchDialog
          parent={parent}
          showHidden={state.showHidden}
          onClose={() => setContentSearch(false)}
          onPreview={(entry) => setPreview([entry])}
        />
      )}
      {s3Manager && volume && (
        <S3ManagerDialog
          {...s3Manager}
          volume={volume}
          onClose={() => setS3Manager(null)}
        />
      )}
      {menuEntry && volume && menuPosition && (
        <EntryMenu
          entry={menuEntry}
          entries={selectedEntries}
          volume={volume}
          position={menuPosition}
          onClose={closeEntryMenu}
          onOpen={() => openEntry(menuEntry)}
          onDetails={() => showDetails(menuEntry)}
          onPreview={() => setPreview(selectedEntries)}
          onCopy={copySelection}
          onCut={cutSelection}
          onPaste={pasteSelection}
          hasClipboard={(state.clipboard?.entries.length ?? 0) > 0}
          canPaste={canWriteVolume(volume) && !pastePending}
          onUpload={() => requestUpload(parent)}
          onDownload={() =>
            fileTransfer.mutate({
              remote: menuEntry.locator,
              upload: false,
              conflictPolicy: "overwrite",
            })
          }
          onManage={() =>
            setS3Manager({ locator: menuEntry.locator, object: true })
          }
          onRename={() => openDialog({ type: "rename", entry: menuEntry })}
          onTransfer={(kind) =>
            setTransferDialog({ entries: selectedEntries, kind })
          }
          onDelete={(mode) =>
            setDeleteDialog({ entries: selectedEntries, mode })
          }
        />
      )}
      {deleteDialog && volume && (
        <DeleteEntryDialog
          {...deleteDialog}
          volume={volume}
          onClose={() => setDeleteDialog(null)}
          onDeleted={(message) => {
            setNotice(message);
            setSelection(null);
            setDeleteDialog(null);
          }}
        />
      )}
      {uploadRequest && (
        <UploadDialog
          paths={uploadRequest.conflicts}
          total={uploadRequest.paths.length}
          destination={`${volumes.find((item) => item.id === uploadRequest.remote.volume_id)?.name ?? ""}/${uploadRequest.remote.logical_path}`}
          onClose={() => setUploadRequest(null)}
          onStart={(conflictPolicy) => {
            fileTransfer.mutate({
              remote: uploadRequest.remote,
              paths: uploadRequest.paths,
              conflictPaths: uploadRequest.conflicts,
              upload: true,
              conflictPolicy,
            });
            setUploadRequest(null);
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
      {editingLocation?.root.type === "remote" && (
        <RemoteStorageDialog
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
          conflictPolicy={renamePolicy}
          setConflictPolicy={setRenamePolicy}
          mutation={mutation}
          submit={submit}
          name={name}
          setName={setName}
          readOnly={readOnly}
          setReadOnly={setReadOnly}
          onClose={() => setDialog(null)}
          onSavedS3={(saved) => {
            setDialog(null);
            navigate(saved.id, "");
          }}
        />
      )}
    </div>
  );
}
