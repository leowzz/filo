import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, ChevronDown, ChevronRight, Folder } from "lucide-react";
import { api, errorMessage } from "./api";
import { canWriteVolume } from "./fileClipboard";
import { useDirectoryQuery } from "./useDirectoryQuery";
import type { PhotoDirectory } from "./photoApi";

export function StorageDirectoryPicker({
  initialVolumeId,
  onSelect,
  onCancel,
}: {
  initialVolumeId?: string;
  onSelect: (directory: PhotoDirectory) => void;
  onCancel: () => void;
}) {
  const volumes = useQuery({ queryKey: ["volumes"], queryFn: api.volumes });
  const writable = (volumes.data ?? []).filter(canWriteVolume);
  const [chosenVolume, setChosenVolume] = useState(initialVolumeId ?? "");
  const volume = writable.find((v) => v.id === chosenVolume) ?? writable[0];
  const [path, setPath] = useState("");
  const [page, setPage] = useState(0);
  const directory = useDirectoryQuery(
    { volume_id: volume?.id ?? "", logical_path: path, version_id: null },
    {
      search: "",
      show_hidden: true,
      folders_only: true,
      sort: volume?.root.type === "s3" ? "provider" : "name",
    },
  );
  const folders = directory.data?.pages[page]?.entries ?? [];
  const changePath = (next: string) => {
    setPath(next);
    setPage(0);
  };
  return (
    <div className="photo-storage-picker">
      <label>
        存储
        <span className="photo-export-select">
          <select
            className="text-input"
            aria-label="导出存储"
            value={volume?.id ?? ""}
            onChange={(e) => {
              setChosenVolume(e.target.value);
              changePath("");
            }}
          >
            {!writable.length && <option value="">没有可写的存储</option>}
            {writable.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
          <ChevronDown size={15} aria-hidden="true" />
        </span>
      </label>
      {volumes.isPending && <p role="status">正在读取存储…</p>}
      {volumes.isError && (
        <p className="form-error" role="alert">
          {errorMessage(volumes.error)}{" "}
          <button type="button" onClick={() => void volumes.refetch()}>
            重试
          </button>
        </p>
      )}
      {volume && (
        <div className="destination-browser">
          <div className="destination-path">
            <button
              type="button"
              className="icon-button"
              aria-label="导出上级目录"
              disabled={!path}
              onClick={() => changePath(path.split("/").slice(0, -1).join("/"))}
            >
              <ArrowUp size={16} />
            </button>
            <span>{path ? `/${path}` : "/"}</span>
          </div>
          <div className="destination-folders">
            {directory.isPending && <p role="status">正在读取目录…</p>}
            {directory.isError && (
              <p className="form-error" role="alert">
                {errorMessage(directory.error)}{" "}
                <button type="button" onClick={() => void directory.refetch()}>
                  重试
                </button>
              </p>
            )}
            {folders.map((folder) => (
              <button
                type="button"
                key={folder.locator.logical_path}
                onClick={() => changePath(folder.locator.logical_path)}
              >
                <Folder size={17} />
                <span>{folder.name}</span>
                <ChevronRight size={15} />
              </button>
            ))}
            {directory.isSuccess && !folders.length && (
              <p>
                {directory.hasNextPage
                  ? "此页没有子文件夹，可继续下一页查找。"
                  : "此目录没有子文件夹"}
              </p>
            )}
          </div>
          {(page > 0 ||
            directory.hasNextPage ||
            (directory.data?.pages.length ?? 0) > 1) && (
            <div className="destination-path">
              <button
                type="button"
                disabled={page === 0 || directory.isFetching}
                onClick={() => setPage(page - 1)}
              >
                上一页
              </button>
              <button
                type="button"
                disabled={
                  directory.isFetching ||
                  (!directory.hasNextPage &&
                    page >= (directory.data?.pages.length ?? 1) - 1)
                }
                onClick={async () => {
                  if (page >= (directory.data?.pages.length ?? 1) - 1) {
                    const next = await directory.fetchNextPage();
                    if (next.isError) return;
                  }
                  setPage(page + 1);
                }}
              >
                下一页
              </button>
            </div>
          )}
        </div>
      )}
      <div className="photo-export-directory-actions">
        <button type="button" className="secondary" onClick={onCancel}>
          取消选择
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!volume || !directory.isSuccess || volumes.isError}
          onClick={() => {
            if (!volume) return;
            onSelect({
              locator: {
                volume_id: volume.id,
                logical_path: path,
                version_id: null,
              },
              path: `${volume.name} /${path}`,
            });
          }}
        >
          选择此目录
        </button>
      </div>
    </div>
  );
}
