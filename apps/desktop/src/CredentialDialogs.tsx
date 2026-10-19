import { invoke } from "@tauri-apps/api/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, errorMessage } from "./api";
import { Modal } from "./components";
import {
  credentialApi,
  credentialSettingsKey,
  finishCredentialAccess,
  useCredentialPrompt,
} from "./credentialAccess";

export function CredentialDialogs() {
  const request = useCredentialPrompt((state) => state.request);
  if (!request) return null;
  return request.kind === "unlock" ? (
    <UnlockDialog key={request.key} />
  ) : (
    <ConnectionCredentialsDialog
      key={request.key}
      reference={request.reference}
    />
  );
}

function UnlockDialog() {
  const client = useQueryClient();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError("");
    try {
      const status = await credentialApi.unlock(password);
      setPassword("");
      client.setQueryData(credentialSettingsKey, status);
      finishCredentialAccess(true);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="解锁连接凭据"
      onClose={() => finishCredentialAccess(false)}
      busy={busy}
    >
      <form onSubmit={(event) => void submit(event)}>
        <p className="modal-description">
          输入主密码后，本次运行无需再次解锁。
        </p>
        <label className="field-label" htmlFor="unlock-master-password">
          主密码
        </label>
        <input
          id="unlock-master-password"
          className="text-input"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          disabled={busy}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <div className="modal-footer">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => finishCredentialAccess(false)}
          >
            取消
          </button>
          <button className="primary" disabled={!password || busy}>
            {busy ? "正在解锁…" : "解锁"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConnectionCredentialsDialog({ reference }: { reference: string }) {
  const query = useQuery({
    queryKey: ["connections"],
    queryFn: api.connections,
  });
  const connection = query.data?.find(
    (item) => item.credential_ref === reference,
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [domain, setDomain] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [method, setMethod] = useState("password");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const s3 = connection?.provider === "s3";
  const protocol = connection?.config.protocol;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!connection || busy) return;
    setBusy(true);
    setError("");
    try {
      await invoke("provide_connection_credentials", {
        reference,
        s3: s3
          ? {
              access_key_id: username,
              secret_access_key: password,
              session_token: token || null,
            }
          : null,
        remote: s3
          ? null
          : {
              username,
              password: method === "password" ? password : "",
              domain,
              private_key: method === "private_key" ? privateKey : "",
              passphrase: method === "private_key" ? passphrase : "",
            },
      });
      finishCredentialAccess(true);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={connection ? `连接 ${connection.name}` : "输入连接凭据"}
      onClose={() => finishCredentialAccess(false)}
      busy={busy}
    >
      {connection ? (
        <form onSubmit={(event) => void submit(event)}>
          <p className="modal-description">
            请重新输入此连接的凭据。旧系统凭据可在设置中导入。
          </p>
          <fieldset
            disabled={busy}
            className="connection-fields credential-fields"
          >
            <label>
              <span className="field-label">
                {s3 ? "Access Key" : "用户名"}
              </span>
              <input
                className="text-input"
                value={username}
                autoComplete="username"
                autoFocus
                required
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
            {protocol === "sftp" && (
              <label>
                <span className="field-label">认证方式</span>
                <select
                  className="text-input"
                  value={method}
                  onChange={(event) => setMethod(event.target.value)}
                >
                  <option value="password">密码</option>
                  <option value="private_key">SSH 私钥</option>
                </select>
              </label>
            )}
            {method === "password" ? (
              <label>
                <span className="field-label">
                  {s3 ? "Secret Key" : "密码"}
                </span>
                <input
                  className="text-input"
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  required={s3}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            ) : (
              <>
                <label>
                  <span className="field-label">SSH 私钥</span>
                  <textarea
                    className="text-input credential-private-key"
                    value={privateKey}
                    required
                    onChange={(event) => setPrivateKey(event.target.value)}
                  />
                </label>
                <label>
                  <span className="field-label">私钥口令（可选）</span>
                  <input
                    className="text-input"
                    type="password"
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                  />
                </label>
              </>
            )}
            {s3 && (
              <label>
                <span className="field-label">Session Token（可选）</span>
                <input
                  className="text-input"
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
              </label>
            )}
            {protocol === "smb" && (
              <label>
                <span className="field-label">域（可选）</span>
                <input
                  className="text-input"
                  value={domain}
                  onChange={(event) => setDomain(event.target.value)}
                />
              </label>
            )}
          </fieldset>
          {error && (
            <p role="alert" className="error-text">
              {error}
            </p>
          )}
          <div className="modal-footer">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => finishCredentialAccess(false)}
            >
              取消
            </button>
            <button className="primary" disabled={busy}>
              {busy ? "正在连接…" : "连接"}
            </button>
          </div>
        </form>
      ) : (
        <>
          <p
            className="modal-description"
            role={query.isError ? "alert" : "status"}
          >
            {query.isError
              ? errorMessage(query.error)
              : query.isPending
                ? "正在读取连接…"
                : "未找到此连接，请刷新后重试。"}
          </p>
          {query.isError && (
            <button className="secondary" onClick={() => void query.refetch()}>
              重试
            </button>
          )}
        </>
      )}
    </Modal>
  );
}
