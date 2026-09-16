import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type MouseEvent,
  type KeyboardEvent,
} from "react";

type Modifiers = { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean };
type Point = { x: number; y: number };
type Rectangle = Point & { width: number; height: number };
type Selection = { scope: string; paths: Set<string>; anchor: string | null };

export function useFileSelection(scope: string, paths: string[]) {
  const [state, setState] = useState<Selection>({
    scope,
    paths: new Set(),
    anchor: null,
  });
  const [rectangle, setRectangle] = useState<Rectangle | null>(null);
  if (state.scope !== scope) {
    setState({ scope, paths: new Set(), anchor: null });
  }
  const areaRef = useRef<HTMLDivElement>(null);
  const stopDrag = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  const selectedPaths = new Set(
    paths.filter((path) => state.scope === scope && state.paths.has(path)),
  );
  const pathsKey = JSON.stringify(paths);

  useEffect(
    () => () => {
      stopDrag.current?.();
    },
    [scope, pathsKey],
  );

  function setSelection(path: string | null) {
    setState({
      scope,
      paths: new Set(path === null ? [] : [path]),
      anchor: path,
    });
  }

  function select(path: string, modifiers: Modifiers) {
    const additive = modifiers.metaKey || modifiers.ctrlKey;
    const anchor = state.scope === scope ? state.anchor : null;
    if (modifiers.shiftKey && anchor !== null && paths.includes(anchor)) {
      const start = paths.indexOf(anchor);
      const end = paths.indexOf(path);
      setState({
        scope,
        paths: new Set([
          ...(additive ? selectedPaths : []),
          ...paths.slice(Math.min(start, end), Math.max(start, end) + 1),
        ]),
        anchor,
      });
    } else {
      const next = additive ? new Set(selectedPaths) : new Set<string>();
      if (additive && next.has(path)) next.delete(path);
      else next.add(path);
      setState({ scope, paths: next, anchor: path });
    }
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    // A cancelled drag may not emit a click. Never swallow the next gesture.
    suppressClick.current = false;
    const area = event.currentTarget;
    const target = event.target;
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      event.pointerType === "touch" ||
      !(target instanceof Element) ||
      target.closest("button, input, a, thead, [role=menu]")
    )
      return;
    // Leave native scrollbar interaction alone.
    const bounds = area.getBoundingClientRect();
    if (
      event.clientX >= bounds.left + area.clientWidth ||
      event.clientY >= bounds.top + area.clientHeight
    )
      return;
    stopDrag.current?.();
    event.preventDefault();
    const row = target.closest<HTMLElement>("[data-entry-path]");
    (row ?? area).focus({ preventScroll: true });
    const pointerId = event.pointerId;
    const origin = { x: event.clientX, y: event.clientY };
    const start = {
      x: event.clientX - bounds.left + area.scrollLeft,
      y: event.clientY - bounds.top + area.scrollTop,
    };
    const base =
      event.metaKey || event.ctrlKey || event.shiftKey
        ? selectedPaths
        : new Set<string>();
    let pointer = origin;
    let dragging = false;
    let frame = 0;

    const update = () => {
      const rect = area.getBoundingClientRect();
      const end = {
        x:
          Math.max(0, Math.min(area.clientWidth, pointer.x - rect.left)) +
          area.scrollLeft,
        y:
          Math.max(0, Math.min(area.clientHeight, pointer.y - rect.top)) +
          area.scrollTop,
      };
      const box = {
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
      };
      const next = new Set(base);
      let first: string | null = null;
      for (const item of area.querySelectorAll<HTMLElement>(
        "[data-entry-path]",
      )) {
        const rowRect = item.getBoundingClientRect();
        const left = rowRect.left - rect.left + area.scrollLeft;
        const top = rowRect.top - rect.top + area.scrollTop;
        if (
          left <= box.x + box.width &&
          left + rowRect.width >= box.x &&
          top <= box.y + box.height &&
          top + rowRect.height >= box.y
        ) {
          const path = item.dataset.entryPath!;
          next.add(path);
          first ??= path;
        }
      }
      setRectangle(box);
      setState({ scope, paths: next, anchor: row?.dataset.entryPath ?? first });
    };
    const tick = () => {
      const rect = area.getBoundingClientRect();
      const headerHeight =
        area.querySelector("thead")?.getBoundingClientRect().height ?? 0;
      const top = rect.top + headerHeight + 24;
      const bottom = rect.top + area.clientHeight - 24;
      const delta =
        pointer.y < top
          ? -Math.min(18, (top - pointer.y) / 3)
          : pointer.y > bottom
            ? Math.min(18, (pointer.y - bottom) / 3)
            : 0;
      const previous = area.scrollTop;
      area.scrollTop += delta;
      if (area.scrollTop !== previous) update();
      frame = requestAnimationFrame(tick);
    };
    const move = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      pointer = { x: moveEvent.clientX, y: moveEvent.clientY };
      if (
        !dragging &&
        Math.hypot(pointer.x - origin.x, pointer.y - origin.y) < 4
      )
        return;
      if (!dragging) {
        dragging = true;
        suppressClick.current = true;
        area.setPointerCapture(pointerId);
        frame = requestAnimationFrame(tick);
      }
      moveEvent.preventDefault();
      update();
    };
    const scroll = () => {
      if (dragging) update();
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", stop);
      area.removeEventListener("lostpointercapture", stop);
      area.removeEventListener("scroll", scroll);
      if (area.hasPointerCapture(pointerId))
        area.releasePointerCapture(pointerId);
      setRectangle(null);
      stopDrag.current = null;
    };
    const end = (endEvent: globalThis.PointerEvent) => {
      if (endEvent.pointerId === pointerId) stop();
    };
    stopDrag.current = stop;
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", stop);
    area.addEventListener("lostpointercapture", stop);
    area.addEventListener("scroll", scroll);
  }

  function onClickCapture(event: MouseEvent<HTMLDivElement>) {
    if (suppressClick.current) {
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    } else if (
      event.target instanceof Element &&
      !event.target.closest("[data-entry-path], thead, button, input, a")
    ) {
      if (!event.metaKey && !event.ctrlKey && !event.shiftKey)
        setSelection(null);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (
      event.target instanceof Element &&
      event.target.closest("button, input, a")
    )
      return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setState({ scope, paths: new Set(paths), anchor: paths[0] ?? null });
    } else if (event.key === "Escape") {
      stopDrag.current?.();
      setSelection(null);
    } else if (event.key === " " && event.target instanceof HTMLElement) {
      const path = event.target.dataset.entryPath;
      if (path !== undefined) {
        event.preventDefault();
        select(path, event);
      }
    }
  }

  return {
    areaRef,
    rectangle,
    selectedPaths,
    setSelection,
    select,
    onPointerDown,
    onClickCapture,
    onKeyDown,
  };
}
