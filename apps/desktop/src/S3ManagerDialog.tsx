import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, formatSize } from "./components";
import {
  browsingApi,
  type S3Action,
  type Properties,
  type VersionPage,
  type ObjectVersion,
} from "./browsingApi";
import { errorMessage } from "./api";
import type { Locator, Volume } from "./types";
type Tab = "bucket" | "versions" | "share" | "metadata" | "tags" | "acl";
function Pairs({
  value,
  onChange,
}: {
  value: [string, string][];
  onChange: (value: [string, string][]) => void;
}) {
  return (
    <div className="property-pairs">
      {value.map(([key, text], index) => (
        <div key={index}>
          <input
            aria-label={`名称 ${index + 1}`}
            className="text-input"
            value={key}
            onChange={(e) =>
              onChange(
                value.map((pair, i) =>
                  i === index ? [e.target.value, pair[1]] : pair,
                ),
              )
            }
          />
          <input
            aria-label={`值 ${index + 1}`}
            className="text-input"
            value={text}
            onChange={(e) =>
              onChange(
                value.map((pair, i) =>
                  i === index ? [pair[0], e.target.value] : pair,
                ),
              )
            }
          />
          <button
            type="button"
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            移除
          </button>
        </div>
      ))}
      <button
        type="button"
        className="secondary"
        onClick={() => onChange([...value, ["", ""]])}
      >
        添加一项
      </button>
    </div>
  );
}
function pairsObject(pairs: [string, string][]): Record<string, string> {
  if (
    pairs.some(([k]) => !k.trim()) ||
    new Set(pairs.map(([k]) => k)).size !== pairs.length
  )
    throw new Error("名称不能为空或重复");
  return Object.fromEntries(pairs);
}
function PropertyEditor({
  properties,
  onSave,
  busy,
  readOnly,
}: {
  properties: Properties;
  onSave: (action: S3Action) => void;
  busy: boolean;
  readOnly: boolean;
}) {
  const [pairs, setPairs] = useState<[string, string][]>(
    Object.entries(properties.metadata),
  );
  const [type, setType] = useState(properties.content_type);
  const [error, setError] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        try {
          onSave({
            action: "set_metadata",
            etag: properties.etag,
            content_type: type,
            metadata: pairsObject(pairs),
          });
          setError("");
        } catch (e) {
          setError(errorMessage(e));
        }
      }}
    >
      <fieldset disabled={busy || readOnly}>
        <label className="field-label">
          内容类型
          <input
            className="text-input"
            value={type}
            onChange={(e) => setType(e.target.value)}
            required
          />
        </label>
        <p className="field-help">
          修改自定义 Metadata
          会保存对象的新副本；启用版本控制时会产生新版本。最大支持 5 GiB 对象。
        </p>
        <Pairs value={pairs} onChange={setPairs} />
        <div className="modal-footer">
          <button className="primary">保存 Metadata</button>
        </div>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
function TagsEditor({
  tags,
  onSave,
  busy,
  readOnly,
}: {
  tags: Record<string, string>;
  onSave: (action: S3Action) => void;
  busy: boolean;
  readOnly: boolean;
}) {
  const [pairs, setPairs] = useState<[string, string][]>(Object.entries(tags));
  const [error, setError] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        try {
          onSave({ action: "set_tags", tags: pairsObject(pairs) });
          setError("");
        } catch (e) {
          setError(errorMessage(e));
        }
      }}
    >
      <fieldset disabled={busy || readOnly}>
        <p className="field-help">最多 10 个标签；保存会替换当前标签集合。</p>
        <Pairs value={pairs} onChange={setPairs} />
        <div className="modal-footer">
          <button className="primary">保存标签</button>
        </div>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
