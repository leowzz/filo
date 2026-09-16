import { useEffect, useEffectEvent, useState, type RefObject } from "react";
import { desktop, errorMessage } from "./api";
import { listenFileDrop } from "./fileDropEvents";

export function useExternalFileDrop({
  areaRef,
  readOnly,
  busy,
  onDrop,
  onError,
}: {
  areaRef: RefObject<HTMLDivElement | null>;
  readOnly: boolean;
  busy: boolean;
  onDrop: (paths: string[]) => void;
  onError: (message: string) => void;
}) {
  const [hovering, setHovering] = useState(false);
  const handleDrop = useEffectEvent((paths: string[]) => {
    if (readOnly) onError("当前目录为只读，无法上传");
    else if (busy) onError("正在提交上传任务，请稍后再拖入");
    else if (paths.length > 0) onDrop(paths);
  });
  const reportError = useEffectEvent((error: unknown) =>
    onError(errorMessage(error)),
  );
  useEffect(() => {
    if (!desktop) return;
    let stopped = false;
    const listening = Promise.resolve().then(() =>
      listenFileDrop((payload) => {
        if (stopped) return;
        if (payload.type === "leave") {
          setHovering(false);
          return;
        }
        const rect = areaRef.current?.getBoundingClientRect();
        const x = payload.position.x / window.devicePixelRatio;
        const y = payload.position.y / window.devicePixelRatio;
        const inside =
          !!rect &&
          x >= rect.left &&
          x < rect.right &&
          y >= rect.top &&
          y < rect.bottom;
        const blocked = !!document.querySelector('dialog[open], [role="menu"]');
        if (payload.type === "drop") {
          setHovering(false);
          if (inside && !blocked) handleDrop(payload.paths);
        } else {
          setHovering(inside && !blocked);
        }
      }),
    );
    void listening.catch((error) => {
      if (!stopped) reportError(error);
    });
    return () => {
      stopped = true;
      void listening.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [areaRef]);
  return hovering
    ? readOnly
      ? "当前目录为只读，无法上传"
      : busy
        ? "正在提交上传任务，请稍候"
        : "松开以上传到当前目录"
    : null;
}
