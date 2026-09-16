import { useEffect, useState, type RefObject } from "react";
export const ROW_HEIGHT = 29;
export const HEADER_HEIGHT = 30;

export function useVirtualRows(
  ref: RefObject<HTMLDivElement | null>,
  count: number,
) {
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  useEffect(() => {
    const area = ref.current;
    if (!area) return;
    const update = () =>
      setViewport({ top: area.scrollTop, height: area.clientHeight });
    const resize = new ResizeObserver(update);
    resize.observe(area);
    area.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      resize.disconnect();
      area.removeEventListener("scroll", update);
    };
  }, [ref]);
  const start = Math.min(
    Math.max(0, count - 1),
    Math.max(0, Math.floor((viewport.top - HEADER_HEIGHT) / ROW_HEIGHT) - 8),
  );
  const end = Math.min(
    count,
    start + Math.ceil(viewport.height / ROW_HEIGHT) + 16,
  );
  return {
    start,
    end,
    before: start * ROW_HEIGHT,
    after: (count - end) * ROW_HEIGHT,
  };
}
