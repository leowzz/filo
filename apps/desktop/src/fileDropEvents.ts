import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { TauriEvent, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview";

// The SDK's combined drag/drop disposer discards the four async unlisten
// results. Retain them here so directory changes can handle cleanup failures.
export async function listenFileDrop(handler: (event: DragDropEvent) => void) {
  const webview = getCurrentWebview();
  const listeners: UnlistenFn[] = [];
  const dispose = async () => {
    const results = await Promise.allSettled(
      listeners.splice(0).map((unlisten) => Promise.resolve().then(unlisten)),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  };
  type Positioned = { position: { x: number; y: number }; paths: string[] };
  try {
    for (const [event, type] of [
      [TauriEvent.DRAG_ENTER, "enter"],
      [TauriEvent.DRAG_OVER, "over"],
      [TauriEvent.DRAG_DROP, "drop"],
    ] as const) {
      listeners.push(
        await webview.listen<Positioned>(event, ({ payload }) => {
          handler({
            ...payload,
            type,
            position: new PhysicalPosition(payload.position),
          });
        }),
      );
    }
    listeners.push(
      await webview.listen(TauriEvent.DRAG_LEAVE, () =>
        handler({ type: "leave" }),
      ),
    );
    return dispose;
  } catch (error) {
    // Roll back partially registered listeners while preserving the setup error.
    await dispose().catch(() => {});
    throw error;
  }
}
