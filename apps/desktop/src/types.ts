export type Locator = {
  volume_id: string;
  logical_path: string;
  version_id: string | null;
};
export type S3Provider = "generic" | "rustfs" | "tos" | "oss";
export type RemoteProtocol = "ftp" | "ftps" | "sftp" | "smb";
export type RemoteAuthMethod = "password" | "private_key";
export type SftpPrivateKey = {
  path: string;
  private_key: string;
};
export type SftpHostKeyInspection = {
  status: "trusted" | "unknown" | "changed";
  known_hosts: string;
  fingerprint: string;
  algorithm: string;
};
export type S3Config = {
  provider?: S3Provider | null;
  endpoint: string | null;
  region: string;
  force_path_style: boolean;
};
/** Non-secret connection settings for FTP(S), SFTP and SMB. */
export type RemoteConfig = {
  protocol: RemoteProtocol;
  host: string;
  port: number;
  share: string;
  known_hosts: string;
};
export type RemoteCredentials = {
  username: string;
  password: string;
  private_key: string;
  passphrase: string;
  domain: string;
};
export type Connection = {
  id: string;
  name: string;
  provider: "local_fs" | "s3" | "remote";
  // Local connections return `{}`. The intersection keeps existing S3
  // helpers strongly typed while exposing remote fields to its dialog.
  config: S3Config & Partial<RemoteConfig>;
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
export type RemoteInput = {
  name: string;
  protocol: RemoteProtocol;
  host: string;
  port: number;
  path: string;
  share: string;
  known_hosts: string;
  read_only: boolean;
  credentials: RemoteCredentials | null;
};
export type Capabilities = {
  hierarchy: "native_directory" | "virtual_prefix";
  rename: "atomic" | "copy_then_delete" | "unsupported";
  create_directory: boolean;
  /** False when the provider cannot accept writes. */
  write?: boolean;
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
    | { type: "s3"; bucket: string; prefix: string }
    | { type: "remote"; path: string };
  capabilities: Capabilities;
};
export type Entry = {
  etag?: string | null;
  locator: Locator;
  name: string;
  kind: "file" | "directory" | "virtual_prefix" | "symlink";
  size: number | null;
  modified_at: string | null;
};
export const isDirectory = (entry: Entry) =>
  entry.kind === "directory" || entry.kind === "virtual_prefix";

export type ConflictPolicy = "reject" | "overwrite" | "skip" | "rename";
export type EntrySort = "name" | "size" | "modified";
export type ListOptions = {
  search: string;
  show_hidden: boolean;
  folders_only: boolean;
  sort: EntrySort;
};
export type EntryPage = {
  entries: Entry[];
  total: number;
  next_cursor: string | null;
};
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
    | "interrupted"
    | "skipped";
  bytes_total: number | null;
  bytes_transferred: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};
export const activeTransfer = (job: TransferJob) =>
  ["queued", "running", "verifying"].includes(job.state);
