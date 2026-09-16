import {
  Check,
  ChevronRight,
  Cloud,
  FolderOpen,
  HardDrive,
  LoaderCircle,
} from "lucide-react";
import { type FormEvent } from "react";
import { desktop, errorMessage } from "./api";
import { Modal } from "./components";
import { type Entry } from "./types";

export type Dialog =
  { type: "add" } | { type: "folder" } | { type: "rename"; entry: Entry };

export function StorageActionDialog({
  dialog,
  mutation,
  submit,
  name,
  setName,
  readOnly,
  setReadOnly,
  onClose,
  onAddS3,
}: {
  dialog: Dialog;
  mutation: { isPending: boolean; isError: boolean; error: unknown };
  submit: (event: FormEvent) => void;
  name: string;
  setName: (name: string) => void;
  readOnly: boolean;
  setReadOnly: (readOnly: boolean) => void;
  onClose: () => void;
  onAddS3: () => void;
}) {
  return (
    <Modal
      title={
        dialog.type === "add"
          ? "添加存储空间"
          : dialog.type === "folder"
            ? "新建文件夹"
            : "重命名"
      }
      busy={mutation.isPending}
      onClose={() => onClose()}
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
            <button
              type="button"
              className="provider-choice s3-choice"
              disabled={!desktop}
              onClick={() => {
                onClose();
                onAddS3();
              }}
            >
              <Cloud size={23} />
              <div>
                <strong>S3 兼容存储</strong>
                <p>RustFS、MinIO、AWS S3 等</p>
              </div>
              <ChevronRight size={19} />
            </button>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={readOnly}
                onChange={(event) => setReadOnly(event.target.checked)}
              />
              以只读方式添加<span>适合先浏览现有文件</span>
            </label>
            {!desktop && (
              <p className="error-text">请在桌面应用中使用系统目录选择器。</p>
            )}
          </>
        ) : (
          <>
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
            <p className="field-help">
              {dialog.type === "folder"
                ? "将在当前目录中创建，不会覆盖已有项目。"
                : "不会覆盖同名项目。远程文件夹会先复制全部内容，再清理原位置；进度会保存在传输任务中。"}
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
            onClick={() => onClose()}
          >
            取消
          </button>
          <button
            type="submit"
            className="primary"
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
                : dialog.type === "folder"
                  ? "创建文件夹"
                  : "保存名称"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
