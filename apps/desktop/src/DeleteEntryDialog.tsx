import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Trash2 } from "lucide-react";
import { api, errorMessage } from "./api";
import { Modal } from "./components";
import type { DeleteMode, DeleteOutcome, Entry, Volume } from "./types";

export function DeleteEntryDialog({
  entry,
  mode,
  volume,
  onClose,
  onDeleted,
}: {
  entry: Entry;
  mode: DeleteMode;
  volume: Volume;
  onClose: () => void;
  onDeleted: (outcome: DeleteOutcome) => void;
}) {
  const client = useQueryClient();
  const [trashUnavailable, setTrashUnavailable] = useState(false);
  const toTrash =
    mode === "default" && volume.capabilities.trash && !trashUnavailable;
  const mutation = useMutation({
    mutationFn: (requestedMode: DeleteMode) =>
      api.delete(entry.locator, requestedMode),
    onError: (error, requestedMode) => {
      if (
        requestedMode === "default" &&
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "trash_unavailable"
      ) {
        setTrashUnavailable(true);
      }
    },
    onSuccess: async (outcome) => {
      await client.invalidateQueries({ queryKey: ["entries", volume.id] });
      onDeleted(outcome);
    },
  });
  return (
    <Modal
      title={
        trashUnavailable
          ? "无法移入回收站"
          : toTrash
            ? "移入回收站"
            : "永久删除"
      }
      onClose={onClose}
      busy={mutation.isPending}
    >
      <div className="delete-icon">
        <Trash2 size={25} />
      </div>
      <p className="modal-description">
        {toTrash ? "将" : "永久删除"} <strong>{entry.name}</strong>
        {toTrash ? " 移入系统回收站？" : "？"}
      </p>
      <p className="delete-warning">
        {toTrash
          ? "可以在系统回收站中找回。文件夹会连同其中的内容一起移入回收站。"
          : `${trashUnavailable ? "此项目无法放入回收站。" : mode === "default" ? "此存储不支持回收站。" : "此操作会跳过回收站。"}继续删除将永久删除，无法找回。${entry.kind === "directory" ? "当前仅允许永久删除空文件夹。" : ""}`}
      </p>
      {mutation.isError &&
        !(trashUnavailable && mutation.variables === "default") && (
          <p className="error-text" role="alert">
            {errorMessage(mutation.error)}
          </p>
        )}
      <div className="modal-footer">
        <button
          className="secondary"
          disabled={mutation.isPending}
          onClick={onClose}
        >
          取消
        </button>
        <button
          className={toTrash ? "primary" : "danger"}
          disabled={mutation.isPending}
          onClick={() => mutation.mutate(trashUnavailable ? "permanent" : mode)}
        >
          {mutation.isPending && <LoaderCircle size={16} className="spin" />}
          {mutation.isPending
            ? "正在处理…"
            : toTrash
              ? "移入回收站"
              : trashUnavailable
                ? "仍然永久删除"
                : "确认永久删除"}
        </button>
      </div>
    </Modal>
  );
}
