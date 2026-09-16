import type { Entry, Locator, Volume } from "./types.ts";

export type ClipboardMode = "copy" | "cut";
export type FileClipboard = { mode: ClipboardMode; entries: Entry[] };

/** Keep the current selection identity stable while a paste is being retried. */
export function clipboardSignature(clipboard: FileClipboard) {
  return `${clipboard.mode}:${clipboard.entries
    .map((entry) => `${entry.locator.volume_id}:${entry.locator.logical_path}`)
    .join("\n")}`;
}

export function destinationFor(entry: Entry, parent: Locator): Locator {
  return {
    ...parent,
    logical_path: parent.logical_path
      ? `${parent.logical_path}/${entry.name}`
      : entry.name,
  };
}

export function isInsideSource(entry: Entry, destination: Locator) {
  if (entry.locator.volume_id !== destination.volume_id) return false;
  const source = entry.locator.logical_path.replace(/^\/+|\/+$/g, "");
  const target = destination.logical_path.replace(/^\/+|\/+$/g, "");
  return Boolean(
    source && (target === source || target.startsWith(`${source}/`)),
  );
}

/**
 * The Rust service repeats this check, but doing it before queueing avoids a
 * confusing task that can never succeed and gives keyboard paste a useful
 * status message.
 */
export function pasteBlockReason(
  clipboard: FileClipboard,
  destination: Locator,
  volume?: Volume,
) {
  if (!volume || volume.read_only) return "当前目录为只读，无法粘贴";
  const capabilities = volume.capabilities as typeof volume.capabilities & {
    write?: boolean;
  };
  if (capabilities.write === false) return "当前目录不支持写入，无法粘贴";
  if (clipboard.entries.some((entry) => entry.kind === "symlink"))
    return "符号链接不能粘贴";
  if (
    clipboard.entries.some(
      (entry) =>
        entry.kind === "directory" && isInsideSource(entry, destination),
    )
  )
    return "不能将文件夹粘贴到自身或其子目录";
  return null;
}

export function canWriteVolume(volume?: Volume) {
  if (!volume || volume.read_only) return false;
  const capabilities = volume.capabilities as typeof volume.capabilities & {
    write?: boolean;
  };
  return capabilities.write !== false;
}

/** Moving a selection needs the source deletion capability; destination write
 * access is checked separately when the paste is submitted. */
export function canCutVolume(volume?: Volume) {
  return !!volume && !volume.read_only && volume.capabilities.delete;
}
