import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, LoaderCircle } from "lucide-react";
import { api, errorMessage } from "./api";
import { Modal } from "./components";
import { RemoteStorageDialog } from "./RemoteStorageDialog";
import { useBrowser } from "./store";
import type { Volume } from "./types";

type LocalEditProps = {
  volume: Volume;
  onClose: () => void;
  onSaved: (rootChanged: boolean) => void;
};

export function EditLocationDialog({
  volume,
  onClose,
  onSaved,
}: LocalEditProps) {
  const client = useQueryClient();
  const [name, setName] = useState(volume.name);
  const [readOnly, setReadOnly] = useState(volume.read_only);
  const [changeDirectory, setChangeDirectory] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const mutation = useMutation({
    mutationFn: () =>
      api.updateLocal(volume.id, name.trim(), readOnly, changeDirectory),
    onSuccess: async (updated) => {
      if (!updated) {
        setCancelled(true);
        return;
      }
      const rootChanged =
        JSON.stringify(updated.root) !== JSON.stringify(volume.root);
      if (rootChanged) {
        await client.cancelQueries({ queryKey: ["entries", volume.id] });
        useBrowser.getState().resetVolumeRoot(volume.id);
        await client.resetQueries({ queryKey: ["entries", volume.id] });
      }
      await client.invalidateQueries({ queryKey: ["volumes"] });
      onSaved(rootChanged);
    },
  });
  const valid =
    name.trim().length > 0 &&
    Array.from(name.trim()).length <= 100 &&
    !Array.from(name).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    );
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || mutation.isPending) return;
    setCancelled(false);
    mutation.mutate();
  }
  return (
    <Modal title="编辑连接" onClose={onClose} busy={mutation.isPending}>
      <form onSubmit={submit}>
        <fieldset className="connection-fields" disabled={mutation.isPending}>
          <label className="field-label" htmlFor="connection-name">
            连接名称
          </label>
          <input
            className="text-input"
            id="connection-name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={100}
          />
          <p className="field-help">
            仅修改 Filo 中的显示名称，不会重命名实际目录。
          </p>
          <div className="connection-root">
            <span className="field-label">本地目录</span>
            <div>
              <FolderOpen size={16} />
              <span>
                {volume.root.type === "local"
                  ? volume.root.root_path
                  : volume.name}
              </span>
            </div>
          </div>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={changeDirectory}
              onChange={(event) => setChangeDirectory(event.target.checked)}
            />
            更换本地目录
          </label>
          {changeDirectory && (
            <p className="field-help">
              保存时选择新目录。取消选择会保留所有原配置，不会移动现有文件。
            </p>
          )}
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={readOnly}
              onChange={(event) => setReadOnly(event.target.checked)}
            />
            只读访问
          </label>
          <p className="field-help">
            {readOnly
              ? "允许浏览，禁止新建、重命名和删除。"
              : "允许在系统权限范围内新建、重命名和删除；保存后立即生效。"}
          </p>
        </fieldset>
        {cancelled && (
          <p className="field-help" role="status">
            已取消选择，连接信息尚未更改。
          </p>
        )}
        {mutation.isError && (
          <p className="error-text" role="alert">
            {errorMessage(mutation.error)}
          </p>
        )}
        <div className="modal-footer">
          <button
            className="secondary"
            type="button"
            onClick={onClose}
            disabled={mutation.isPending}
          >
            取消
          </button>
          <button
            className="primary"
            type="submit"
            disabled={!valid || mutation.isPending}
          >
            {mutation.isPending && <LoaderCircle size={14} className="spin" />}
            {mutation.isPending
              ? "正在保存…"
              : changeDirectory
                ? "选择目录并保存"
                : "保存"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Remote locations use the protocol-aware editor and retain credentials by default. */
export function EditRemoteLocationDialog({
  volume,
  onClose,
  onSaved,
}: {
  volume: Volume;
  onClose: () => void;
  onSaved: (volume: Omit<Volume, "capabilities">) => void;
}) {
  return (
    <RemoteStorageDialog volume={volume} onClose={onClose} onSaved={onSaved} />
  );
}
