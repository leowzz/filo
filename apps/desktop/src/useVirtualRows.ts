import { useEffect, useState, type RefObject } from "react";
export const ROW_HEIGHT = 29;
export const HEADER_HEIGHT = 30;

export function directoryHeaderHeight(area: HTMLElement | null) {
  return (
    area?.querySelector("thead")?.getBoundingClientRect().height ??
    HEADER_HEIGHT
  );
}

export function useVirtualRows(
  ref: RefObject<HTMLDivElement | null>,
  count: number,
) {
  const [viewport, setViewport] = useState({
    top: 0,
    height: 600,
    header: HEADER_HEIGHT,
  });
  useEffect(() => {
    const area = ref.current;
    if (!area) return;
    const update = () => {
      const next = {
        top: area.scrollTop,
        height: area.clientHeight,
        header: directoryHeaderHeight(area),
      };
      setViewport((current) =>
        current.top === next.top &&
        current.height === next.height &&
        current.header === next.header
          ? current
          : next,
      );
    };
    const resize = new ResizeObserver(update);
    resize.observe(area);
    const header = area.querySelector("thead");
    if (header) resize.observe(header);
    area.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      resize.disconnect();
      area.removeEventListener("scroll", update);
    };
  }, [ref, count]);
  const start = Math.min(
    Math.max(0, count - 1),
    Math.max(0, Math.floor((viewport.top - viewport.header) / ROW_HEIGHT) - 8),
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
