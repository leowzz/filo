import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Folder, ArrowUp, LoaderCircle } from "lucide-react";
import { api, errorMessage } from "./api";
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
  entry,
  kind,
  volumes,
  onClose,
  onStarted,
}: {
  entry: Entry;
  kind: TransferKind;
  volumes: Volume[];
  onClose: () => void;
  onStarted: () => void;
}) {
  const writable = volumes.filter((volume) => !volume.read_only);
  const [volumeId, setVolumeId] = useState(
    writable.find((volume) => volume.id !== entry.locator.volume_id)?.id ??
      writable[0]?.id ??
      "",
  );
  const [path, setPath] = useState("");
  const [name, setName] = useState(entry.name);
  const client = useQueryClient();
  const entriesQuery = useQuery({
    queryKey: ["entries", volumeId, path],
    queryFn: () =>
      api.entries({
        volume_id: volumeId,
        logical_path: path,
        version_id: null,
      }),
    enabled: !!volumeId,
  });
  const destinationPath = path ? `${path}/${name}` : name;
  const sameFile =
    volumeId === entry.locator.volume_id &&
    destinationPath === entry.locator.logical_path;
  const valid =
    name.trim().length > 0 &&
    ![".", ".."].includes(name) &&
    !["/", "\\", ":", String.fromCharCode(0)].some((character) =>
      name.includes(character),
    );
  const mutation = useMutation({
    mutationFn: () =>
      api.startTransfer(
        kind,
        entry.locator,
        {
          volume_id: volumeId,
          logical_path: destinationPath,
          version_id: null,
        },
        (job) => {
          client.setQueryData<TransferJob[]>(["transfers"], (current) => [
            job,
            ...(current ?? []).filter((item) => item.id !== job.id),
          ]);
          if (!activeTransfer(job))
            void client.invalidateQueries({ queryKey: ["entries"] });
        },
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["transfers"] });
      onStarted();
    },
  });
  return (
    <Modal
      title={kind === "copy" ? "复制文件" : "移动文件"}
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
        <p className="modal-description">{entry.name}</p>
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
              setPath("");
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
                onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}
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
              {entriesQuery.data?.filter(isDirectory).map((folder) => (
                <button
                  type="button"
                  key={folder.locator.logical_path}
                  onClick={() => setPath(folder.locator.logical_path)}
                >
                  <Folder size={17} />
                  <span>{folder.name}</span>
                  <ChevronRight size={15} />
                </button>
              ))}
              {entriesQuery.isSuccess &&
                !entriesQuery.data.some(isDirectory) && (
                  <p>此目录没有子文件夹</p>
                )}
            </div>
          </div>
          <label className="field-label" htmlFor="target-name">
            目标文件名
          </label>
          <input
            id="target-name"
            className="text-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
          <p className="field-help">
            {!volumeId
              ? "请先添加可写位置，或右键位置关闭只读访问。"
              : sameFile
                ? "源文件和目标文件相同，请选择另一个目录或更改文件名。"
                : kind === "move"
                  ? "目标保存成功后才移除源文件。同名文件不会被覆盖。"
                  : "复制后保留源文件。同名文件不会被覆盖。"}
          </p>
        </fieldset>
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
            取消
          </button>
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
