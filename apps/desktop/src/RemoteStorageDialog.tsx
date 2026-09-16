import {
  CheckCircle2,
  ChevronDown,
  KeyRound,
  LoaderCircle,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "./api";
import { Modal } from "./components";
import { useBrowser } from "./store";
import { isRemoteProtocol, remoteProtocols } from "./StorageProvider";
import type {
  Connection,
  RemoteAuthMethod,
  RemoteInput,
  RemoteProtocol,
  Volume,
} from "./types";
import "./styles/remote-dialog.css";

type RemoteVolume = Volume & {
  root: { type: "remote"; path: string };
};

function asRemoteVolume(volume: Volume | undefined): RemoteVolume | undefined {
  if (!volume || volume.root.type !== "remote") return undefined;
  return volume as RemoteVolume;
}

export function RemoteStorageDialog({
  protocol = "ftp",
  volume,
  onClose,
  onSaved,
}: {
  protocol?: RemoteProtocol;
  volume?: Volume;
  onClose: () => void;
  onSaved: (volume: Omit<Volume, "capabilities">) => void;
}) {
  const connections = useQuery({
    queryKey: ["connections"],
    queryFn: api.connections,
    enabled: Boolean(volume),
  });
  const connection = connections.data?.find(
    (item) => item.id === volume?.connection_id,
  );
  const configuredProtocol = connection?.config.protocol;
  const selectedProtocol =
    configuredProtocol && isRemoteProtocol(configuredProtocol)
      ? configuredProtocol
      : protocol;

  if (volume && connections.isPending)
    return (
      <Modal title="编辑远程连接" onClose={onClose}>
        <p>正在读取连接…</p>
      </Modal>
    );
  if (volume && connections.isError)
    return (
      <Modal title="编辑远程连接" onClose={onClose}>
        <p className="error-text" role="alert">
          {errorMessage(connections.error)}
        </p>
        <button
          className="secondary"
          onClick={() => void connections.refetch()}
        >
          重试
        </button>
      </Modal>
    );
  if (volume && !connection)
    return (
      <Modal title="编辑远程连接" onClose={onClose}>
        <p className="error-text" role="alert">
          找不到该远程连接配置，请刷新存储空间列表后重试。
        </p>
      </Modal>
    );

  return (
    <RemoteForm
      protocol={selectedProtocol}
      volume={asRemoteVolume(volume)}
      connection={connection}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

export function RemoteForm({
  protocol,
  volume,
  connection,
  embedded = false,
  externalBusy = false,
  onBusyChange,
  onClose,
  onSaved,
}: {
  protocol: RemoteProtocol;
  volume?: RemoteVolume;
  connection?: Connection;
  embedded?: boolean;
  externalBusy?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onClose: () => void;
  onSaved: (volume: Omit<Volume, "capabilities">) => void;
}) {
  const client = useQueryClient();
  const preset = remoteProtocols[protocol];
  const [name, setName] = useState(volume?.name ?? "");
  const [host, setHost] = useState(connection?.config.host ?? "");
  const [port, setPort] = useState(
    String(connection?.config.port ?? preset.defaultPort),
  );
  const [path, setPath] = useState(volume?.root.path ?? "");
  const [share, setShare] = useState(connection?.config.share ?? "");
  const [knownHosts, setKnownHosts] = useState(
    connection?.config.known_hosts ?? "",
  );
  const [readOnly, setReadOnly] = useState(volume?.read_only ?? false);
  const [replaceCredentials, setReplaceCredentials] = useState(!volume);
  const [authMethod, setAuthMethod] = useState<RemoteAuthMethod>("password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [domain, setDomain] = useState("");
  const [tested, setTested] = useState(false);

  const portNumber = Number(port);
  const hostValue = host.trim();
  const hostColonCount = (hostValue.match(/:/g) ?? []).length;
  const hostValid =
    hostValue.length > 0 &&
    !/[\s/?#]/.test(hostValue) &&
    !hostValue.includes("\\") &&
    // A single colon is almost always an accidental host:port entry. IPv6
    // literals contain at least two separators and keep using the separate
    // port control in this form.
    hostColonCount !== 1;
  const portValid =
    /^\d+$/.test(port) &&
    Number.isInteger(portNumber) &&
    portNumber >= 1 &&
    portNumber <= 65535;
  const shareValue = share.trim();
  const shareValid =
    protocol !== "smb" || (shareValue.length > 0 && !/[\\/:]/.test(shareValue));
  const knownHostsValue = knownHosts.trim();
  const knownHostsValid = protocol !== "sftp" || knownHostsValue.length > 0;
  const usernameValue = username.trim();
  const credentialsValid =
    !replaceCredentials ||
    (usernameValue.length > 0 &&
      (protocol === "sftp" && authMethod === "private_key"
        ? privateKey.trim().length > 0
        : password.length > 0));
  const valid = Boolean(
    name.trim().length > 0 &&
    Array.from(name.trim()).length <= 100 &&
    !Array.from(name).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    hostValid &&
    portValid &&
    shareValid &&
    knownHostsValid &&
    credentialsValid,
  );
  const input: RemoteInput = {
    name: name.trim(),
    protocol,
    host: hostValue,
    port: portNumber,
    path: path.trim(),
    share: shareValue,
    known_hosts: knownHostsValue,
    read_only: readOnly,
    credentials: replaceCredentials
      ? {
          username: usernameValue,
          password:
            protocol === "sftp" && authMethod === "private_key" ? "" : password,
          private_key:
            protocol === "sftp" && authMethod === "private_key"
              ? privateKey
              : "",
          passphrase:
            protocol === "sftp" && authMethod === "private_key"
              ? passphrase
              : "",
          domain: domain.trim(),
        }
      : null,
  };
  const test = useMutation({
    mutationFn: () => api.testRemote(volume?.id ?? null, input),
    onMutate: () => setTested(false),
    onSuccess: () => setTested(true),
  });
  const save = useMutation({
    mutationFn: () => api.saveRemote(volume?.id ?? null, input),
    onSuccess: async (saved) => {
      if (volume) {
        await client.cancelQueries({ queryKey: ["entries", volume.id] });
        useBrowser.getState().resetVolumeRoot(volume.id);
        client.removeQueries({ queryKey: ["entries", volume.id] });
      }
      await Promise.all([
        client.invalidateQueries({ queryKey: ["volumes"] }),
        client.invalidateQueries({ queryKey: ["connections"] }),
      ]);
      onSaved(saved);
    },
  });
  const pending = save.isPending || test.isPending;
  const busy = pending || externalBusy;
  useEffect(() => {
    onBusyChange?.(pending);
  }, [onBusyChange, pending]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (valid && !busy) save.mutate();
  }

  const pathHelp =
    protocol === "smb"
      ? "共享名称下的目录，留空从共享根目录开始。"
      : protocol === "sftp"
        ? "服务器上的目录路径，例如 /home/user/files。"
        : "FTP 服务器上的目录路径，留空从服务器根目录开始。";
  const pathPlaceholder = protocol === "smb" ? "例如 documents/projects" : "/";

  const form = (
    <form
      className="remote-form"
      onChange={() => {
        setTested(false);
        test.reset();
        save.reset();
      }}
      onSubmit={submit}
    >
      <fieldset className="connection-fields remote-fields" disabled={busy}>
        <label className="field-label">
          连接名称
          <input
            autoFocus={!embedded}
            className="text-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={`例如：${protocol === "smb" ? "家庭 NAS" : `${preset.name} 服务器`}`}
            required
            maxLength={100}
          />
        </label>

        <div className="remote-host-row">
          <label className="field-label remote-host-field">
            服务器地址
            <input
              className="text-input"
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="例如 192.168.1.20 或 files.example.com"
              autoComplete="url"
              required
              aria-invalid={host.length > 0 && !hostValid}
            />
            <span className="field-help remote-input-help">
              只填写主机名或 IP，不要包含协议前缀、路径或端口。
            </span>
          </label>
          <label className="field-label remote-port-field">
            端口
            <input
              className="text-input"
              type="number"
              min={1}
              max={65535}
              step={1}
              inputMode="numeric"
              value={port}
              onChange={(event) => setPort(event.target.value)}
              required
              aria-invalid={port.length > 0 && !portValid}
            />
            <span className="field-help remote-input-help">
              默认 {preset.defaultPort}
            </span>
          </label>
        </div>
        {!hostValid && host.length > 0 && (
          <p className="error-text">
            请只填写服务器地址；端口填写在右侧，IPv6 地址可直接填写（例如
            ::1）。
          </p>
        )}
        {!portValid && port.length > 0 && (
          <p className="error-text">端口须为 1 到 65535 的整数。</p>
        )}

        {protocol === "smb" && (
          <label className="field-label">
            SMB 共享名称
            <input
              className="text-input"
              value={share}
              onChange={(event) => setShare(event.target.value)}
              placeholder="例如 public"
              required
              aria-invalid={share.length > 0 && !shareValid}
            />
            <span className="field-help remote-input-help">
              填写服务器发布的共享名称，不要填写 smb:// 地址。
            </span>
          </label>
        )}

        <label className="field-label">
          {protocol === "smb" ? "共享内目录" : "远程目录"}
          <input
            className="text-input"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder={pathPlaceholder}
          />
          <span className="field-help remote-input-help">{pathHelp}</span>
        </label>

        {protocol === "sftp" && (
          <label className="field-label remote-textarea-label">
            SSH 主机密钥（known_hosts）
            <textarea
              className="text-input remote-textarea remote-known-hosts"
              value={knownHosts}
              onChange={(event) => setKnownHosts(event.target.value)}
              placeholder="粘贴 ssh-keyscan 输出的一行或多行"
              rows={4}
              spellCheck={false}
              required
              aria-invalid={knownHosts.length > 0 && !knownHostsValid}
            />
            <span className="field-help remote-input-help">
              为防止连接到冒充服务器，必须提供该服务器的主机密钥；不会自动信任未知主机。
            </span>
          </label>
        )}

        {volume && (
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={replaceCredentials}
              onChange={(event) => setReplaceCredentials(event.target.checked)}
            />
            更换登录凭据
          </label>
        )}

        {replaceCredentials && (
          <div className="remote-credentials">
            <div className="remote-credentials-heading">
              <span className="field-label">登录凭据</span>
              <KeyRound size={15} aria-hidden="true" />
            </div>
            <label className="field-label">
              用户名
              <input
                className="text-input"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                required
              />
            </label>
            {protocol === "smb" && (
              <label className="field-label">
                域（可选）
                <input
                  className="text-input"
                  value={domain}
                  onChange={(event) => setDomain(event.target.value)}
                  placeholder="例如 WORKGROUP"
                  autoComplete="organization"
                />
                <span className="field-help remote-input-help">
                  仅在服务器要求 Windows 域登录时填写。
                </span>
              </label>
            )}
            {protocol === "sftp" && (
              <label className="field-label">
                认证方式
                <span className="remote-select-control">
                  <select
                    className="text-input"
                    value={authMethod}
                    onChange={(event) => {
                      const next = event.target.value as RemoteAuthMethod;
                      setAuthMethod(next);
                      if (next === "private_key") setPassword("");
                      else {
                        setPrivateKey("");
                        setPassphrase("");
                      }
                    }}
                  >
                    <option value="password">密码</option>
                    <option value="private_key">SSH 私钥</option>
                  </select>
                  <ChevronDown size={14} aria-hidden="true" />
                </span>
              </label>
            )}
            {protocol === "sftp" && authMethod === "private_key" ? (
              <>
                <label className="field-label remote-textarea-label">
                  SSH 私钥
                  <textarea
                    className="text-input remote-textarea remote-private-key"
                    value={privateKey}
                    onChange={(event) => setPrivateKey(event.target.value)}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    rows={5}
                    spellCheck={false}
                    required
                  />
                </label>
                <label className="field-label">
                  私钥口令（可选）
                  <input
                    type="password"
                    className="text-input"
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                    autoComplete="new-password"
                  />
                </label>
              </>
            ) : (
              <label className="field-label">
                密码
                <input
                  type="password"
                  className="text-input"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  required
                />
              </label>
            )}
          </div>
        )}

        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={readOnly}
            onChange={(event) => setReadOnly(event.target.checked)}
          />
          只读访问
        </label>
        {(protocol === "ftp" || protocol === "ftps") && (
          <p className="remote-capability-note" role="note">
            当前 FTP / FTPS 连接支持浏览与下载；上传和重命名暂不可用。
          </p>
        )}
        <p className="field-help remote-credential-help">
          登录凭据保存在系统凭据存储。编辑连接时可保留已有凭据，只有勾选“更换登录凭据”才需要重新输入。
        </p>
      </fieldset>

      {(save.isError || test.isError) && (
        <p className="error-text" role="alert">
          {errorMessage(save.error ?? test.error)}
        </p>
      )}
      {tested && (
        <div className="remote-test-success" role="status">
          <CheckCircle2 size={16} aria-hidden="true" />
          <span>连接成功，可以访问所选远程目录。</span>
        </div>
      )}
      <div className="modal-footer">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={onClose}
        >
          {embedded ? "返回选择" : "取消"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!valid || busy}
          onClick={() => test.mutate()}
        >
          {test.isPending && <LoaderCircle size={14} className="spin" />}
          {test.isPending ? "正在测试…" : "测试连接"}
        </button>
        <button className="primary" disabled={!valid || busy}>
          {save.isPending && <LoaderCircle size={14} className="spin" />}
          {save.isPending ? "正在保存…" : "保存连接"}
        </button>
      </div>
    </form>
  );

  return embedded ? (
    form
  ) : (
    <Modal
      title={`${volume ? "编辑" : "添加"} ${preset.name} 连接`}
      onClose={onClose}
      busy={busy}
      className="remote-storage-modal"
    >
      {form}
    </Modal>
  );
}
