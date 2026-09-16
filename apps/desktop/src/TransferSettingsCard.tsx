import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gauge, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { api, errorMessage } from "./api";
import type { TransferSettings } from "./types";

const settingsKey = ["transfer-settings"];

export function TransferSettingsCard() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: settingsKey,
    queryFn: api.transferSettings,
  });
  const save = useMutation({
    mutationFn: api.saveTransferSettings,
    onSuccess: (settings) => client.setQueryData(settingsKey, settings),
  });
  return (
    <section className="settings-card">
      <h2>
        <Gauge size={19} />
        传输速度
      </h2>
      <p>上传和下载分别限速，同一方向的并行任务共享上限。默认不限速。</p>
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
        <TransferSettingsForm
          key={JSON.stringify(query.data)}
          initial={query.data}
          pending={save.isPending}
          onChange={save.reset}
          onSave={save.mutate}
        />
      )}
      {save.isError && (
        <p className="error-text" role="alert">
          {errorMessage(save.error)}
        </p>
      )}
      {save.isSuccess && (
        <p className="transfer-settings-saved" role="status">
          传输速度设置已保存，正在传输的任务也会应用。
        </p>
      )}
    </section>
  );
}

function TransferSettingsForm({
  initial,
  pending,
  onSave,
  onChange,
}: {
  initial: TransferSettings;
  pending: boolean;
  onSave: (settings: TransferSettings) => void;
  onChange: () => void;
}) {
  const [upload, setUpload] = useState(String(initial.upload_kib_per_second));
  const [download, setDownload] = useState(
    String(initial.download_kib_per_second),
  );
  const valid = [upload, download].every(
    (value) => /^\d+$/.test(value) && Number(value) <= 1_048_576,
  );
  return (
    <form
      className="transfer-settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !pending)
          onSave({
            upload_kib_per_second: Number(upload),
            download_kib_per_second: Number(download),
          });
      }}
    >
      <label htmlFor="upload-speed">
        <div>
          <strong>上传速度上限</strong>
          <p>
            {Number(upload) === 0 && upload !== ""
              ? "不限速"
              : "所有上传任务共用"}
          </p>
        </div>
        <span className="transfer-speed-input">
          <input
            id="upload-speed"
            aria-label="上传速度上限"
            aria-describedby="transfer-speed-help"
            type="number"
            min="0"
            max="1048576"
            step="1"
            required
            value={upload}
            disabled={pending}
            onChange={(event) => {
              setUpload(event.target.value);
              onChange();
            }}
          />
          <span>KiB/s</span>
        </span>
      </label>
      <label htmlFor="download-speed">
        <div>
          <strong>下载速度上限</strong>
          <p>
            {Number(download) === 0 && download !== ""
              ? "不限速"
              : "所有下载及远程校验读取共用"}
          </p>
        </div>
        <span className="transfer-speed-input">
          <input
            id="download-speed"
            aria-label="下载速度上限"
            aria-describedby="transfer-speed-help"
            type="number"
            min="0"
            max="1048576"
            step="1"
            required
            value={download}
            disabled={pending}
            onChange={(event) => {
              setDownload(event.target.value);
              onChange();
            }}
          />
          <span>KiB/s</span>
        </span>
      </label>
      <p className="field-help" id="transfer-speed-help">
        0 表示不限速，1024 KiB/s = 1
        MiB/s。限制任务的平均速度；本地文件互拷不受影响。保存后重启仍然有效。
      </p>
      {!valid && (
        <p className="error-text" role="alert">
          请输入 0 到 1048576 的整数。
        </p>
      )}
      <div className="transfer-settings-actions">
        <button
          type="button"
          className="secondary"
          disabled={pending}
          onClick={() => {
            setUpload("0");
            setDownload("0");
            onChange();
          }}
        >
          恢复不限速
        </button>
        <button className="primary" disabled={!valid || pending}>
          {pending && <LoaderCircle size={14} className="spin" />}保存速度设置
        </button>
      </div>
    </form>
  );
}
