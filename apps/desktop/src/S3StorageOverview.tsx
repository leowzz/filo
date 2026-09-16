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
  source?: "tos_bucket_stat";
  bucket_stats_error?: string;
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
  const bucketStats = overview?.source === "tos_bucket_stat";

  return (
    <section
      className="storage-overview"
      aria-label="存储概览"
      aria-busy={query.isFetching}
    >
      <div className="storage-overview-heading">
        <h4>{bucketStats ? "存储桶概览" : "存储概览"}</h4>
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
        {bucketStats && volume.root.type === "s3"
          ? `范围：整个桶（${volume.root.bucket}）`
          : prefix
            ? `范围：${prefix}/（含子目录）`
            : "范围：整个 Bucket（含子目录）"}
      </p>
      {bucketStats && (
        <p className="storage-overview-note">
          桶级别数据，覆盖桶内所有路径，并非当前配置位置的单独统计。
        </p>
      )}
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
          {overview.bucket_stats_error && (
            <p className="storage-overview-note">
              {overview.bucket_stats_error}。当前显示的是配置位置的统计。
            </p>
          )}
          <dl>
            <dt>
              {bucketStats
                ? "桶内对象数量"
                : overview.complete
                  ? "对象数量"
                  : "已统计对象"}
            </dt>
            <dd>
              {overview.object_count.toLocaleString()}
              {overview.complete ? "" : "+"} 个
            </dd>
            {overview.complete && (
              <>
                <dt>{bucketStats ? "桶占用空间" : "对象总容量"}</dt>
                <dd>{formatSize(overview.total_size)}</dd>
              </>
            )}
          </dl>
          <p className="storage-overview-note">
            {bucketStats
              ? "由 TOS 提供，非实时数据，延迟可能超过一小时。"
              : overview.complete
                ? "仅统计当前版本，不含历史版本和未完成的上传。"
                : "统计结果不准确：仅统计了部分对象，尚未取得完整数量。"}
          </p>
          <p className="storage-overview-note">
            {bucketStats ? "获取于" : "更新于"}{" "}
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
