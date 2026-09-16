export type Locator = {
  volume_id: string;
  logical_path: string;
  version_id: string | null;
};
export type Capabilities = {
  hierarchy: "native_directory" | "virtual_prefix";
  rename: "atomic" | "copy_then_delete" | "unsupported";
  create_directory: boolean;
  delete: boolean;
  native_copy: boolean;
};
export type Volume = {
  id: string;
  connection_id: string;
  name: string;
  read_only: boolean;
  root:
    | { type: "local"; root_path: string }
    | { type: "s3"; bucket: string; prefix: string };
  capabilities: Capabilities;
};
export type Entry = {
  locator: Locator;
  name: string;
  kind: "file" | "directory" | "virtual_prefix" | "symlink";
  size: number | null;
  modified_at: string | null;
};
export const isDirectory = (entry: Entry) =>
  entry.kind === "directory" || entry.kind === "virtual_prefix";

export type TransferKind = "copy" | "move";
export type TransferJob = {
  id: string;
  kind: TransferKind;
  source: Locator;
  destination: Locator;
  state:
    | "queued"
    | "running"
    | "verifying"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  bytes_total: number | null;
  bytes_transferred: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};
export const activeTransfer = (job: TransferJob) =>
  ["queued", "running", "verifying"].includes(job.state);
