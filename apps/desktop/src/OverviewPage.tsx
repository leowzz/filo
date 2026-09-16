import {
  ArrowRight,
  Database,
  HardDrive,
  LoaderCircle,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { type Volume } from "./types";

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
          <h2>你的存储空间</h2>
          <p>连接本地目录或 S3 存储，浏览和管理你的文件。</p>
        </div>
        <button className="primary" onClick={() => onAdd()}>
          <Plus size={17} />
          添加存储空间
        </button>
      </div>
      <div className="stats">
        <div>
          <span>
            <HardDrive size={17} />
            存储空间
          </span>
          <strong>
            {volumes.length.toString().padStart(2, "0")}
            <small>个位置</small>
          </strong>
        </div>
        <div>
          <span>
            <Database size={17} />
            已保存连接
          </span>
          <strong>
            {new Set(volumes.map((item) => item.connection_id)).size
              .toString()
              .padStart(2, "0")}
            <small>个连接</small>
          </strong>
        </div>
        <div>
          <span>
            <ShieldCheck size={17} />
            数据访问
          </span>
          <strong className="text-stat">
            仅限授权位置<small>本地目录与 S3 Bucket / Prefix</small>
          </strong>
        </div>
      </div>
      <div className="section-heading">
        <h2>
          你的存储空间 <span>{volumes.length}</span>
        </h2>
        <span className="muted">所有已添加的位置</span>
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
                <HardDrive size={22} />
              </span>
              <div className="volume-info">
                <h3 title={item.name}>{item.name}</h3>
                <p
                  title={
                    item.root.type === "local"
                      ? item.root.root_path
                      : `s3://${item.root.bucket}/${item.root.prefix}`
                  }
                >
                  {item.root.type === "local"
                    ? item.root.root_path
                    : `s3://${item.root.bucket}/${item.root.prefix}`}
                </p>
              </div>
              <div className="card-bottom">
                <span className="pill">
                  {item.read_only
                    ? "只读"
                    : item.root.type === "s3"
                      ? "S3"
                      : "本地目录"}
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
                {volumes.length ? "连接另一个存储空间" : "连接本地目录或 S3"}
              </h3>
              <p>选择已有目录，直接浏览其中的文件</p>
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
