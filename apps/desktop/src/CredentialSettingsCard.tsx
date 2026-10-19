import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LockKeyhole } from "lucide-react";
import { useState, type FormEvent } from "react";
import { desktop, errorMessage } from "./api";
import { Modal } from "./components";
import {
  credentialApi,
  credentialSettingsKey,
  requestCredentialAccess,
  type CredentialMode,
  type CredentialStatus,
} from "./credentialAccess";

const modes: { value: CredentialMode; title: string; description: string }[] = [
  {
    value: "plain",
    title: "保存凭据",
    description: "无需解锁；能读取本地凭据文件的人可以还原密码。",
  },
  {
    value: "master",
    title: "使用主密码保护",
    description: "加密保存，首次使用时解锁；忘记主密码后需重新输入连接凭据。",
  },
  {
    value: "memory",
    title: "不保存凭据",
    description: "仅本次运行使用；已保存的凭据将从本地文件移除。",
  },
];

export function CredentialSettingsCard() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: credentialSettingsKey,
    queryFn: desktop
      ? credentialApi.status
      : () =>
          Promise.resolve<CredentialStatus>({
            mode: "plain",
            locked: false,
            legacy_import_available: false,
          }),
  });
  const [resetting, setResetting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function reset() {
    if (!confirmed || busy) return;
    setBusy(true);
    setError("");
    try {
      const status = await credentialApi.reset();
      client.setQueryData(credentialSettingsKey, status);
      setResetting(false);
      setNotice("已清除保存的凭据，连接配置仍然保留。");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  async function importLegacy() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const count = await credentialApi.importLegacy();
      await client.invalidateQueries({ queryKey: credentialSettingsKey });
      setNotice(`已导入 ${count} 个连接的凭据，旧系统条目保留。`);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card credential-settings-card">
      <h2>
        <LockKeyhole size={19} />
        连接凭据
      </h2>
      {query.isPending && <p role="status">正在读取设置…</p>}
      {query.isError && (
        <p className="error-text" role="alert">
          {errorMessage(query.error)}{" "}
          <button className="secondary" onClick={() => void query.refetch()}>
            重试
          </button>
        </p>
      )}
      {query.data && (
        <CredentialSettingsForm
          key={query.data.mode}
          status={query.data}
          onSaved={(status) => {
            client.setQueryData(credentialSettingsKey, status);
            setNotice("凭据保存方式已更新。");
          }}
        />
      )}
      <div className="credential-settings-tools">
        {query.data?.legacy_import_available && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void importLegacy()}
          >
            导入旧系统凭据
          </button>
        )}
        {(query.data?.mode === "master" || query.isError) && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              setConfirmed(false);
              setError("");
              setResetting(true);
            }}
          >
            重置已保存的凭据
          </button>
        )}
      </div>
      {query.data?.legacy_import_available && (
        <p>导入可能需要系统授权；导入后按当前方式保存。</p>
      )}
      {!resetting && error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="credential-settings-saved">
          {notice}
        </p>
      )}
      {resetting && (
        <Modal
          title="重置已保存的凭据"
          busy={busy}
          onClose={() => setResetting(false)}
        >
          <p className="modal-description">
            清除本地保存的密码和密钥，并恢复普通保存方式。连接配置和远程文件不受影响。此操作无法撤销。
          </p>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            确认清除已保存的凭据
          </label>
          {error && (
            <p role="alert" className="error-text">
              {error}
            </p>
          )}
          <div className="modal-footer">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setResetting(false)}
            >
              取消
            </button>
            <button
              className="danger"
              disabled={!confirmed || busy}
              onClick={() => void reset()}
            >
              清除凭据
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function CredentialSettingsForm({
  status,
  onSaved,
}: {
  status: CredentialStatus;
  onSaved: (status: CredentialStatus) => void;
}) {
  const [mode, setMode] = useState(status.mode);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [current, setCurrent] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const changing =
    mode !== status.mode || (mode === "master" && password.length > 0);
  const valid =
    changing &&
    (mode !== "master" || ([...password].length >= 8 && password === repeat)) &&
    (status.mode !== "master" || current.length > 0);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    try {
      const saved = await credentialApi.configure(mode, password, current);
      setPassword("");
      setRepeat("");
      setCurrent("");
      onSaved(saved);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)}>
      <fieldset className="conflict-choices" disabled={busy}>
        <legend className="field-label">凭据保存方式</legend>
        <div className="conflict-choices-list">
          {modes.map((option) => (
            <label className="conflict-choice" key={option.value}>
              <input
                type="radio"
                name="credential-mode"
                value={option.value}
                checked={mode === option.value}
                onChange={() => {
                  setMode(option.value);
                  setError("");
                }}
              />
              <span className="conflict-choice-copy">
                <span className="conflict-choice-title">{option.title}</span>
                <span className="conflict-choice-description">
                  {option.description}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {status.mode === "master" && (
        <p>
          {status.locked ? "尚未解锁" : "已解锁，仅本次运行有效"}
          {status.locked && (
            <>
              {" "}
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  void requestCredentialAccess().catch((failure) =>
                    setError(errorMessage(failure)),
                  )
                }
              >
                解锁
              </button>
            </>
          )}
        </p>
      )}
      <fieldset className="connection-fields credential-fields" disabled={busy}>
        {status.mode === "master" && (
          <label>
            <span className="field-label">当前主密码（更改设置时需要）</span>
            <input
              className="text-input"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
            />
          </label>
        )}
        {mode === "master" && (
          <>
            <label>
              <span className="field-label">
                {status.mode === "master" ? "新主密码" : "主密码"}（至少 8
                个字符）
              </span>
              <input
                className="text-input"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <label>
              <span className="field-label">确认主密码</span>
              <input
                className="text-input"
                type="password"
                autoComplete="new-password"
                value={repeat}
                onChange={(event) => setRepeat(event.target.value)}
              />
            </label>
            {repeat && password !== repeat && (
              <p role="alert" className="error-text">
                两次输入的主密码不一致。
              </p>
            )}
          </>
        )}
      </fieldset>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="credential-settings-actions">
        <button className="primary" disabled={!valid || busy || !desktop}>
          {busy ? "正在保存…" : "保存凭据设置"}
        </button>
      </div>
    </form>
  );
}
