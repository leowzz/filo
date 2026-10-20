import type { Locator, Volume } from "./types";

export function storagePath(volume: Volume, locator: Locator): string {
  const path = locator.logical_path.replace(/^\/+/, "");
  if (volume.root.type === "local") {
    const root = volume.root.root_path;
    if (!path) return root;
    const separator = /^[A-Za-z]:\\|^\\\\/.test(root) ? "\\" : "/";
    const base = root.replace(separator === "\\" ? /[\\/]+$/ : /\/+$/, "");
    return `${base}${separator}${path.split("/").join(separator)}`;
  }
  if (volume.root.type === "s3") {
    const key = [volume.root.prefix.replace(/^\/+|\/+$/g, ""), path]
      .filter(Boolean)
      .join("/");
    return `s3://${volume.root.bucket}/${key}`;
  }
  const root = volume.root.path;
  if (!path) return root || ".";
  return root ? `${root.replace(/\/+$/, "")}/${path}` : path;
}

export function storageLink(locator: Locator): string {
  const path = locator.logical_path
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const version =
    locator.version_id === null
      ? ""
      : `?version_id=${encodeURIComponent(locator.version_id)}`;
  return `filo://storage/${encodeURIComponent(locator.volume_id)}/${path}${version}`;
}
