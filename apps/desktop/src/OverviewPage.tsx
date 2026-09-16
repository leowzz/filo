import {
  ArrowRight,
  Cloud,
  HardDrive,
  LoaderCircle,
  Network,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { type Volume } from "./types";
import { StorageTypeLabel } from "./StorageProvider";

export function OverviewPage({
  volumes,
  loading,
  openVolume,
  onAdd,
}: {
  volumes: Volume[];
  loading: boolean;
  openVolume: (volume: Volume) => void;
  onAdd: () => void;
}) {
  return (
    <div className="overview page-scroll">
      <div className="page-heading">
        <div>
          <h2>你的存储空间{!loading && ` · ${volumes.length}`}</h2>
          <p>连接本地目录、对象存储或文件服务器，统一管理你的文件。</p>
        </div>
        <button className="primary" onClick={() => onAdd()}>
          <Plus size={17} />
          添加存储空间
        </button>
      </div>
      {loading ? (
        <div className="empty-state">
          <LoaderCircle className="spin" />
          正在读取存储空间…
        </div>
      ) : (
        <div className="volume-grid">
          {volumes.map((item) => (
            <button
              className="volume-card"
              key={item.id}
              onClick={() => openVolume(item)}
            >
              <span className="drive-tile">
                {item.root.type === "remote" ? (
                  <Network size={22} />
                ) : item.root.type === "s3" ? (
                  <Cloud size={22} />
                ) : (
                  <HardDrive size={22} />
                )}
              </span>
              <div className="volume-info">
                <h3 title={item.name}>{item.name}</h3>
                <p
                  title={
                    item.root.type === "local"
                      ? item.root.root_path
                      : item.root.type === "s3"
                        ? `s3://${item.root.bucket}/${item.root.prefix}`
                        : item.root.path || "/"
                  }
                >
                  {item.root.type === "local"
                    ? item.root.root_path
                    : item.root.type === "s3"
                      ? `s3://${item.root.bucket}/${item.root.prefix}`
                      : item.root.path || "/"}
                </p>
              </div>
              <div className="card-bottom">
                <span className="pill">
                  {item.root.type !== "local" ? (
                    <StorageTypeLabel volume={item} />
                  ) : (
                    "本地目录"
                  )}
                  {item.read_only && " · 只读"}
                </span>
                <span>打开文件浏览器</span>
                <ArrowRight size={17} />
              </div>
            </button>
          ))}
          <button className="new-volume-card" onClick={() => onAdd()}>
            <span>
              <Plus size={25} />
            </span>
            <div className="volume-info">
              <h3>
                {volumes.length ? "连接另一个存储空间" : "连接你的存储空间"}
              </h3>
              <p>添加本地目录或远程连接，直接浏览已有文件</p>
            </div>
          </button>
        </div>
      )}
      <div className="overview-footer">
        <ShieldCheck size={14} />
        <span>连接信息仅保存在此设备，文件保留在原始位置。</span>
      </div>
    </div>
  );
}
