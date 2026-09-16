import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type {
  Entry,
  EntryPage,
  ListOptions,
  ConflictPolicy,
  Locator,
  Volume,
  TransferJob,
  TransferKind,
  DeleteMode,
  DeleteOutcome,
  Connection,
  S3Input,
  RemoteInput,
  TransferSettings,
} from "./types";

export const desktop = isTauri();
export const api = {
  transferSettings: () =>
    desktop
      ? invoke<TransferSettings>("get_transfer_settings")
      : Promise.resolve({
          upload_kib_per_second: 0,
          download_kib_per_second: 0,
        }),
  saveTransferSettings: (settings: TransferSettings) =>
    invoke<TransferSettings>("save_transfer_settings", { settings }),
  connections: () =>
    desktop ? invoke<Connection[]>("list_connections") : Promise.resolve([]),
  saveS3: (volumeId: string | null, input: S3Input) =>
    invoke<Omit<Volume, "capabilities">>("save_s3_storage", {
      volumeId,
      input,
    }),
  testS3: async (volumeId: string | null, input: S3Input) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        invoke<void>("test_s3_connection", { volumeId, input }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error("连接测试超时（2 秒），请检查网络和服务地址后重试"),
              ),
            2000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  },
  saveRemote: (volumeId: string | null, input: RemoteInput) =>
    invoke<Omit<Volume, "capabilities">>("save_remote_storage", {
      volumeId,
      input,
    }),
  testRemote: async (volumeId: string | null, input: RemoteInput) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        invoke<void>("test_remote_connection", { volumeId, input }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error("连接测试超时，请检查网络、服务地址和认证信息后重试"),
              ),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  },
  transferLocalFile: (
    remote: Locator,
    upload: boolean,
    onProgress: (job: TransferJob) => void,
    conflictPolicy: ConflictPolicy = "reject",
  ) => {
    const channel = new Channel<TransferJob>();
    channel.onmessage = onProgress;
    return invoke<{ jobs: TransferJob[]; failures: string[] } | null>(
      "transfer_local_file",
      {
        remote,
        upload,
        conflictPolicy,
        onProgress: channel,
      },
    );
  },
  uploadDroppedFiles: (
    remote: Locator,
    paths: string[],
    onProgress: (job: TransferJob) => void,
    conflictPolicy: ConflictPolicy,
  ) => {
    const channel = new Channel<TransferJob>();
    channel.onmessage = onProgress;
    return invoke<{ jobs: TransferJob[]; failures: string[] }>(
      "upload_dropped_files",
      {
        remote,
        paths,
        conflictPolicy,
        onProgress: channel,
      },
    );
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
  entriesPage: (parent: Locator, options: ListOptions, cursor: string | null) =>
    invoke<EntryPage>("list_entries_page", {
      parent,
      options,
      cursor,
      limit: 200,
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
    conflictPolicy: ConflictPolicy = "reject",
  ) => {
    const channel = new Channel<TransferJob>();
    channel.onmessage = onProgress;
    return invoke<TransferJob>("start_transfer", {
      kind,
      conflictPolicy,
      source,
      destination,
      onProgress: channel,
    });
  },
  createDirectory: (parent: Locator, name: string) =>
    invoke<void>("create_directory", { parent, name }),
  rename: (
    source: Locator,
    name: string,
    conflictPolicy: ConflictPolicy = "reject",
  ) =>
    invoke<TransferJob["state"]>("rename_entry", {
      source,
      name,
      conflictPolicy,
    }),
  open: (locator: Locator) => invoke<void>("open_entry", { locator }),
  delete: (locator: Locator, mode: DeleteMode, recursive = false) =>
    invoke<DeleteOutcome>("delete_entry", {
      locator,
      mode,
      confirmed: true,
      recursive,
    }),
};
export function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error)
    return String(error.message);
  return typeof error === "string" ? error : "操作失败，请重试";
}
