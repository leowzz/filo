import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { errorMessage } from "./api";
import { browsingApi } from "./browsingApi";
import { formatSize } from "./components";
import type { Volume } from "./types";

type StorageOverview = {
  object_count: number;
  total_size: number;
  complete: boolean;
};

export function S3StorageOverview({ volume }: { volume: Volume }) {
  const query = useQuery({
    queryKey: ["s3-storage-overview", volume.id, volume.root],
    queryFn: () =>
      browsingApi.s3<StorageOverview>(
        { volume_id: volume.id, logical_path: "", version_id: null },
        { action: "storage_overview" },
      ),
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const overview = query.data;
  const prefix = volume.root.type === "s3" ? volume.root.prefix : "";

  return (
    <section
      className="storage-overview"
      aria-label="存储概览"
      aria-busy={query.isFetching}
    >
      <div className="storage-overview-heading">
        <h4>存储概览</h4>
        <button
          className="icon-button"
          aria-label="刷新存储概览"
          title="刷新存储概览"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={13} className={query.isFetching ? "spin" : ""} />
        </button>
      </div>
      <p className="storage-overview-note">
        {prefix
          ? `范围：${prefix}/（含子目录）`
          : "范围：整个 Bucket（含子目录）"}
      </p>
      {query.isPending ? (
        <p className="storage-overview-note" role="status">
          正在读取概览…
        </p>
      ) : query.isError ? (
        <div role="alert">
          <p className="storage-overview-note">
            概览读取失败：{errorMessage(query.error)}
          </p>
          <button
            className="secondary"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            重试
          </button>
        </div>
      ) : overview ? (
        <>
          <dl>
            <dt>{overview.complete ? "对象数量" : "已统计对象"}</dt>
            <dd>{overview.object_count.toLocaleString()} 个</dd>
            <dt>{overview.complete ? "对象总容量" : "已统计容量"}</dt>
            <dd>{formatSize(overview.total_size)}</dd>
          </dl>
          <p className="storage-overview-note">
            {overview.complete
              ? "仅统计当前版本，不含历史版本和未完成的上传。"
              : "仅为部分对象的统计，尚未取得总量。为避免遍历整个存储，仅读取一页对象。"}
          </p>
          <p className="storage-overview-note">
            更新于{" "}
            {new Date(query.dataUpdatedAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        </>
      ) : null}
    </section>
  );
}
