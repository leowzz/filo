import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ChevronRight,
  Cloud,
  FolderOpen,
  HardDrive,
  LoaderCircle,
} from "lucide-react";
import { desktop, errorMessage } from "./api";
import { Modal } from "./components";
import { S3Form } from "./S3StorageDialog";
import { s3Providers } from "./s3Providers";
import type { S3Provider, Volume } from "./types";

export function AddStorageDialog({
  mutation,
  submit,
  readOnly,
  setReadOnly,
  onClose,
  onSaved,
}: {
  mutation: { isPending: boolean; isError: boolean; error: unknown };
  submit: (event: FormEvent) => void;
  readOnly: boolean;
  setReadOnly: (value: boolean) => void;
  onClose: () => void;
  onSaved: (volume: Omit<Volume, "capabilities">) => void;
}) {
  const [selected, setSelected] = useState<S3Provider | null>(null);
  const [visited, setVisited] = useState<S3Provider[]>([]);
  const [s3Busy, setS3Busy] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const busy = mutation.isPending || s3Busy;

  useEffect(() => {
    if (selected)
      body.current
        ?.querySelector<HTMLInputElement>(
          ".storage-detail-panel:not([hidden]) input",
        )
        ?.focus({
          preventScroll: window.matchMedia("(min-width: 681px)").matches,
        });
  }, [selected]);

  function select(provider: S3Provider) {
    setVisited((current) =>
      current.includes(provider) ? current : [...current, provider],
    );
    setSelected(provider);
  }
  function back() {
    body.current
      ?.querySelector<HTMLButtonElement>(`[data-provider="${selected}"]`)
      ?.focus({ preventScroll: true });
    setSelected(null);
  }

  return (
    <Modal
      title="添加存储空间"
      className={`storage-add-modal${selected ? " is-expanded" : ""}`}
      busy={busy}
      onClose={onClose}
    >
      <div className="storage-add-body" ref={body}>
        <form className="storage-picker" onSubmit={submit}>
          <fieldset className="connection-fields" disabled={busy}>
            <section
              className="storage-section"
              aria-labelledby="local-storage-heading"
            >
              <h3 id="local-storage-heading">
                <HardDrive size={17} />
                本地文件系统
              </h3>
              <p className="modal-description">
                连接这台电脑上的已有目录，文件留在原来的位置。
              </p>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={readOnly}
                  onChange={(event) => setReadOnly(event.target.checked)}
                />
                以只读方式添加
              </label>
              <button
                type="submit"
                className="secondary local-storage-button"
                disabled={!desktop || busy}
              >
                {mutation.isPending ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <FolderOpen size={16} />
                )}
                {mutation.isPending ? "正在处理…" : "选择本地目录"}
              </button>
            </section>
            <section
              className="storage-section"
              aria-labelledby="s3-storage-heading"
            >
              <h3 id="s3-storage-heading">
                <Cloud size={17} />
                S3 存储
              </h3>
              <div className="s3-provider-list">
                {(Object.keys(s3Providers) as S3Provider[]).map((provider) => (
                  <button
                    key={provider}
                    type="button"
                    className="provider-choice"
                    data-provider={provider}
                    aria-pressed={selected === provider}
                    aria-controls={`storage-panel-${provider}`}
                    disabled={!desktop || busy}
                    onClick={() => select(provider)}
                  >
                    <div>
                      <strong>{s3Providers[provider].name}</strong>
                      <p>{s3Providers[provider].description}</p>
                    </div>
                    <ChevronRight size={17} />
                  </button>
                ))}
              </div>
            </section>
          </fieldset>
          {!desktop && (
            <p className="error-text">请在桌面应用中使用系统目录选择器。</p>
          )}
          {mutation.isError && (
            <p className="error-text" role="alert">
              {errorMessage(mutation.error)}
            </p>
          )}
          {!selected && (
            <div className="modal-footer">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={onClose}
              >
                取消
              </button>
            </div>
          )}
        </form>
        <div className="storage-detail" inert={!selected}>
          {visited.map((provider) => (
            <section
              key={provider}
              id={`storage-panel-${provider}`}
              className="storage-detail-panel"
              hidden={selected !== provider}
              aria-labelledby={`storage-heading-${provider}`}
            >
              <h3 id={`storage-heading-${provider}`}>
                {s3Providers[provider].name}
              </h3>
              <S3Form
                provider={provider}
                embedded
                externalBusy={mutation.isPending}
                onBusyChange={setS3Busy}
                onClose={back}
                onSaved={onSaved}
              />
            </section>
          ))}
        </div>
      </div>
    </Modal>
  );
}
