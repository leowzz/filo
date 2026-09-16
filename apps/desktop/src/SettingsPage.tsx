import { SlidersHorizontal } from "lucide-react";
import { useBrowser } from "./store";
import { TransferSettingsCard } from "./TransferSettingsCard";
import { AppUpdateCard } from "./AppUpdateCard";
import type { AppUpdater } from "./useAppUpdater";

export function SettingsPage({ updater }: { updater: AppUpdater }) {
  const state = useBrowser();
  return (
    <div className="page-scroll simple-page">
      <h1>设置</h1>
      <TransferSettingsCard />
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
      <AppUpdateCard updater={updater} />
    </div>
  );
}
