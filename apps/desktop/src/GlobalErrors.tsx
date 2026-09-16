import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, X } from "lucide-react";
import { reportAppError, useAppErrors } from "./errors";

const sources = {
  backend: "后台操作异常",
  script: "界面脚本异常",
  promise: "未处理的异步异常",
  render: "界面渲染异常",
  notifications: "异常通知连接失败",
};

export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    reportAppError("render", "", undefined, error);
  }
  render() {
    if (this.state.failed)
      return (
        <main className="app-crash" role="alert">
          <AlertTriangle size={28} />
          <h1>界面发生异常</h1>
          <p>请重新加载界面。尚未保存的输入需要重新填写。</p>
          <button className="primary" onClick={() => window.location.reload()}>
            重新加载界面
          </button>
        </main>
      );
    return this.props.children;
  }
}

export function GlobalErrors() {
  const errors = useAppErrors((state) => state.errors);
  const dismiss = useAppErrors((state) => state.dismiss);
  const dialog = useRef<HTMLDialogElement>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const active = errors.length > 0;
  useEffect(() => {
    if (active) dialog.current?.showModal();
    else dialog.current?.close();
    setCopyStatus("");
  }, [active]);
  const details = errors
    .map(
      (error) =>
        `${sources[error.source]}${error.location ? ` · ${error.location}` : ""}\n诊断编号：${error.id}\n发生次数：${error.count}${error.details ? `\n${error.details}` : ""}`,
    )
    .join("\n\n");
  if (!active) return null;
  return (
    <dialog
      ref={dialog}
      className="modal global-error-dialog"
      aria-labelledby="global-error-title"
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
    >
      <div className="modal-head">
        <h2 id="global-error-title">
          <AlertTriangle size={18} />
          发生异常
        </h2>
        <button
          className="icon-button"
          aria-label="关闭异常提示"
          onClick={dismiss}
        >
          <X size={18} />
        </button>
      </div>
      <p role="alert">
        部分操作发生异常，无法确认是否完成。请关闭提示，检查操作结果后重试。
      </p>
      <details>
        <summary>查看诊断信息</summary>
        <pre>{details}</pre>
      </details>
      {copyStatus && (
        <p className="field-help" role="status">
          {copyStatus}
        </p>
      )}
      <div className="modal-footer">
        <button
          onClick={() => {
            void navigator.clipboard
              .writeText(details)
              .then(() => setCopyStatus("诊断信息已复制"))
              .catch(() => setCopyStatus("复制失败，请展开诊断信息手动复制"));
          }}
        >
          复制诊断信息
        </button>
        <button className="primary" onClick={dismiss}>
          知道了
        </button>
      </div>
    </dialog>
  );
}
