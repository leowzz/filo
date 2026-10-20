// Layout writes during ResizeObserver delivery can trigger another resize in
// the same frame. Coalesce notifications and update in the next animation frame.
export function observeResize(targets: Element[], update: () => void) {
  let frame: number | null = null;
  const observer = new ResizeObserver(() => {
    frame ??= requestAnimationFrame(() => {
      frame = null;
      update();
    });
  });
  for (const target of targets) observer.observe(target);
  return () => {
    observer.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
}
