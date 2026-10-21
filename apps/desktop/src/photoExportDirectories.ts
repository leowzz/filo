import type { PhotoDirectory } from "./photoApi";

const key = "filo.photo-export-directories";
export const exportDirectoryKey = (directory: PhotoDirectory) =>
  JSON.stringify([directory.locator.volume_id, directory.locator.logical_path]);
export type ExportDirectories = {
  directories: PhotoDirectory[];
  selectedPath: string | null;
};

export function loadExportDirectories(): ExportDirectories {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    const directories: PhotoDirectory[] = Array.isArray(saved?.directories)
      ? saved.directories.filter(
          (value: PhotoDirectory) =>
            typeof value?.path === "string" &&
            !!value.path &&
            typeof value.locator?.volume_id === "string" &&
            typeof value.locator?.logical_path === "string" &&
            value.locator?.version_id == null,
        )
      : [];
    const selected =
      directories.find(
        (value) => exportDirectoryKey(value) === saved?.selectedPath,
      ) ??
      directories.find((value) => value.path === saved?.selectedPath) ??
      directories[0];
    return {
      directories,
      selectedPath: selected ? exportDirectoryKey(selected) : null,
    };
  } catch {
    return { directories: [], selectedPath: null };
  }
}

export function saveExportDirectories(value: ExportDirectories) {
  localStorage.setItem(key, JSON.stringify(value));
}
