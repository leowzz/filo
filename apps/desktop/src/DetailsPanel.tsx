import { Copy, HardDrive, Info, ShieldCheck } from "lucide-react";
import { EntryIcon, formatDate, formatSize, typeName } from "./components";
import { type Entry, type Volume } from "./types";
import { S3StorageOverview } from "./S3StorageOverview";
import { StorageTypeLabel } from "./StorageProvider";

export function DetailsPanel({
  volume,
  path,
  selectedEntries,
  entryCount,
}: {
  volume: Volume;
  path: string;
  selectedEntries: Entry[];
  entryCount?: number;
}) {
  const selected =
    selectedEntries.length === 1 ? selectedEntries[0] : undefined;
  const multipleSelected = selectedEntries.length > 1;
  return (
    <aside className="details-panel">
      <div className="details-heading">
        {multipleSelected ? "所选项目" : selected ? "项目详情" : "存储详情"}
        <Info size={15} />
      </div>
      <div className={`detail-icon ${selected ? "" : "drive"}`}>
        {multipleSelected ? (
          <Copy size={48} strokeWidth={1.2} />
        ) : selected ? (
          <EntryIcon entry={selected} size={54} />
        ) : (
          <HardDrive size={48} strokeWidth={1.2} />
        )}
      </div>
      <h3>
        {multipleSelected
          ? `已选择 ${selectedEntries.length} 项`
          : (selected?.name ?? volume.name)}
      </h3>
      <span className="pill">
        {multipleSelected ? (
          "多个项目"
        ) : selected ? (
          typeName(selected)
        ) : (
          <StorageTypeLabel volume={volume} />
        )}
      </span>
      {selectedEntries.length === 0 && volume.root.type === "s3" && (
        <S3StorageOverview volume={volume} />
      )}
      <dl>
        <dt>位置</dt>
        <dd>
          {selected?.locator.logical_path ??
            (volume.root.type === "local" ? volume.root.root_path : "/")}
        </dd>
        {selected ? (
          <>
            <dt>大小</dt>
            <dd>{formatSize(selected.size)}</dd>
            <dt>修改时间</dt>
            <dd>{formatDate(selected.modified_at)}</dd>
          </>
        ) : (
          <>
            <dt>当前目录</dt>
            <dd>{path || "/"}</dd>
            <dt>项目数</dt>
            <dd>
              {multipleSelected ? selectedEntries.length : (entryCount ?? "—")}
            </dd>
          </>
        )}
        <dt>访问权限</dt>
        <dd>{volume.read_only ? "只读" : "可读写"}</dd>
      </dl>
      <div className="detail-tip">
        <ShieldCheck size={16} />
        <p>
          {selected?.kind === "symlink"
            ? "符号链接仅展示，不允许通过链接访问或修改文件。"
            : volume.root.type === "s3"
              ? "更改直接应用到 S3 对象。删除为永久删除，重命名会先复制并校验目标。"
              : "文件保留在原始目录，所有更改直接应用到本地文件系统。"}
        </p>
      </div>
    </aside>
  );
}
