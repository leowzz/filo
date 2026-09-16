import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Entry, Locator, Volume } from "./types";

export const desktop = isTauri();
export const api = {
  volumes: () =>
    desktop ? invoke<Volume[]>("list_volumes") : Promise.resolve([]),
  addLocal: (readOnly: boolean) =>
    invoke<Volume | null>("create_local_storage", { readOnly }),
  updateLocal: (
    volumeId: string,
    name: string,
    readOnly: boolean,
    changeDirectory: boolean,
  ) =>
    invoke<Omit<Volume, "capabilities"> | null>("update_local_storage", {
      volumeId,
      name,
      readOnly,
      changeDirectory,
    }),
  entries: (parent: Locator) => invoke<Entry[]>("list_entries", { parent }),
  createDirectory: (parent: Locator, name: string) =>
    invoke<void>("create_directory", { parent, name }),
  rename: (source: Locator, name: string) =>
    invoke<void>("rename_entry", { source, name }),
  delete: (locator: Locator) =>
    invoke<void>("delete_entry", { locator, confirmed: true }),
};
export function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error)
    return String(error.message);
  return typeof error === "string" ? error : "操作失败，请重试";
}
