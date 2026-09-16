import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Folder, ArrowUp, LoaderCircle } from "lucide-react";
import { updateTransfer } from "./transferPresentation";
import { api, errorMessage } from "./api";
import { runBatch, type BatchFailure } from "./batch";
import { useDirectoryQuery } from "./useDirectoryQuery";
import { ConflictPolicyField } from "./ConflictPolicyField";
import { canWriteVolume } from "./fileClipboard";
import { type ConflictPolicy } from "./types";
import { Modal } from "./components";
import {
  activeTransfer,
  isDirectory,
  type Entry,
  type TransferKind,
  type TransferJob,
  type Volume,
} from "./types";

export function TransferDialog({
  entries,
  kind,
  volumes,
  onClose,
  onStarted,
}: {
  entries: Entry[];
  kind: TransferKind;
  volumes: Volume[];
  onClose: () => void;
  onStarted: () => void;
}) {
  const entry = entries[0];
  const [remaining, setRemaining] = useState(entries);
  const [failures, setFailures] = useState<BatchFailure<Entry>[]>([]);
  const [submitted, setSubmitted] = useState(0);
  const multiple = entries.length > 1;
  const writable = volumes.filter(canWriteVolume);
  const [volumeId, setVolumeId] = useState(
    writable.find((volume) => volume.id !== entry.locator.volume_id)?.id ??
      writable[0]?.id ??
      "",
  );
  const [path, setPath] = useState("");
  const [name, setName] = useState(entry.name);
  const client = useQueryClient();
  const [conflictPolicy, setConflictPolicy] =
    useState<ConflictPolicy>("reject");
  const [folderPage, setFolderPage] = useState(0);
  const entriesQuery = useDirectoryQuery(
    { volume_id: volumeId, logical_path: path, version_id: null },
    { search: "", show_hidden: true, folders_only: true, sort: "name" },
  );
  const folders = entriesQuery.data?.pages[folderPage]?.entries ?? [];
  const changePath = (next: string) => {
    setPath(next);
    setFolderPage(0);
  };
  const targetPath = (item: Entry) =>
    path
      ? `${path}/${multiple ? item.name : name}`
      : multiple
        ? item.name
        : name;
  const sameFile = remaining.some(
    (item) =>
      volumeId === item.locator.volume_id &&
      ((conflictPolicy !== "rename" &&
        targetPath(item) === item.locator.logical_path) ||
        (isDirectory(item) &&
          targetPath(item).startsWith(`${item.locator.logical_path}/`))),
  );
  const valid =
    name.trim().length > 0 &&
    ![".", ".."].includes(name) &&
    !["/", "\\", ":", String.fromCharCode(0)].some((character) =>
      name.includes(character),
    );
  const mutation = useMutation({
    mutationFn: () =>
      runBatch(remaining, (item) =>
        api.startTransfer(
          kind,
          item.locator,
          {
            volume_id: volumeId,
            logical_path: targetPath(item),
            version_id: null,
          },
          (job) => {
            client.setQueryData<TransferJob[]>(["transfers"], (current) =>
              updateTransfer(current, job),
            );
            if (!activeTransfer(job))
              void client.invalidateQueries({ queryKey: ["entries"] });
          },
          conflictPolicy,
        ),
      ),
    onSuccess: async ({ completed, failed }) => {
      setSubmitted((count) => count + completed.length);
      setRemaining(failed.map(({ item }) => item));
      setFailures(failed);
      await client.invalidateQueries({ queryKey: ["transfers"] });
      if (failed.length === 0) onStarted();
    },
  });
  return (
    <Modal
      title={`${kind === "copy" ? "复制" : "移动"}${multiple ? ` ${entries.length} 个项目` : isDirectory(entry) ? "文件夹" : "文件"}`}
      onClose={onClose}
      busy={mutation.isPending}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (
            valid &&
            volumeId &&
            !sameFile &&
            !mutation.isPending &&
            entriesQuery.isSuccess
          )
            mutation.mutate();
        }}
      >
        <p className="modal-description">
          {multiple ? `已选 ${entries.length} 项，保留各自名称。` : entry.name}
        </p>
        {multiple && (
          <ul className="batch-items">
            {entries.map((item) => (
              <li key={item.locator.logical_path}>
                {item.name}
                {isDirectory(item) ? "（含全部内容）" : ""}
              </li>
            ))}
          </ul>
        )}
        <fieldset className="connection-fields" disabled={mutation.isPending}>
          <label className="field-label" htmlFor="target-volume">
            目标位置
          </label>
          <select
            id="target-volume"
            className="text-input"
            value={volumeId}
            onChange={(event) => {
              setVolumeId(event.target.value);
              changePath("");
            }}
          >
            {writable.length === 0 && <option value="">没有可写的位置</option>}
            {writable.map((volume) => (
              <option key={volume.id} value={volume.id}>
                {volume.name}
              </option>
            ))}
          </select>
          <div className="destination-browser">
            <div className="destination-path">
              <button
                type="button"
                className="icon-button"
                aria-label="目标上级目录"
                disabled={!path}
                onClick={() =>
                  changePath(path.split("/").slice(0, -1).join("/"))
                }
              >
                <ArrowUp size={16} />
              </button>
              <span>{path ? `/${path}` : "/"}</span>
            </div>
            <div className="destination-folders">
              {entriesQuery.isPending && volumeId && <p>正在读取目录…</p>}
              {entriesQuery.isError && (
                <p className="error-text">
                  {errorMessage(entriesQuery.error)}
                  <button
                    type="button"
                    onClick={() => void entriesQuery.refetch()}
                  >
                    重试
                  </button>
                </p>
              )}
              {folders.map((folder) => (
                <button
                  type="button"
                  key={folder.locator.logical_path}
                  onClick={() => changePath(folder.locator.logical_path)}
                >
                  <Folder size={17} />
                  <span>{folder.name}</span>
                  <ChevronRight size={15} />
                </button>
              ))}
              {entriesQuery.isSuccess && entriesQuery.total === 0 && (
                <p>此目录没有子文件夹</p>
              )}
            </div>
            <div className="destination-path">
              <button
                type="button"
                disabled={folderPage === 0 || entriesQuery.isFetching}
                onClick={() => setFolderPage(folderPage - 1)}
              >
                上一页
              </button>
              <span>{entriesQuery.total} 个文件夹</span>
              <button
                type="button"
                disabled={
                  entriesQuery.isFetching ||
                  (!entriesQuery.hasNextPage &&
                    folderPage >= (entriesQuery.data?.pages.length ?? 1) - 1)
                }
                onClick={async () => {
                  if (
                    folderPage >=
                    (entriesQuery.data?.pages.length ?? 1) - 1
                  ) {
                    const result = await entriesQuery.fetchNextPage();
                    if (result.isError) return;
                  }
                  setFolderPage(folderPage + 1);
                }}
              >
                下一页
              </button>
            </div>
          </div>
          {!multiple && (
            <>
              <label className="field-label" htmlFor="target-name">
                目标名称
              </label>
              <input
                id="target-name"
                className="text-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </>
          )}
          <ConflictPolicyField
            value={conflictPolicy}
            onChange={setConflictPolicy}
          />
          <p className="field-help">
            {!volumeId
              ? "请先添加可写位置，或右键位置关闭只读访问。"
              : sameFile
                ? "目标不能是源项目本身或源文件夹内部。"
                : kind === "move"
                  ? "内容复制并校验成功后才清理源位置。"
                  : "复制文件夹内全部内容，包括隐藏文件和空目录。"}
          </p>
        </fieldset>
        {failures.length > 0 && (
          <div role="alert">
            <p className="error-text">
              已提交 {submitted} 项，{failures.length}{" "}
              项未开始。再次提交只处理未开始的项目。
            </p>
            <ul className="batch-items">
              {failures.map(({ item, error }) => (
                <li key={item.locator.logical_path}>
                  <strong>{item.name}</strong>：{errorMessage(error)}
                </li>
              ))}
            </ul>
          </div>
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
            onClick={onClose}
          >
            关闭
          </button>
          {submitted > 0 && (
            <button
              type="button"
              className="secondary"
              disabled={mutation.isPending}
              onClick={onStarted}
            >
              查看传输任务
            </button>
          )}
          <button
            className="primary"
            disabled={
              !valid ||
              !volumeId ||
              sameFile ||
              mutation.isPending ||
              !entriesQuery.isSuccess
            }
          >
            {mutation.isPending && <LoaderCircle size={14} className="spin" />}
            {kind === "copy" ? "开始复制" : "开始移动"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
