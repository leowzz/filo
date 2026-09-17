import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ChevronLeft,
  Cloud,
  FolderOpen,
  HardDrive,
  LoaderCircle,
  Network,
} from "lucide-react";
import { desktop, errorMessage } from "./api";
import { Modal } from "./components";
import { RemoteForm } from "./RemoteStorageDialog";
import { S3Form } from "./S3StorageDialog";
import { s3Providers } from "./s3Providers";
import {
  isRemoteProtocol,
  remoteProtocols,
  RemoteProviderIcon,
  S3ProviderIcon,
} from "./StorageProvider";
import type { RemoteProtocol, S3Provider, Volume } from "./types";

type RemoteChoice = Exclude<RemoteProtocol, "ftps">;
type StorageChoice = S3Provider | RemoteChoice;

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
  const [selected, setSelected] = useState<StorageChoice | null>(null);
  const [visited, setVisited] = useState<StorageChoice[]>([]);
  const [providerBusy, setProviderBusy] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const busy = mutation.isPending || providerBusy;

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

  function select(provider: StorageChoice) {
    setVisited((current) =>
      current.includes(provider) ? current : [...current, provider],
    );
    setSelected(provider);
  }
  function back() {
    const previous = selected;
    setSelected(null);
    requestAnimationFrame(() => {
      body.current
        ?.querySelector<HTMLButtonElement>(`[data-provider="${previous}"]`)
        ?.focus({ preventScroll: false });
    });
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
              <div className="storage-provider-grid">
                <button
                  type="submit"
                  className="provider-choice"
                  disabled={!desktop || busy}
                >
                  <span className="storage-provider-icon" aria-hidden="true">
                    {mutation.isPending ? (
                      <LoaderCircle size={28} className="spin" />
                    ) : (
                      <FolderOpen size={28} />
                    )}
                  </span>
                  <strong>
                    {mutation.isPending ? "正在处理…" : "选择本地目录"}
                  </strong>
                </button>
              </div>
              <label className="checkbox-label local-storage-readonly">
                <input
                  type="checkbox"
                  checked={readOnly}
                  onChange={(event) => setReadOnly(event.target.checked)}
                />
                以只读方式添加
              </label>
            </section>
            <section
              className="storage-section"
              aria-labelledby="s3-storage-heading"
            >
              <h3 id="s3-storage-heading">
                <Cloud size={17} />
                S3 存储
              </h3>
              <div className="s3-provider-list storage-provider-grid">
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
                    <S3ProviderIcon provider={provider} />
                    <strong>{s3Providers[provider].name}</strong>
                  </button>
                ))}
              </div>
            </section>
            <section
              className="storage-section"
              aria-labelledby="remote-storage-heading"
            >
              <h3 id="remote-storage-heading">
                <Network size={17} />
                远程文件协议
              </h3>
              <div className="remote-provider-list storage-provider-grid">
                {(Object.keys(remoteProtocols) as RemoteChoice[]).map(
                  (protocol) => (
                    <button
                      key={protocol}
                      type="button"
                      className="provider-choice"
                      data-provider={protocol}
                      aria-pressed={selected === protocol}
                      aria-controls={`storage-panel-${protocol}`}
                      disabled={!desktop || busy}
                      onClick={() => select(protocol)}
                    >
                      <RemoteProviderIcon protocol={protocol} />
                      <strong>{remoteProtocols[protocol].name}</strong>
                    </button>
                  ),
                )}
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
          {selected && (
            <button
              type="button"
              className="storage-back-button"
              disabled={busy}
              onClick={back}
            >
              <ChevronLeft size={16} />
              返回选择
            </button>
          )}
          {visited.map((provider) => {
            const remote = isRemoteProtocol(provider);
            return (
              <section
                key={provider}
                id={`storage-panel-${provider}`}
                className="storage-detail-panel"
                hidden={selected !== provider}
                aria-labelledby={`storage-heading-${provider}`}
              >
                <h3 id={`storage-heading-${provider}`}>
                  {remote
                    ? remoteProtocols[provider].name
                    : s3Providers[provider].name}
                </h3>
                {remote ? (
                  <RemoteForm
                    protocol={provider}
                    embedded
                    externalBusy={mutation.isPending}
                    onBusyChange={setProviderBusy}
                    onClose={back}
                    onSaved={onSaved}
                  />
                ) : (
                  <S3Form
                    provider={provider}
                    embedded
                    externalBusy={mutation.isPending}
                    onBusyChange={setProviderBusy}
                    onClose={back}
                    onSaved={onSaved}
                  />
                )}
              </section>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
