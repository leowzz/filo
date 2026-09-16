import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "./api";
import { Modal } from "./components";
import { useBrowser } from "./store";
import type { Connection, S3Input, Volume } from "./types";

export function S3StorageDialog({
  volume,
  onClose,
  onSaved,
}: {
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
      volume={volume}
      connection={connection}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

function S3Form({
  volume,
  connection,
  onClose,
  onSaved,
}: {
  volume?: Volume;
  connection?: Connection;
  onClose: () => void;
  onSaved: (volume: Omit<Volume, "capabilities">) => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState(volume?.name ?? "");
  const [endpoint, setEndpoint] = useState(
    connection?.config.endpoint ?? "http://127.0.0.1:9000",
  );
  const [region, setRegion] = useState(
    connection?.config.region ?? "us-east-1",
  );
  const [bucket, setBucket] = useState(
    volume?.root.type === "s3" ? volume.root.bucket : "filo-demo",
  );
  const [prefix, setPrefix] = useState(
    volume?.root.type === "s3" ? volume.root.prefix : "",
  );
  const [pathStyle, setPathStyle] = useState(
    connection?.config.force_path_style ?? true,
  );
  const [readOnly, setReadOnly] = useState(volume?.read_only ?? false);
  const [replaceCredentials, setReplaceCredentials] = useState(!volume);
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [token, setToken] = useState("");
  const [tested, setTested] = useState(false);
  const input: S3Input = {
    name: name.trim(),
    config: {
      endpoint: endpoint.trim() || null,
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
  const busy = save.isPending || test.isPending;
  const valid =
    name.trim() &&
    region.trim() &&
    bucket.trim() &&
    (!replaceCredentials || (accessKey && secretKey));
  return (
    <Modal
      title={volume ? "编辑 S3 连接" : "添加 S3 兼容存储"}
      onClose={onClose}
      busy={busy}
    >
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
              autoFocus
              className="text-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="本机 RustFS"
              required
              maxLength={100}
            />
          </label>
          <label className="field-label">
            Endpoint
            <input
              className="text-input"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="留空使用 AWS S3"
            />
          </label>
          <div className="s3-field-row">
            <label className="field-label">
              Region
              <input
                className="text-input"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                required
              />
            </label>
            <label className="field-label">
              Bucket
              <input
                className="text-input"
                value={bucket}
                onChange={(e) => setBucket(e.target.value)}
                required
              />
            </label>
          </div>
          <label className="field-label">
            Prefix（可选）
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
                Secret Access Key
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
                Session Token（可选）
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
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={pathStyle}
              onChange={(e) => setPathStyle(e.target.checked)}
            />
            Path Style（RustFS / MinIO 通常启用）
          </label>
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
          <p className="field-help" role="status">
            连接成功，可以访问所选 Bucket / Prefix。
          </p>
        )}
        <div className="modal-footer">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            取消
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
    </Modal>
  );
}
