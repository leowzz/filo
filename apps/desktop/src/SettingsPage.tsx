import { ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useBrowser } from "./store";

export function SettingsPage() {
  const state = useBrowser();
  return (
    <div className="page-scroll simple-page">
      <h1>设置</h1>
      <section className="settings-card">
        <h2>
          <SlidersHorizontal size={19} />
          浏览偏好
        </h2>
        <label>
          <div>
            <strong>显示隐藏文件</strong>
            <p>显示名称以「.」开头的文件和目录</p>
          </div>
          <input
            type="checkbox"
            checked={state.showHidden}
            onChange={state.toggleHidden}
          />
        </label>
        <label>
          <div>
            <strong>显示详情面板</strong>
            <p>在文件列表右侧展示项目属性</p>
          </div>
          <input
            type="checkbox"
            checked={state.showDetails}
            onChange={state.toggleDetails}
          />
        </label>
      </section>
      <section className="settings-card">
        <h2>
          <ShieldCheck size={19} />
          关于这个版本
        </h2>
        <p>Filo 0.1.0 · LocalFS + S3</p>
        <p>
          存储连接保存在设备上的 SQLite
          数据库。只能访问通过系统选择器添加的目录，不跟随符号链接；删除操作需要确认。
        </p>
        <p>
          支持本地与 S3
          之间的单文件上传、下载、复制和移动；暂不提供文件预览和目录递归传输。
        </p>
      </section>
    </div>
  );
}
