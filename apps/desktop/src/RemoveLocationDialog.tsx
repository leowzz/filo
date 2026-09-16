import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { api, errorMessage } from "./api";
import { Modal } from "./components";
import { useBrowser } from "./store";
import type { Volume } from "./types";

export function RemoveLocationDialog({
  volume,
  onClose,
  onRemoved,
}: {
  volume: Volume;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api.removeLocal(volume.id),
    onSuccess: async () => {
      await client.cancelQueries({ queryKey: ["entries", volume.id] });
      useBrowser.getState().removeVolume(volume.id);
      client.setQueryData<Volume[]>(["volumes"], (current) =>
        current?.filter((item) => item.id !== volume.id),
      );
      client.removeQueries({ queryKey: ["entries", volume.id] });
      await client.invalidateQueries({ queryKey: ["volumes"] });
      onRemoved();
    },
  });
  return (
    <Modal title="移除位置" onClose={onClose} busy={mutation.isPending}>
      <p className="modal-description">
        将「{volume.name}」从 Filo
        的位置列表中移除？存储中的目录和文件会保留，你可以随时重新添加。
      </p>
      {mutation.isError && (
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
          className="primary"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending && <LoaderCircle size={14} className="spin" />}
          {mutation.isPending ? "正在移除…" : "移除位置"}
        </button>
      </div>
    </Modal>
  );
}
