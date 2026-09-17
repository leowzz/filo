import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Trash2 } from "lucide-react";
import { api, errorMessage } from "./api";
import { runBatch, type BatchFailure } from "./batch";
import { Modal } from "./components";
import { isDirectory, type DeleteMode, type Entry, type Volume } from "./types";

function unavailable(error: unknown) {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "trash_unavailable"
  );
}

export function DeleteEntryDialog({
  entries,
  mode,
  volume,
  onClose,
  onDeleted,
}: {
  entries: Entry[];
  mode: DeleteMode;
  volume: Volume;
  onClose: () => void;
  onDeleted: (message: string) => void;
}) {
  const client = useQueryClient();
  const [remaining, setRemaining] = useState(entries);
  const [failures, setFailures] = useState<BatchFailure<Entry>[]>([]);
  const [totals, setTotals] = useState({ trashed: 0, permanent: 0 });
  const [confirmPermanent, setConfirmPermanent] = useState(false);
  const toTrash =
    mode === "default" && volume.capabilities.trash && !confirmPermanent;
  const unavailableEntries = failures
    .filter(({ error }) => unavailable(error))
    .map(({ item }) => item);
  const targets = confirmPermanent ? unavailableEntries : remaining;
  const mutation = useMutation({
    mutationFn: () =>
      runBatch(targets, (entry) =>
        api.delete(
          entry.locator,
          confirmPermanent ? "permanent" : mode,
          isDirectory(entry),
        ),
      ),
    onSuccess: async ({ completed, failed }) => {
      const processed = new Set(
        targets.map((entry) => entry.locator.logical_path),
      );
      const nextFailures = [
        ...failures.filter(
          ({ item }) => !processed.has(item.locator.logical_path),
        ),
        ...failed,
      ];
      const nextRemaining = [
        ...remaining.filter(
          (item) => !processed.has(item.locator.logical_path),
        ),
        ...failed.map(({ item }) => item),
      ];
      const nextTotals = {
        trashed:
          totals.trashed +
          completed.filter(({ result }) => result === "trashed").length,
        permanent:
          totals.permanent +
          completed.filter(({ result }) => result === "permanently_deleted")
            .length,
      };
      setTotals(nextTotals);
      setFailures(nextFailures);
      setRemaining(nextRemaining);
      setConfirmPermanent(false);
      await client.invalidateQueries({ queryKey: ["entries", volume.id] });
      if (nextRemaining.length === 0) {
        onDeleted(
          [
            nextTotals.trashed ? `${nextTotals.trashed} 项已移入回收站` : "",
            nextTotals.permanent ? `${nextTotals.permanent} 项已永久删除` : "",
          ]
            .filter(Boolean)
            .join("，"),
        );
      }
    },
  });
  return (
    <Modal
      title={toTrash ? "移入回收站" : "永久删除"}
      className="delete-dialog"
      onClose={onClose}
      busy={mutation.isPending}
    >
      <div className="delete-summary">
        <div className="delete-icon">
          <Trash2 size={22} />
        </div>
        <div className="delete-copy">
          <p className="modal-description">
            {toTrash ? "将" : "确定删除"}{" "}
            <strong>
              {targets.length === 1
                ? targets[0].name
                : `选中的 ${targets.length} 个项目`}
            </strong>
            {targets.length === 1 && isDirectory(targets[0])
              ? "（含全部文件及子文件夹）"
              : ""}
            {toTrash ? "移入系统回收站？" : "？"}
          </p>
          {targets.length > 1 && (
            <ul className="batch-items">
              {targets.map((entry) => (
                <li key={entry.locator.logical_path}>
                  {entry.name}
                  {isDirectory(entry) ? "（含全部文件及子文件夹）" : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <p className="delete-warning">
        {toTrash
          ? "文件夹会连同全部内容一起移入回收站，可以在系统回收站中找回。"
          : "将永久删除所选项目及文件夹内全部内容，包括隐藏文件。此操作无法撤销。"}
      </p>
      {confirmPermanent && (
        <p className="delete-warning">
          以下项目未能移入回收站。仅在再次确认后永久删除。
        </p>
      )}
      {failures.length > 0 && (
        <div role="alert">
          <p className="error-text">
            已处理 {totals.trashed + totals.permanent} 项，{remaining.length}{" "}
            项未完成。重试只处理未完成项。
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
          className="secondary"
          disabled={mutation.isPending}
          onClick={
            confirmPermanent ? () => setConfirmPermanent(false) : onClose
          }
        >
          {confirmPermanent ? "返回" : "关闭"}
        </button>
        {!confirmPermanent && unavailableEntries.length > 0 && (
          <button
            className="secondary"
            disabled={mutation.isPending}
            onClick={() => setConfirmPermanent(true)}
          >
            改为永久删除 {unavailableEntries.length} 项…
          </button>
        )}
        <button
          className={toTrash ? "primary" : "danger"}
          disabled={mutation.isPending || targets.length === 0}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending && <LoaderCircle size={16} className="spin" />}
          {mutation.isPending
            ? "正在处理…"
            : toTrash
              ? failures.length
                ? "重试移入回收站"
                : "移入回收站"
              : "确认永久删除"}
        </button>
      </div>
    </Modal>
  );
}
