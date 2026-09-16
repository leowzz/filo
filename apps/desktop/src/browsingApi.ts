import { invoke } from "@tauri-apps/api/core";
import type { Entry, Locator } from "./types";
export type Preview = {
  kind: "image" | "text" | "pdf";
  mime: string;
  content: string;
  truncated: boolean;
};
export type SearchState = {
  id: string;
  hits: { entry: Entry; line: number; snippet: string }[];
  scanned: number;
  skipped: number;
  errors: string[];
  done: boolean;
  cancelled: boolean;
  limited: boolean;
};
export type ObjectVersion = {
  key: string;
  version_id: string;
  latest: boolean;
  delete_marker: boolean;
  size: number;
  modified: string;
};
export type VersionPage = {
  versions: ObjectVersion[];
  next_key: string | null;
  next_version: string | null;
};
export type Properties = {
  etag: string;
  content_type: string;
  metadata: Record<string, string>;
};
export type S3Action =
  | { action: "bucket_status" | "properties" | "tags" | "acl" }
  | { action: "create_bucket"; name: string }
  | { action: "delete_bucket"; confirmation: string }
  | { action: "set_versioning"; enabled: boolean; confirmation: string }
  | {
      action: "versions";
      exact: boolean;
      key_marker: string | null;
      version_marker: string | null;
    }
  | {
      action: "delete_version" | "restore_version";
      version: string;
      confirmation: string;
    }
  | { action: "share"; expires: number; version: string | null }
  | {
      action: "set_metadata";
      etag: string;
      content_type: string;
      metadata: Record<string, string>;
    }
  | { action: "set_tags"; tags: Record<string, string> }
  | { action: "set_acl"; acl: string; confirmation: string };
export const browsingApi = {
  preview: (locator: Locator, thumbnail = false) =>
    invoke<Preview>("preview_entry", { locator, thumbnail }),
  stamp: (parent: Locator) => invoke<string>("directory_stamp", { parent }),
  search: (parent: Locator, query: string, showHidden: boolean) =>
    invoke<string>("start_content_search", { parent, query, showHidden }),
  searchStatus: (id: string, cancel = false) =>
    invoke<SearchState>("content_search_status", { id, cancel }),
  s3: <T>(locator: Locator, action: S3Action) =>
    invoke<T>("manage_s3", { locator, action }),
};
