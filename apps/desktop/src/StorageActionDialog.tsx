import { LoaderCircle } from "lucide-react";
import { type FormEvent } from "react";
import { errorMessage } from "./api";
import { Modal } from "./components";
import { ConflictPolicyField } from "./ConflictPolicyField";
import type { ConflictPolicy } from "./types";
import { type Entry, type Volume } from "./types";
import { AddStorageDialog } from "./AddStorageDialog";

export type Dialog =
  { type: "add" } | { type: "folder" } | { type: "rename"; entry: Entry };

export function StorageActionDialog({
  dialog,
  conflictPolicy,
  setConflictPolicy,
  mutation,
  submit,
  name,
  setName,
  readOnly,
  setReadOnly,
  onClose,
  onSavedS3,
}: {
  dialog: Dialog;
  conflictPolicy: ConflictPolicy;
  setConflictPolicy: (policy: ConflictPolicy) => void;
  mutation: { isPending: boolean; isError: boolean; error: unknown };
  submit: (event: FormEvent) => void;
  name: string;
  setName: (name: string) => void;
  readOnly: boolean;
  setReadOnly: (readOnly: boolean) => void;
  onClose: () => void;
  onSavedS3: (volume: Omit<Volume, "capabilities">) => void;
}) {
  if (dialog.type === "add")
    return (
      <AddStorageDialog
        mutation={mutation}
        submit={submit}
        readOnly={readOnly}
        setReadOnly={setReadOnly}
        onClose={onClose}
        onSaved={onSavedS3}
      />
    );
  return (
    <Modal
      title={dialog.type === "folder" ? "新建文件夹" : "重命名"}
      busy={mutation.isPending}
      onClose={() => onClose()}
    >
      <form onSubmit={submit}>
        <label className="field-label" htmlFor="entry-name">
          {dialog.type === "folder" ? "文件夹名称" : "新名称"}
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
        {dialog.type === "rename" && (
          <ConflictPolicyField
            value={conflictPolicy}
            onChange={setConflictPolicy}
          />
        )}
        <p className="field-help">
          {dialog.type === "folder"
            ? "将在当前目录中创建，不会覆盖已有项目。"
            : "文件夹内的内容会一并处理，远程操作进度可在传输任务中查看。"}
        </p>
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
            onClick={() => onClose()}
          >
            取消
          </button>
          <button
            type="submit"
            className="primary"
            disabled={
              mutation.isPending ||
              ((dialog.type === "folder" || dialog.type === "rename") &&
                (!name.trim() ||
                  name === "." ||
                  name === ".." ||
                  /[/\\:\0]/.test(name)))
            }
          >
            {mutation.isPending ? (
              <LoaderCircle size={16} className="spin" />
            ) : null}
            {mutation.isPending
              ? "正在处理…"
              : dialog.type === "folder"
                ? "创建文件夹"
                : "保存名称"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
