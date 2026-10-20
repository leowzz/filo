import { Channel } from "@tauri-apps/api/core";
import { credentialInvoke as invoke } from "./credentialAccess";
import { desktop } from "./api";
import type { Locator } from "./types";

export type PhotoFlag = "none" | "pick" | "reject";
export type PhotoSort =
  "name_asc" | "name_desc" | "capture_asc" | "capture_desc";
export type PhotoFile = {
  id: string;
  kind: "raw" | "jpg" | "xmp" | "acr";
  original_name: string;
  path: string;
  sha256: string;
  size: number;
  verified: boolean;
  error: string | null;
};
export type Photo = {
  id: string;
  archive_id: string;
  original_path: string;
  capture_date: string | null;
  capture_time?: string | null;
  capture_time_loaded?: boolean;
  issues: string[];
  files: PhotoFile[];
  rating: number;
  flag: PhotoFlag;
  excluded: boolean;
  revision: number;
  xmp_hash: string | null;
  xmp_synced_revision: number | null;
};
export type PhotoPosition = {
  current: string | null;
  sort?: PhotoSort;
  filter: string;
  minimum_rating: number;
  auto_advance: boolean;
  raw_only?: boolean;
};
export type PhotoSession = {
  id: string;
  archive_id: string;
  name: string;
  card_name: string;
  created_at: string;
  source: Locator | null;
  directory?: Locator | null;
  photo_ids: string[];
  revision: number;
  synced_revision: number;
  nas_hash: string | null;
  sync_error: string | null;
  handed_off: boolean;
  position: PhotoPosition;
  undo: unknown[];
  layout: PhotoPlan["layout"];
  keep_hierarchy: boolean;
};
export type PhotoArchive = { id: string; jpg: Locator; raw: Locator };
export type PhotoPlan = {
  name: string;
  card_name: string;
  source: Locator;
  jpg: Locator;
  raw: Locator;
  layout: "date" | "batch" | "original";
  keep_hierarchy: boolean;
  date_override: string | null;
};
export type PhotoCatalog = {
  photos: Photo[];
  sessions: PhotoSession[];
  archives: PhotoArchive[];
  preset: PhotoPlan | null;
};
export type PhotoDirectory = { locator: Locator; path: string };
export type PhotoProgress = {
  session_id: string;
  completed: number;
  total: number;
  path: string;
};
export type PhotoReviewInput = {
  name: string;
  jpg: Locator;
  raw: Locator | null;
  directory: boolean;
  raw_only?: boolean;
};
export type PhotoReviewProgress = {
  stage: "connecting" | "listing" | "pairing" | "saving";
  found: number;
  completed: number;
  total: number | null;
  path: string;
};
export type PhotoPreview = {
  mime: string;
  content: string;
  width: number;
  height: number;
  embedded: boolean;
};
export type PhotoHandoff = {
  directories: string[];
  failures: string[];
  jpg_only: number;
};

export const pickPhotoDirectory = (readOnly = false, title?: string) =>
  invoke<PhotoDirectory | null>("photo_pick_directory", {
    readOnly,
    title: title ?? null,
  });

export const photoApi = {
  active: () =>
    desktop
      ? invoke<boolean>("photo_has_active_imports")
      : Promise.resolve(false),
  paths: (sessionId: string) =>
    invoke<{ source_root: string | null; targets: Record<string, string> }>(
      "photo_paths",
      { sessionId },
    ),
  catalog: () =>
    desktop
      ? invoke<PhotoCatalog>("photo_catalog")
      : Promise.resolve({
          photos: [],
          sessions: [],
          archives: [],
          preset: null,
        } as PhotoCatalog),
  plan: (input: PhotoPlan) => invoke<PhotoSession>("photo_plan", { input }),
  import: (
    sessionId: string,
    onProgress: (progress: PhotoProgress) => void,
  ) => {
    const channel = new Channel<PhotoProgress>();
    channel.onmessage = onProgress;
    return invoke<PhotoSession>("photo_import", {
      sessionId,
      onProgress: channel,
    });
  },
  cancel: (sessionId: string) =>
    invoke<void>("photo_cancel_import", { sessionId }),
  rebind: (sessionId: string, source: Locator) =>
    invoke<void>("photo_rebind_source", { sessionId, source }),
  exclude: (sessionId: string, photoId: string, excluded: boolean) =>
    invoke<void>("photo_exclude", { sessionId, photoId, excluded }),
  resolveDate: (sessionId: string, date: string) =>
    invoke<void>("photo_resolve_date", { sessionId, date }),
  sync: (sessionId: string) => invoke<void>("photo_sync", { sessionId }),
  restore: (jpg: Locator, raw: Locator) =>
    invoke<number>("photo_restore", { jpg, raw }),
};

export const reviewApi = {
  scan: (
    requestId: string,
    input: PhotoReviewInput,
    onProgress: (progress: PhotoReviewProgress) => void,
  ) => {
    const channel = new Channel<PhotoReviewProgress>();
    channel.onmessage = onProgress;
    return invoke<PhotoSession>("review_scan", {
      requestId,
      input,
      onProgress: channel,
    });
  },
  cancelScan: (requestId: string) =>
    invoke<void>("review_cancel_scan", { requestId }),
  captureTimes: (
    requestId: string,
    sessionId: string,
    onProgress: (progress: PhotoReviewProgress) => void,
  ) => {
    const channel = new Channel<PhotoReviewProgress>();
    channel.onmessage = onProgress;
    return invoke<{ id: string; capture_time: string | null }[]>(
      "review_load_capture_times",
      { requestId, sessionId, onProgress: channel },
    );
  },
  openDirectory: (root: Locator) =>
    invoke<PhotoSession>("review_open_directory", { root }),
  catalog: () =>
    desktop
      ? invoke<PhotoCatalog>("review_catalog")
      : Promise.resolve({
          photos: [],
          sessions: [],
          archives: [],
          preset: null,
        } as PhotoCatalog),
  openLibrary: (name: string, jpg: Locator, raw: Locator | null) =>
    invoke<PhotoSession>("review_open", { name, jpg, raw }),
  sync: (sessionId: string) => invoke<void>("review_sync", { sessionId }),
  restore: (jpg: Locator, raw: Locator) =>
    invoke<number>("review_restore", { jpg, raw }),
  mark: (sessionId: string, photoId: string, rating: number, flag: PhotoFlag) =>
    invoke<Photo>("review_mark", { sessionId, photoId, rating, flag }),
  undo: (sessionId: string) =>
    invoke<Photo | null>("review_undo", { sessionId }),
  position: (sessionId: string, position: PhotoPosition) =>
    invoke<void>("review_save_position", { sessionId, position }),
  preview: (
    photoId: string,
    original = false,
    thumbnail = false,
    rawOnly = false,
  ) =>
    invoke<PhotoPreview>("review_preview", {
      photoId,
      original,
      thumbnail,
      rawOnly,
    }),
  prepare: (sessionId: string) =>
    invoke<PhotoHandoff>("review_prepare_lrc", { sessionId }),
  open: (sessionId: string, directory: string) =>
    invoke<void>("review_open_raw_directory", { sessionId, directory }),
  launch: () => invoke<void>("review_launch_lrc"),
};
