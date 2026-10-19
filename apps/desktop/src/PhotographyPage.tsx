import { useState } from "react";
import { Copy, Images } from "lucide-react";
import { PhotoImportPage } from "./PhotoImportPage";
import { PhotoLibraryPage } from "./PhotoLibraryPage";
import type { Volume } from "./types";
export function PhotographyPage({ volumes }: { volumes: Volume[] }) {
  const [tab, setTab] = useState(() =>
    sessionStorage.getItem("filo.photography-tab") === "review"
      ? "review"
      : "copy",
  );
  return (
    <div className="photography-page">
      <nav className="photo-workspace-tabs" aria-label="摄影功能">
        <button
          aria-current={tab === "copy"}
          onClick={() => {
            setTab("copy");
            sessionStorage.setItem("filo.photography-tab", "copy");
          }}
        >
          <Copy size={16} />
          拷卡
        </button>
        <button
          aria-current={tab === "review"}
          onClick={() => {
            setTab("review");
            sessionStorage.setItem("filo.photography-tab", "review");
          }}
        >
          <Images size={16} />
          审图
        </button>
      </nav>
      {tab === "copy" ? (
        <PhotoImportPage volumes={volumes} />
      ) : (
        <PhotoLibraryPage />
      )}
    </div>
  );
}