export function S3ManagerDialog({
  volume,
  locator,
  object,
  onClose,
}: {
  volume: Volume;
  locator: Locator;
  object: boolean;
  onClose: () => void;
}) {
  const tabs: Tab[] = object
    ? ["versions", "share", "metadata", "tags", "acl"]
    : volume.root.type === "s3" && !volume.root.prefix && !locator.logical_path
      ? ["bucket", "versions"]
      : ["versions"];
  const [tab, setTab] = useState<Tab>(tabs[0]);
  const [confirmation, setConfirmation] = useState("");
  const [bucketName, setBucketName] = useState("");
  const [acl, setAcl] = useState("private");
  const [expires, setExpires] = useState(3600);
  const [share, setShare] = useState("");
  const [message, setMessage] = useState("");
  const [cursor, setCursor] = useState<{
    key: string | null;
    version: string | null;
  }>({ key: null, version: null });
  const [history, setHistory] = useState<(typeof cursor)[]>([]);
  const [pendingVersion, setPendingVersion] = useState<{
    version: ObjectVersion;
    remove: boolean;
  } | null>(null);
  const [versionConfirm, setVersionConfirm] = useState("");
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["s3-manager", locator, tab, cursor],
    queryFn: () =>
      browsingApi.s3<unknown>(
        locator,
        tab === "versions"
          ? {
              action: "versions",
              exact: object,
              key_marker: cursor.key,
              version_marker: cursor.version,
            }
          : {
              action:
                tab === "bucket"
                  ? "bucket_status"
                  : tab === "metadata"
                    ? "properties"
                    : tab === "share"
                      ? "properties"
                      : tab,
            },
      ),
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: ({
      action,
      target = locator,
    }: {
      action: S3Action;
      target?: Locator;
    }) => browsingApi.s3<{ url?: string }>(target, action),
    onSuccess: async (result, request) => {
      if (request.action.action === "share") {
        setShare(result.url ?? "");
        return;
      }
      setMessage(
        request.action.action === "create_bucket"
          ? `Bucket「${request.action.name}」已创建，可在添加存储空间中连接。`
          : request.action.action === "delete_bucket"
            ? "Bucket 已删除，此连接可从侧栏移除。"
            : "操作完成",
      );
      setPendingVersion(null);
      setConfirmation("");
      await client.invalidateQueries({ queryKey: ["s3-manager"] });
      await client.invalidateQueries({ queryKey: ["entries"] });
    },
  });
  const run = (action: S3Action) => {
    setMessage("");
    mutation.mutate({ action });
  };
  const labels: Record<Tab, string> = {
    bucket: "Bucket",
    versions: "历史版本",
    share: "分享链接",
    metadata: "Metadata",
    tags: "标签",
    acl: "访问权限",
  };
  const bucket = volume.root.type === "s3" ? volume.root.bucket : "";
  const versionPage = query.data as VersionPage | undefined;
  return (
    <Modal
      className="advanced-modal"
      title={
        object
          ? `对象管理 · ${locator.logical_path.split("/").at(-1)}`
          : "S3 管理"
      }
      onClose={onClose}
      busy={mutation.isPending}
    >
      <div className="advanced-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            role="tab"
            aria-selected={t === tab}
            key={t}
            onClick={() => {
              setTab(t);
              mutation.reset();
              setMessage("");
            }}
          >
            {labels[t]}
          </button>
        ))}
      </div>
      {volume.read_only && (
        <p className="field-help">
          此连接为只读；可以查看信息和生成临时分享链接。
        </p>
      )}
      {query.isPending && <p role="status">正在读取…</p>}
      {query.isError && (
        <p className="error-text" role="alert">
          {errorMessage(query.error)}{" "}
          <button onClick={() => void query.refetch()}>重试</button>
        </p>
      )}
      {mutation.isError && (
        <p className="error-text" role="alert">
          {errorMessage(mutation.error)}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {query.isSuccess && tab === "bucket" && (
        <fieldset disabled={mutation.isPending || volume.read_only}>
          <h3>{bucket}</h3>
          <p>
            版本控制：
            {(
              {
                Enabled: "已启用",
                Suspended: "已暂停",
                Disabled: "未启用",
              } as Record<string, string>
            )[(query.data as { versioning: string }).versioning] ?? "未知"}
          </p>
          <label className="field-label">
            输入当前 Bucket 名称确认修改
            <input
              className="text-input"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </label>
          <p className="field-help">
            暂停版本控制不会删除已有版本。删除 Bucket
            无法撤销，且必须先清空所有对象、版本与删除标记。
          </p>
          <div className="advanced-actions">
            <button
              className="secondary"
              disabled={confirmation !== bucket}
              onClick={() =>
                run({ action: "set_versioning", enabled: true, confirmation })
              }
            >
              启用版本控制
            </button>
            <button
              className="secondary"
              disabled={confirmation !== bucket}
              onClick={() =>
                run({ action: "set_versioning", enabled: false, confirmation })
              }
            >
              暂停版本控制
            </button>
            <button
              className="danger"
              disabled={confirmation !== bucket}
              onClick={() => run({ action: "delete_bucket", confirmation })}
            >
              删除空 Bucket
            </button>
          </div>
          <hr />
          <label className="field-label">
            新 Bucket 名称
            <input
              className="text-input"
              value={bucketName}
              onChange={(e) => setBucketName(e.target.value)}
            />
          </label>
          <button
            className="primary"
            disabled={!bucketName.trim()}
            onClick={() => run({ action: "create_bucket", name: bucketName })}
          >
            创建 Bucket
          </button>
        </fieldset>
      )}
      {query.isSuccess && tab === "versions" && versionPage && (
        <>
          <p className="field-help">
            包含历史内容与删除标记。恢复会生成新的当前版本；永久删除某个版本无法撤销，删除当前删除标记可能使旧内容重新可见。
          </p>
          <div className="version-list">
            {versionPage.versions
              .filter((v) => !object || v.key === locator.logical_path)
              .map((v) => (
                <article key={v.key + v.version_id}>
                  <strong>
                    {v.key}
                    {v.latest ? " · 当前" : ""}
                    {v.delete_marker ? " · 删除标记" : ""}
                  </strong>
                  <span>
                    {v.modified} · {v.delete_marker ? "" : formatSize(v.size)}
                  </span>
                  <code>{v.version_id}</code>
                  <div className="advanced-actions">
                    <button
                      disabled={
                        volume.read_only ||
                        v.delete_marker ||
                        mutation.isPending
                      }
                      onClick={() => {
                        setPendingVersion({ version: v, remove: false });
                        setVersionConfirm("");
                      }}
                    >
                      恢复为当前版本
                    </button>
                    <button
                      disabled={volume.read_only || mutation.isPending}
                      onClick={() => {
                        setPendingVersion({ version: v, remove: true });
                        setVersionConfirm("");
                      }}
                    >
                      永久删除版本
                    </button>
                    {!v.delete_marker && (
                      <button
                        disabled={mutation.isPending}
                        onClick={() =>
                          mutation.mutate({
                            target: { ...locator, logical_path: v.key },
                            action: {
                              action: "share",
                              expires: 3600,
                              version: v.version_id,
                            },
                          })
                        }
                      >
                        此版本分享链接
                      </button>
                    )}
                  </div>
                </article>
              ))}
          </div>
          {!versionPage.versions.length && <p>没有历史版本或删除标记。</p>}
          <div className="advanced-actions">
            <button
              disabled={!history.length || query.isFetching}
              onClick={() => {
                setCursor(history.at(-1)!);
                setHistory(history.slice(0, -1));
              }}
            >
              上一页
            </button>
            <span>第 {history.length + 1} 页</span>
            <button
              disabled={!versionPage.next_key || query.isFetching}
              onClick={() => {
                setHistory([...history, cursor]);
                setCursor({
                  key: versionPage.next_key,
                  version: versionPage.next_version,
                });
              }}
            >
              下一页
            </button>
          </div>
          {pendingVersion && (
            <div className="version-confirm">
              <p>
                {pendingVersion.remove ? "永久删除" : "恢复"}{" "}
                {pendingVersion.version.key} 的所选版本？输入完整对象名称确认。
              </p>
              <input
                className="text-input"
                aria-label="确认对象名称"
                value={versionConfirm}
                onChange={(e) => setVersionConfirm(e.target.value)}
              />
              <button
                disabled={
                  mutation.isPending ||
                  versionConfirm !== pendingVersion.version.key
                }
                onClick={() =>
                  mutation.mutate({
                    target: {
                      ...locator,
                      logical_path: pendingVersion.version.key,
                    },
                    action: {
                      action: pendingVersion.remove
                        ? "delete_version"
                        : "restore_version",
                      version: pendingVersion.version.version_id,
                      confirmation: versionConfirm,
                    },
                  })
                }
              >
                确认{pendingVersion.remove ? "永久删除" : "恢复"}
              </button>
              <button onClick={() => setPendingVersion(null)}>取消</button>
            </div>
          )}
        </>
      )}
      {query.isSuccess && tab === "share" && (
        <>
          <p className="field-help">
            任何获得链接的人都可在到期前下载此文件，无需账号。临时凭据提前失效时，链接也会失效。
          </p>
          <label className="field-label">
            有效期
            <select
              className="text-input"
              value={expires}
              onChange={(e) => setExpires(Number(e.target.value))}
            >
              <option value={900}>15 分钟</option>
              <option value={3600}>1 小时</option>
              <option value={86400}>1 天</option>
              <option value={604800}>7 天</option>
            </select>
          </label>
          <button
            className="primary"
            disabled={mutation.isPending}
            onClick={() => run({ action: "share", expires, version: null })}
          >
            生成下载链接
          </button>
        </>
      )}
      {share && (
        <label className="field-label">
          临时下载链接（选中后复制）
          <textarea
            readOnly
            className="text-input share-link"
            value={share}
            onFocus={(e) => e.target.select()}
          />
        </label>
      )}
      {query.isSuccess && tab === "metadata" && (
        <PropertyEditor
          key={query.dataUpdatedAt}
          properties={query.data as Properties}
          readOnly={volume.read_only}
          busy={mutation.isPending}
          onSave={run}
        />
      )}
      {query.isSuccess && tab === "tags" && (
        <TagsEditor
          key={query.dataUpdatedAt}
          tags={query.data as Record<string, string>}
          readOnly={volume.read_only}
          busy={mutation.isPending}
          onSave={run}
        />
      )}
      {query.isSuccess && tab === "acl" && (
        <>
          <pre className="acl-details">
            {JSON.stringify(query.data, null, 2)}
          </pre>
          <fieldset disabled={volume.read_only || mutation.isPending}>
            <label className="field-label">
              替换对象 ACL
              <select
                className="text-input"
                value={acl}
                onChange={(e) => setAcl(e.target.value)}
              >
                <option value="private">仅所有者</option>
                <option value="public-read">公开读取（任何人）</option>
                <option value="authenticated-read">
                  所有已认证的 AWS 用户可读
                </option>
                <option value="bucket-owner-full-control">
                  Bucket 所有者完全控制
                </option>
              </select>
            </label>
            <p className="delete-warning">
              保存会替换现有 ACL 授权。公开读取可让任何人访问；实际权限仍受
              Bucket 策略约束。禁用 ACL 的服务会拒绝此操作。
            </p>
            <label className="field-label">
              输入完整对象名称确认
              <input
                className="text-input"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
              />
            </label>
            <button
              className="primary"
              disabled={confirmation !== locator.logical_path}
              onClick={() => run({ action: "set_acl", acl, confirmation })}
            >
              保存权限
            </button>
          </fieldset>
        </>
      )}
    </Modal>
  );
}
