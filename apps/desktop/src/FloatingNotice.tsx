import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

function noticeContainer() {
  let container = document.getElementById("floating-notices");
  if (!container) {
    container = document.createElement("div");
    container.id = "floating-notices";
    document.body.append(container);
  }
  return container;
}

/** Notifications never participate in a file or transfer list's layout. */
export function FloatingNotice({
  children,
  duration = 4500,
  onDismiss,
}: {
  children: ReactNode;
  duration?: number;
  onDismiss?: () => void;
}) {
  const [visible, setVisible] = useState(true);
  const expire = useEffectEvent(() => {
    setVisible(false);
    onDismiss?.();
  });
  useEffect(() => {
    if (!duration) return;
    const timer = window.setTimeout(expire, duration);
    return () => window.clearTimeout(timer);
  }, [duration]);
  if (!visible) return null;
  return createPortal(
    <div className="floating-notice" role="status">
      <div className="floating-notice-content">{children}</div>
      <button
        className="icon-button"
        aria-label="关闭提示"
        onClick={() => {
          setVisible(false);
          onDismiss?.();
        }}
      >
        <X size={16} />
      </button>
    </div>,
    noticeContainer(),
  );
}
