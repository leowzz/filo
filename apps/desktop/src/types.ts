export type Locator = {
  volume_id: string;
  logical_path: string;
  version_id: string | null;
};
export type S3Config = {
  endpoint: string | null;
  region: string;
  force_path_style: boolean;
};
export type Connection = {
  id: string;
  name: string;
  provider: "local_fs" | "s3";
  config: S3Config;
};
export type S3Input = {
  name: string;
  config: S3Config;
  bucket: string;
  prefix: string;
  read_only: boolean;
  credentials: {
    access_key_id: string;
    secret_access_key: string;
    session_token: string | null;
  } | null;
};
export type Capabilities = {
  hierarchy: "native_directory" | "virtual_prefix";
  rename: "atomic" | "copy_then_delete" | "unsupported";
  create_directory: boolean;
  delete: boolean;
  trash: boolean;
  native_open: boolean;
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
export type TransferSettings = {
  upload_kib_per_second: number;
  download_kib_per_second: number;
};
export type DeleteMode = "default" | "permanent";
export type DeleteOutcome = "trashed" | "permanently_deleted";
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
