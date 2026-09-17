import {
  CheckCircle2,
  ChevronDown,
  KeyRound,
  LoaderCircle,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
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
  SftpHostKeyInspection,
  SftpPrivateKey,
  Volume,
} from "./types";
import "./styles/remote-dialog.css";

type RemoteVolume = Volume & {
  root: { type: "remote"; path: string };
};
type SftpPrivateKeySource = "default" | "file" | "paste";
type SftpPrivateKeyOperation = "default" | "picker" | null;
type RemoteAction = "test" | "save";

function asRemoteVolume(volume: Volume | undefined): RemoteVolume | undefined {
  if (!volume || volume.root.type !== "remote") return undefined;
  return volume as RemoteVolume;
}

function endpointKey(host: string, port: number) {
  return `${host}\u0000${port}`;
}

function endpointLabel(host: string, port: number) {
  const displayHost =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${displayHost}:${port}`;
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
  const initialHost = (connection?.config.host ?? "").trim();
  const initialPort = connection?.config.port ?? preset.defaultPort;
  const initialEndpointKey = endpointKey(initialHost, initialPort);
  const [hostKeyPin, setHostKeyPin] = useState(
    protocol === "sftp" ? (connection?.config.known_hosts ?? "") : "",
  );
  const [trustedEndpointKey, setTrustedEndpointKey] = useState<string | null>(
    protocol === "sftp" && connection?.config.known_hosts?.trim()
      ? initialEndpointKey
      : null,
  );
  const [hostKeyInspection, setHostKeyInspection] =
    useState<SftpHostKeyInspection | null>(null);
  const [hostKeyInspectionEndpoint, setHostKeyInspectionEndpoint] = useState<
    string | null
  >(null);
  const [hostKeyError, setHostKeyError] = useState("");
  const [hostKeyInspectionPending, setHostKeyInspectionPending] =
    useState(false);
  const [pendingSftpAction, setPendingSftpAction] =
    useState<RemoteAction | null>(null);
  const [readOnly, setReadOnly] = useState(volume?.read_only ?? false);
  const [replaceCredentials, setReplaceCredentials] = useState(!volume);
  const [authMethod, setAuthMethod] = useState<RemoteAuthMethod>("password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [privateKeySource, setPrivateKeySource] =
    useState<SftpPrivateKeySource>("default");
  const [privateKeyPath, setPrivateKeyPath] = useState("");
  const [privateKeyOperation, setPrivateKeyOperation] =
    useState<SftpPrivateKeyOperation>(null);
  const [privateKeyError, setPrivateKeyError] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [domain, setDomain] = useState("");
  const [tested, setTested] = useState(false);
  const privateKeyRequest = useRef(0);
  const hostKeyRequest = useRef(0);
  const endpointKeyRef = useRef(initialEndpointKey);
  const hostKeyCheckRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);

  const activePrivateKey =
    protocol === "sftp" && replaceCredentials && authMethod === "private_key";
  const privateKeyLoading = privateKeyOperation !== null;

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
  const currentEndpointKey = endpointKey(hostValue, portNumber);
  endpointKeyRef.current = currentEndpointKey;
  const knownHostsValue =
    protocol === "sftp" && trustedEndpointKey === currentEndpointKey
      ? hostKeyPin
      : "";
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
    mutationFn: (request: RemoteInput) =>
      api.testRemote(volume?.id ?? null, request),
    onMutate: () => setTested(false),
    onSuccess: () => setTested(true),
  });
  const save = useMutation({
    mutationFn: (request: RemoteInput) =>
      api.saveRemote(volume?.id ?? null, request),
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
  const hostKeyConfirmation =
    pendingSftpAction !== null && hostKeyInspection?.status === "unknown";
  const busy = pending || externalBusy || hostKeyInspectionPending;
  const actionsBusy = busy || privateKeyLoading || hostKeyConfirmation;
  const workflowBusy =
    pending || hostKeyInspectionPending || hostKeyConfirmation;

  function clearHostKeyWorkflow() {
    hostKeyRequest.current += 1;
    setHostKeyInspectionPending(false);
    setHostKeyInspection(null);
    setHostKeyInspectionEndpoint(null);
    setHostKeyError("");
    setPendingSftpAction(null);
  }

  function invalidateHostKeyTrust() {
    clearHostKeyWorkflow();
    setHostKeyPin("");
    setTrustedEndpointKey(null);
  }

  function runRemoteAction(action: RemoteAction, request: RemoteInput) {
    if (!mounted.current) return;
    if (action === "test") test.mutate(request);
    else save.mutate(request);
  }

  function cancelHostKeyAction() {
    clearHostKeyWorkflow();
  }

  function trustAndContinue() {
    if (
      protocol !== "sftp" ||
      pendingSftpAction === null ||
      hostKeyInspection?.status !== "unknown" ||
      hostKeyInspectionEndpoint !== currentEndpointKey ||
      !hostKeyInspection.known_hosts ||
      !valid ||
      busy ||
      privateKeyLoading
    )
      return;

    const action = pendingSftpAction;
    const exactPin = hostKeyInspection.known_hosts;
    const actionInput = { ...input, known_hosts: exactPin };
    const actionEndpointKey = currentEndpointKey;
    if (endpointKeyRef.current !== actionEndpointKey) {
      invalidateHostKeyTrust();
      return;
    }

    setHostKeyPin(exactPin);
    setTrustedEndpointKey(actionEndpointKey);
    clearHostKeyWorkflow();
    runRemoteAction(action, actionInput);
  }

  async function inspectBeforeAction(action: RemoteAction) {
    if (!valid || actionsBusy) return;
    resetConnectionStatus();
    if (protocol !== "sftp") {
      runRemoteAction(action, input);
      return;
    }

    const actionEndpointKey = currentEndpointKey;
    const requestId = ++hostKeyRequest.current;
    const requestInput = input;
    setHostKeyInspection(null);
    setHostKeyInspectionEndpoint(actionEndpointKey);
    setHostKeyError("");
    setPendingSftpAction(action);
    setHostKeyInspectionPending(true);

    try {
      const result = await api.inspectSftpHostKey(
        requestInput.host,
        requestInput.port,
        requestInput.known_hosts,
      );
      if (!mounted.current || requestId !== hostKeyRequest.current) return;
      if (endpointKeyRef.current !== actionEndpointKey) {
        invalidateHostKeyTrust();
        return;
      }

      if (result.status === "trusted") {
        const exactPin = result.known_hosts;
        setHostKeyPin(exactPin);
        setTrustedEndpointKey(actionEndpointKey);
        setHostKeyInspection(null);
        setPendingSftpAction(null);
        setHostKeyInspectionPending(false);
        runRemoteAction(action, { ...requestInput, known_hosts: exactPin });
        return;
      }

      setHostKeyInspection(result);
      setHostKeyInspectionEndpoint(actionEndpointKey);
      setHostKeyInspectionPending(false);
      if (result.status === "unknown") {
        // The returned pin is held in the inspection result until the user
        // confirms it. It must never reach a connection mutation implicitly.
        setHostKeyPin("");
        setTrustedEndpointKey(null);
      } else {
        // Keep the prior pin so every retry still compares against it. A
        // changed host key has no trust or re-trust path in this dialog.
        setPendingSftpAction(null);
      }
    } catch (error) {
      if (!mounted.current || requestId !== hostKeyRequest.current) return;
      if (endpointKeyRef.current !== actionEndpointKey) {
        invalidateHostKeyTrust();
        return;
      }
      setHostKeyInspectionPending(false);
      setHostKeyInspection(null);
      setHostKeyError(`无法检查 SFTP 主机密钥：${errorMessage(error)}`);
      // Keep the intended action so the inline retry can repeat inspection.
    } finally {
      if (mounted.current && requestId === hostKeyRequest.current) {
        setHostKeyInspectionPending(false);
      }
    }
  }

  function resetConnectionStatus() {
    setTested(false);
    test.reset();
    save.reset();
  }

  function cancelPrivateKeyRequest() {
    privateKeyRequest.current += 1;
    setPrivateKeyOperation(null);
  }

  function applyPrivateKeyResult(
    result: SftpPrivateKey,
    source: Exclude<SftpPrivateKeySource, "paste">,
  ) {
    setPrivateKeySource(source);
    setPrivateKeyPath(result.path);
    setPrivateKey(result.private_key);
    setPrivateKeyError("");
    resetConnectionStatus();
  }

  async function loadDefaultPrivateKey() {
    const requestId = ++privateKeyRequest.current;
    resetConnectionStatus();
    setPrivateKeySource("default");
    setPrivateKeyPath("");
    setPrivateKey("");
    setPrivateKeyError("");
    setPrivateKeyOperation("default");
    try {
      const result = await api.loadDefaultSftpPrivateKey();
      if (requestId !== privateKeyRequest.current) return;
      if (!result || result.private_key.trim().length === 0) {
        setPrivateKeyError("未找到默认 SSH 私钥，请选择私钥文件或粘贴私钥。");
        return;
      }
      applyPrivateKeyResult(result, "default");
    } catch (error) {
      if (requestId !== privateKeyRequest.current) return;
      setPrivateKeyError(
        `无法读取默认私钥：${errorMessage(error)} 请重试，或选择私钥文件/粘贴私钥。`,
      );
    } finally {
      if (requestId === privateKeyRequest.current) setPrivateKeyOperation(null);
    }
  }

  async function choosePrivateKeyFile() {
    const requestId = ++privateKeyRequest.current;
    resetConnectionStatus();
    setPrivateKeyError("");
    setPrivateKeyOperation("picker");
    try {
      const result = await api.pickSftpPrivateKey();
      if (requestId !== privateKeyRequest.current) return;
      // A cancelled native picker returns null. Keep the current source and
      // key so cancelling cannot discard a usable credential.
      if (!result) return;
      if (result.private_key.trim().length === 0) {
        setPrivateKeyError(
          "所选文件没有读取到私钥内容，请选择其他文件或直接粘贴私钥。",
        );
        return;
      }
      applyPrivateKeyResult(result, "file");
    } catch (error) {
      if (requestId !== privateKeyRequest.current) return;
      setPrivateKeyError(`读取私钥文件失败：${errorMessage(error)}`);
    } finally {
      if (requestId === privateKeyRequest.current) setPrivateKeyOperation(null);
    }
  }

  function switchToPaste() {
    cancelPrivateKeyRequest();
    resetConnectionStatus();
    setPrivateKeySource("paste");
    setPrivateKeyPath("");
    setPrivateKeyError("");
    // Never place a key read from disk into the visible paste textarea.
    setPrivateKey("");
  }

  useEffect(() => {
    if (!activePrivateKey) {
      cancelPrivateKeyRequest();
      setPrivateKeySource("default");
      setPrivateKeyPath("");
      setPrivateKeyError("");
      setPrivateKey("");
      return;
    }
    void loadDefaultPrivateKey();
  }, [activePrivateKey]);

  useEffect(() => {
    return () => {
      privateKeyRequest.current += 1;
    };
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      hostKeyRequest.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!hostKeyConfirmation) return;
    const frame = requestAnimationFrame(() => {
      const element = hostKeyCheckRef.current;
      if (!element) return;
      element.scrollIntoView({ block: "nearest" });
      element
        .querySelector<HTMLButtonElement>('[data-sftp-host-key-action="trust"]')
        ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [hostKeyConfirmation]);

  useEffect(() => {
    onBusyChange?.(workflowBusy);
    return () => onBusyChange?.(false);
  }, [onBusyChange, workflowBusy]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!actionsBusy) void inspectBeforeAction("save");
  }

  function close() {
    clearHostKeyWorkflow();
    cancelPrivateKeyRequest();
    onClose();
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
        resetConnectionStatus();
        if (hostKeyInspection || hostKeyError) clearHostKeyWorkflow();
      }}
      onSubmit={submit}
    >
      <fieldset
        className="connection-fields remote-fields"
        disabled={busy || hostKeyConfirmation}
      >
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
              onChange={(event) => {
                if (event.target.value !== host) invalidateHostKeyTrust();
                setHost(event.target.value);
              }}
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
              onChange={(event) => {
                if (event.target.value !== port) invalidateHostKeyTrust();
                setPort(event.target.value);
              }}
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

        {volume && (
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={replaceCredentials}
              onChange={(event) => {
                const next = event.target.checked;
                if (!next) {
                  cancelPrivateKeyRequest();
                  setPrivateKeySource("default");
                  setPrivateKeyPath("");
                  setPrivateKeyError("");
                  setPrivateKey("");
                }
                setReplaceCredentials(next);
              }}
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
                      if (next === "private_key") {
                        setPassword("");
                        setPrivateKeySource("default");
                        setPrivateKeyPath("");
                        setPrivateKeyError("");
                        setPrivateKey("");
                      } else {
                        cancelPrivateKeyRequest();
                        setPrivateKey("");
                        setPrivateKeySource("default");
                        setPrivateKeyPath("");
                        setPrivateKeyError("");
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
                <div className="field-label remote-private-key-field">
                  <span className="remote-private-key-label">SSH 私钥</span>
                  <div className="remote-private-key-control">
                    {privateKeyLoading && (
                      <span
                        className="remote-private-key-loading"
                        aria-live="polite"
                      >
                        正在读取私钥…
                      </span>
                    )}
                    {!privateKeyLoading &&
                      privateKeySource === "default" &&
                      (privateKeyPath ? (
                        <span className="remote-private-key-status">
                          已加载默认私钥文件：
                          <code>{privateKeyPath}</code>
                        </span>
                      ) : !privateKeyError ? (
                        <span className="remote-private-key-status">
                          未找到默认 SSH 私钥，请选择私钥文件或粘贴私钥。
                        </span>
                      ) : null)}
                    {!privateKeyLoading && privateKeySource === "file" && (
                      <span className="remote-private-key-status">
                        已选择私钥文件：<code>{privateKeyPath}</code>
                      </span>
                    )}
                    {!privateKeyLoading && privateKeySource === "paste" && (
                      <span className="remote-private-key-status">
                        请粘贴私钥内容。
                      </span>
                    )}
                    {privateKeyError && (
                      <p className="error-text" role="alert">
                        {privateKeyError}
                      </p>
                    )}
                    <div
                      className="remote-private-key-actions"
                      role="group"
                      aria-label="私钥来源"
                    >
                      {privateKeySource !== "default" ||
                      (!privateKeyPath && !privateKeyLoading) ? (
                        <button
                          type="button"
                          className="secondary"
                          data-private-key-source="default"
                          disabled={privateKeyOperation === "default"}
                          onClick={() => void loadDefaultPrivateKey()}
                        >
                          使用默认私钥
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="secondary"
                        data-private-key-source="file"
                        disabled={privateKeyOperation === "picker"}
                        onClick={() => void choosePrivateKeyFile()}
                      >
                        选择私钥文件
                      </button>
                      {privateKeySource !== "paste" && (
                        <button
                          type="button"
                          className="secondary"
                          data-private-key-source="paste"
                          onClick={switchToPaste}
                        >
                          粘贴私钥
                        </button>
                      )}
                    </div>
                    {privateKeySource === "paste" && (
                      <label className="field-label remote-textarea-label">
                        SSH 私钥
                        <textarea
                          className="text-input remote-textarea remote-private-key"
                          autoFocus
                          value={privateKey}
                          onChange={(event) =>
                            setPrivateKey(event.target.value)
                          }
                          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                          rows={5}
                          spellCheck={false}
                          required
                        />
                      </label>
                    )}
                  </div>
                </div>
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

      {hostKeyInspectionPending && pendingSftpAction !== null && (
        <div
          className="remote-host-key-check remote-host-key-pending"
          data-sftp-host-key-state="inspecting"
          role="status"
          aria-live="polite"
        >
          <LoaderCircle size={15} className="spin" aria-hidden="true" />
          <span>正在验证服务器身份…</span>
          <button
            type="button"
            className="secondary"
            data-sftp-host-key-action="cancel"
            onClick={cancelHostKeyAction}
          >
            取消
          </button>
        </div>
      )}
      {hostKeyInspection?.status === "unknown" &&
        pendingSftpAction !== null && (
          <div
            className="remote-host-key-check remote-host-key-unknown"
            data-sftp-host-key-state="unknown"
            role="alert"
            ref={hostKeyCheckRef}
          >
            <strong>首次连接，需要确认服务器身份</strong>
            <p>
              请确认下面的主机密钥信息来自你要连接的服务器。确认后才会继续
              {pendingSftpAction === "test" ? "测试连接" : "保存连接"}。
            </p>
            <dl className="remote-host-key-details">
              <div>
                <dt>服务器</dt>
                <dd>
                  <code>{endpointLabel(hostValue, portNumber)}</code>
                </dd>
              </div>
              <div>
                <dt>SHA256 指纹</dt>
                <dd>
                  <code>{hostKeyInspection.fingerprint}</code>
                </dd>
              </div>
              <div>
                <dt>算法</dt>
                <dd>{hostKeyInspection.algorithm}</dd>
              </div>
            </dl>
            <div className="remote-host-key-actions">
              <button
                type="button"
                className="primary"
                data-sftp-host-key-action="trust"
                onClick={trustAndContinue}
              >
                信任并继续
              </button>
              <button
                type="button"
                className="secondary"
                data-sftp-host-key-action="cancel"
                onClick={cancelHostKeyAction}
              >
                取消
              </button>
            </div>
          </div>
        )}
      {hostKeyInspection?.status === "changed" && (
        <div
          className="remote-host-key-check remote-host-key-changed"
          data-sftp-host-key-state="changed"
          role="alert"
        >
          <strong>服务器主机密钥已变化，已阻止连接</strong>
          <p>
            当前服务器提供的主机密钥与已保存的信任信息不一致。请检查服务器地址、端口和服务器配置后重试。
          </p>
          <dl className="remote-host-key-details">
            <div>
              <dt>服务器</dt>
              <dd>
                <code>{endpointLabel(hostValue, portNumber)}</code>
              </dd>
            </div>
            <div>
              <dt>当前 SHA256 指纹</dt>
              <dd>
                <code>{hostKeyInspection.fingerprint}</code>
              </dd>
            </div>
            <div>
              <dt>算法</dt>
              <dd>{hostKeyInspection.algorithm}</dd>
            </div>
          </dl>
        </div>
      )}
      {hostKeyError && pendingSftpAction !== null && (
        <div
          className="remote-host-key-check remote-host-key-error"
          data-sftp-host-key-state="error"
          role="alert"
        >
          <strong>无法检查服务器身份</strong>
          <p>{hostKeyError}</p>
          <div className="remote-host-key-actions">
            <button
              type="button"
              className="secondary"
              data-sftp-host-key-action="retry"
              disabled={actionsBusy}
              onClick={() => void inspectBeforeAction(pendingSftpAction)}
            >
              重试检查
            </button>
            <button
              type="button"
              className="secondary"
              data-sftp-host-key-action="cancel"
              disabled={actionsBusy}
              onClick={cancelHostKeyAction}
            >
              取消
            </button>
          </div>
        </div>
      )}
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
          onClick={close}
        >
          {embedded ? "返回选择" : "取消"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!valid || actionsBusy}
          onClick={() => void inspectBeforeAction("test")}
        >
          {test.isPending && <LoaderCircle size={14} className="spin" />}
          {test.isPending ? "正在测试…" : "测试连接"}
        </button>
        <button className="primary" disabled={!valid || actionsBusy}>
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
      onClose={close}
      busy={busy}
      className="remote-storage-modal"
    >
      {form}
    </Modal>
  );
}
