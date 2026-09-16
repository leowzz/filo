import { CheckCircle2, ChevronDown, Link2 } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "./api";
import { Modal } from "./components";
import { useBrowser } from "./store";
import type { Connection, S3Input, S3Provider, Volume } from "./types";
import {
  cloudEndpoint,
  cloudRegions,
  endpointMode,
  s3Providers,
  validEndpoint,
  type EndpointMode,
} from "./s3Providers";

export function S3StorageDialog({
  provider = "generic",
  volume,
  onClose,
  onSaved,
}: {
  provider?: S3Provider;
  volume?: Volume;
  onClose: () => void;
  onSaved: (volume: Omit<Volume, "capabilities">) => void;
}) {
  const connections = useQuery({
    queryKey: ["connections"],
    queryFn: api.connections,
  });
  const connection = connections.data?.find(
    (c) => c.id === volume?.connection_id,
  );
  if (volume && !connection)
    return (
      <Modal title="编辑 S3 连接" onClose={onClose}>
        <p>
          {connections.isError
            ? errorMessage(connections.error)
            : "正在读取连接…"}
        </p>
        {connections.isError && (
          <button onClick={() => void connections.refetch()}>重试</button>
        )}
      </Modal>
    );
  return (
    <S3Form
      provider={connection?.config.provider ?? provider}
      volume={volume}
      connection={connection}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

export function S3Form({
  provider,
  volume,
  connection,
  embedded = false,
  externalBusy = false,
  onBusyChange,
  onClose,
  onSaved,
}: {
  provider: S3Provider;
  volume?: Volume;
  connection?: Connection;
  embedded?: boolean;
  externalBusy?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onClose: () => void;
  onSaved: (volume: Omit<Volume, "capabilities">) => void;
}) {
  const client = useQueryClient();
  const preset = s3Providers[provider];
  const cloud = provider === "tos" || provider === "oss";
  const regions = cloud ? cloudRegions[provider] : [];
  const [addressMode, setAddressMode] = useState<EndpointMode>(
    endpointMode(provider, connection?.config),
  );
  const [customRegion, setCustomRegion] = useState(
    !!connection && !regions.some(([id]) => id === connection.config.region),
  );
  const [name, setName] = useState(volume?.name ?? "");
  const [endpoint, setEndpoint] = useState(
    connection?.config.endpoint ??
      (provider === "rustfs" ? "http://127.0.0.1:9000" : ""),
  );
  const [region, setRegion] = useState(
    connection?.config.region ?? preset.region,
  );
  const [bucket, setBucket] = useState(
    volume?.root.type === "s3" ? volume.root.bucket : "",
  );
  const [prefix, setPrefix] = useState(
    volume?.root.type === "s3" ? volume.root.prefix : "",
  );
  const [pathStyle, setPathStyle] = useState(
    connection?.config.force_path_style ?? !cloud,
  );
  const [readOnly, setReadOnly] = useState(volume?.read_only ?? false);
  const [replaceCredentials, setReplaceCredentials] = useState(!volume);
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [token, setToken] = useState("");
  const [tested, setTested] = useState(false);
  const effectiveEndpoint =
    cloud && addressMode !== "custom"
      ? cloudEndpoint(provider, region, addressMode === "internal")
      : endpoint.trim();
  const endpointValid =
    (!effectiveEndpoint && provider === "generic") ||
    validEndpoint(effectiveEndpoint);
  const input: S3Input = {
    name: name.trim(),
    config: {
      provider,
      endpoint: effectiveEndpoint || null,
      region: region.trim(),
      force_path_style: pathStyle,
    },
    bucket: bucket.trim(),
    prefix,
    read_only: readOnly,
    credentials: replaceCredentials
      ? {
          access_key_id: accessKey,
          secret_access_key: secretKey,
          session_token: token || null,
        }
      : null,
  };
  const test = useMutation({
    mutationFn: () => api.testS3(volume?.id ?? null, input),
    onMutate: () => setTested(false),
    onSuccess: () => setTested(true),
  });
  const save = useMutation({
    mutationFn: () => api.saveS3(volume?.id ?? null, input),
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
  }, [pending, onBusyChange]);
  const valid =
    name.trim() &&
    region.trim() &&
    endpointValid &&
    bucket.trim() &&
    (!replaceCredentials || (accessKey && secretKey));
  const form = (
    <form
      onChange={() => {
        setTested(false);
        test.reset();
        save.reset();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !busy) save.mutate();
      }}
    >
      <fieldset className="connection-fields s3-fields" disabled={busy}>
        <label className="field-label">
          连接名称
          <input
            autoFocus={!embedded}
            className="text-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`例如：${provider === "rustfs" ? "本机 RustFS" : "项目文件"}`}
            required
            maxLength={100}
          />
        </label>
        {cloud && (
          <>
            <div className="s3-region-access-row">
              <div>
                <label className="field-label">
                  地域
                  <span className="s3-select-control">
                    <select
                      className="text-input"
                      value={customRegion ? "custom" : region}
                      onChange={(e) => {
                        setCustomRegion(e.target.value === "custom");
                        if (e.target.value !== "custom")
                          setRegion(e.target.value);
                      }}
                    >
                      {regions.map(([id, label]) => (
                        <option key={id} value={id}>
                          {label} · {id}
                        </option>
                      ))}
                      <option value="custom">其他地域（手动填写）</option>
                    </select>
                    <ChevronDown size={14} aria-hidden="true" />
                  </span>
                </label>
                {customRegion && (
                  <label className="field-label">
                    地域 ID
                    <input
                      className="text-input"
                      value={region}
                      onChange={(e) => setRegion(e.target.value)}
                      required
                    />
                  </label>
                )}
              </div>
              <label className="field-label">
                访问方式
                <span className="s3-select-control">
                  <select
                    className="text-input"
                    value={addressMode}
                    onChange={(e) =>
                      setAddressMode(e.target.value as EndpointMode)
                    }
                  >
                    <option value="public">公网访问</option>
                    <option value="internal">内网访问</option>
                    <option value="custom">自定义访问地址</option>
                  </select>
                  <ChevronDown size={14} aria-hidden="true" />
                </span>
              </label>
            </div>
            {addressMode === "internal" && (
              <p className="field-help">
                需要处于该地域可访问存储服务的内网环境。
              </p>
            )}
          </>
        )}
        <label className="field-label">
          <span className="s3-endpoint-label">
            <span>
              访问地址（Endpoint）{provider === "generic" ? "（可选）" : ""}
            </span>
            {cloud && addressMode !== "custom" && (
              <span className="s3-auto-badge">自动生成</span>
            )}
          </span>
          <span
            className={`s3-endpoint-control${cloud && addressMode !== "custom" ? " is-generated" : ""}`}
          >
            <Link2 size={15} aria-hidden="true" />
            <input
              className="text-input"
              value={effectiveEndpoint}
              readOnly={cloud && addressMode !== "custom"}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder={
                provider === "generic"
                  ? "留空使用 AWS S3"
                  : "https://s3.example.com"
              }
              required={provider !== "generic"}
              aria-invalid={!endpointValid}
            />
          </span>
          <span className="field-help s3-input-help">
            {provider === "rustfs"
              ? "填写 S3 API 地址，默认端口 9000；不是控制台的 9001 端口。"
              : cloud && addressMode !== "custom"
                ? "已根据地域生成 S3 接入地址。"
                : "填写完整 HTTP(S) 服务地址，不含 Bucket、路径或访问密钥。"}
          </span>
        </label>
        {effectiveEndpoint && !endpointValid && (
          <p className="error-text">
            请填写完整的 HTTP(S) 地址，仅包含主机和端口。
          </p>
        )}
        {provider === "generic" && (
          <label className="field-label">
            地域（Region）
            <input
              className="text-input"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              required
            />
          </label>
        )}
        <label className="field-label">
          存储桶（Bucket）
          <input
            className="text-input"
            value={bucket}
            onChange={(e) => setBucket(e.target.value)}
            placeholder="已有存储桶的名称"
            required
          />
        </label>
        <label className="field-label">
          目录前缀（Prefix，可选）
          <input
            className="text-input"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            placeholder="例如 backups/photos"
          />
        </label>
        {volume && (
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={replaceCredentials}
              onChange={(e) => setReplaceCredentials(e.target.checked)}
            />
            更换访问凭据
          </label>
        )}
        {replaceCredentials && (
          <>
            <label className="field-label">
              Access Key ID
              <input
                className="text-input"
                autoComplete="off"
                value={accessKey}
                onChange={(e) => setAccessKey(e.target.value)}
                required
              />
            </label>
            <label className="field-label">
              {provider === "oss" ? "AccessKey Secret" : "Secret Access Key"}
              <input
                type="password"
                className="text-input"
                autoComplete="new-password"
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                required
              />
            </label>
            <label className="field-label">
              {provider === "oss"
                ? "Security Token（STS，可选）"
                : "Session Token（临时凭据，可选）"}
              <input
                type="password"
                className="text-input"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
          </>
        )}
        {(provider === "generic" || provider === "rustfs") && (
          <details
            className="s3-advanced"
            open={
              provider === "rustfs" && (region !== preset.region || !pathStyle)
                ? true
                : undefined
            }
          >
            <summary>高级设置</summary>
            {provider === "rustfs" && (
              <label className="field-label">
                地域（Region）
                <input
                  className="text-input"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  required
                />
                <span className="field-help s3-input-help">
                  默认 us-east-1，仅在服务端使用其他地域时修改。
                </span>
              </label>
            )}
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={pathStyle}
                onChange={(e) => setPathStyle(e.target.checked)}
              />
              使用路径式访问（Path Style）
            </label>
            <p className="field-help">
              RustFS / MinIO 通常启用；AWS S3 通常使用虚拟主机式访问。
            </p>
          </details>
        )}
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={readOnly}
            onChange={(e) => setReadOnly(e.target.checked)}
          />
          只读访问
        </label>
        <p className="field-help">
          凭据保存在系统钥匙串。保存前会测试所选 Bucket / Prefix 的访问权限。
        </p>
      </fieldset>
      {(save.isError || test.isError) && (
        <p className="error-text" role="alert">
          {errorMessage(save.error ?? test.error)}
        </p>
      )}
      {tested && (
        <div className="s3-test-success" role="status">
          <CheckCircle2 size={16} aria-hidden="true" />
          <span>连接成功，可以访问所选 Bucket / Prefix。</span>
          <span className="s3-test-confetti" aria-hidden="true">
            {Array.from({ length: 18 }, (_, index) => (
              <i
                key={index}
                style={
                  {
                    "--confetti-x": `${((index * 47) % 221) - 110}px`,
                    "--confetti-rise": `${-35 - ((index * 19) % 50)}px`,
                    "--confetti-spin": `${index % 2 ? 240 : -240}deg`,
                    "--confetti-delay": `${(index % 5) * 35}ms`,
                  } as CSSProperties
                }
              />
            ))}
          </span>
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
          {test.isPending ? "正在测试…" : "测试连接"}
        </button>
        <button className="primary" disabled={!valid || busy}>
          {save.isPending ? "正在保存…" : "保存连接"}
        </button>
      </div>
    </form>
  );
  return embedded ? (
    form
  ) : (
    <Modal
      title={`${volume ? "编辑" : "添加"} ${preset.name}`}
      onClose={onClose}
      busy={busy}
    >
      {form}
    </Modal>
  );
}
