import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type {
  Entry,
  Locator,
  Volume,
  TransferJob,
  TransferKind,
  DeleteMode,
  DeleteOutcome,
  Connection,
  S3Input,
} from "./types";

export const desktop = isTauri();
export const api = {
  connections: () =>
    desktop ? invoke<Connection[]>("list_connections") : Promise.resolve([]),
  saveS3: (volumeId: string | null, input: S3Input) =>
    invoke<Omit<Volume, "capabilities">>("save_s3_storage", {
      volumeId,
      input,
    }),
  testS3: (volumeId: string | null, input: S3Input) =>
    invoke<void>("test_s3_connection", { volumeId, input }),
  transferLocalFile: (
    remote: Locator,
    upload: boolean,
    onProgress: (job: TransferJob) => void,
  ) => {
    const channel = new Channel<TransferJob>();
    channel.onmessage = onProgress;
    return invoke<TransferJob | null>("transfer_local_file", {
      remote,
      upload,
      onProgress: channel,
    });
  },
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
  removeLocal: (volumeId: string) =>
    invoke<void>("remove_local_storage", { volumeId, confirmed: true }),
  transfers: () =>
    desktop ? invoke<TransferJob[]>("list_transfers") : Promise.resolve([]),
  cancelTransfer: (jobId: string) => invoke<void>("cancel_transfer", { jobId }),
  startTransfer: (
    kind: TransferKind,
    source: Locator,
    destination: Locator,
    onProgress: (job: TransferJob) => void,
  ) => {
    const channel = new Channel<TransferJob>();
    channel.onmessage = onProgress;
    return invoke<TransferJob>("start_transfer", {
      kind,
      source,
      destination,
      onProgress: channel,
    });
  },
  createDirectory: (parent: Locator, name: string) =>
    invoke<void>("create_directory", { parent, name }),
  rename: (source: Locator, name: string) =>
    invoke<void>("rename_entry", { source, name }),
  open: (locator: Locator) => invoke<void>("open_entry", { locator }),
  delete: (locator: Locator, mode: DeleteMode) =>
    invoke<DeleteOutcome>("delete_entry", { locator, mode, confirmed: true }),
};
export function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error)
    return String(error.message);
  return typeof error === "string" ? error : "操作失败，请重试";
}
