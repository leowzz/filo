import { Bug, SlidersHorizontal } from "lucide-react";
import { useBrowser } from "./store";
import { TransferSettingsCard } from "./TransferSettingsCard";
import { CredentialSettingsCard } from "./CredentialSettingsCard";
import { AppUpdateCard } from "./AppUpdateCard";
import type { AppUpdater } from "./useAppUpdater";
import { useAppSettings } from "./appSettings";
import { PreviewCacheSettingsCard } from "./PreviewCacheSettingsCard";

export function SettingsPage({ updater }: { updater: AppUpdater }) {
  const state = useBrowser();
  const { debugMode, setDebugMode } = useAppSettings();
  return (
    <div className="page-scroll simple-page">
      <h1>设置</h1>
      <CredentialSettingsCard />
      <TransferSettingsCard />
      <PreviewCacheSettingsCard />
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
          <Bug size={19} />
          调试
        </h2>
        <label>
          <div>
            <strong>Debug 模式</strong>
            <p>在审图胶片带上显示主预览的缓存状态</p>
          </div>
          <input
            type="checkbox"
            aria-label="Debug 模式"
            checked={debugMode}
            onChange={(event) => setDebugMode(event.target.checked)}
          />
        </label>
      </section>
      <AppUpdateCard updater={updater} />
    </div>
  );
}
