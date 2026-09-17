import { create } from "zustand";
import type { ClipboardMode, FileClipboard } from "./fileClipboard";
import type { Entry, EntrySort } from "./types";

type Location = { volumeId: string; path: string };
type BrowserPreferences = {
  showHidden: boolean;
  showDetails: boolean;
  useGroups: boolean;
  sort: EntrySort;
};

const preferencesKey = "filo.browser-preferences";
const defaultPreferences: BrowserPreferences = {
  showHidden: false,
  showDetails: false,
  useGroups: false,
  sort: "name",
};

function readPreferences(): BrowserPreferences {
  if (typeof localStorage === "undefined") return defaultPreferences;
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(preferencesKey) ?? "null",
    );
    if (!value || typeof value !== "object") return defaultPreferences;
    const input = value as Partial<BrowserPreferences>;
    return {
      showHidden:
        typeof input.showHidden === "boolean"
          ? input.showHidden
          : defaultPreferences.showHidden,
      showDetails:
        typeof input.showDetails === "boolean"
          ? input.showDetails
          : defaultPreferences.showDetails,
      useGroups: input.useGroups === true,
      sort:
        input.sort === "name" ||
        input.sort === "size" ||
        input.sort === "modified"
          ? input.sort
          : defaultPreferences.sort,
    };
  } catch {
    return defaultPreferences;
  }
}

function writePreferences(value: BrowserPreferences) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(preferencesKey, JSON.stringify(value));
  } catch {
    // Preferences are a convenience. A restricted storage context should not
    // make the browser unusable.
  }
}

const initialPreferences = readPreferences();

type State = {
  page: "overview" | "browser" | "transfers" | "settings";
  history: Location[];
  index: number;
  showHidden: boolean;
  showDetails: boolean;
  useGroups: boolean;
  sort: EntrySort;
  clipboard: FileClipboard | null;
  navigate: (location: Location) => void;
  step: (delta: number) => void;
  setPage: (page: State["page"]) => void;
  toggleHidden: () => void;
  toggleDetails: () => void;
  toggleGroups: () => void;
  setSort: (sort: EntrySort) => void;
  setClipboard: (entries: Entry[], mode: ClipboardMode) => void;
  clearClipboard: () => void;
  resetVolumeRoot: (volumeId: string) => void;
  removeVolume: (volumeId: string) => void;
};
export const useBrowser = create<State>((set) => ({
  page: "overview",
  history: [],
  index: -1,
  showHidden: initialPreferences.showHidden,
  showDetails: initialPreferences.showDetails,
  useGroups: initialPreferences.useGroups,
  sort: initialPreferences.sort,
  clipboard: null,
  navigate: (location) =>
    set((state) => ({
      page: "browser",
      history: [...state.history.slice(0, state.index + 1), location],
      index: state.index + 1,
    })),
  step: (delta) =>
    set((state) => ({
      page: "browser",
      index: Math.max(
        0,
        Math.min(state.history.length - 1, state.index + delta),
      ),
    })),
  setPage: (page) => set({ page }),
  toggleHidden: () =>
    set((state) => {
      const next = { ...state, showHidden: !state.showHidden };
      writePreferences({
        showHidden: next.showHidden,
        showDetails: next.showDetails,
        sort: next.sort,
        useGroups: next.useGroups,
      });
      return { showHidden: next.showHidden };
    }),
  toggleDetails: () =>
    set((state) => {
      const next = { ...state, showDetails: !state.showDetails };
      writePreferences({
        showHidden: next.showHidden,
        showDetails: next.showDetails,
        sort: next.sort,
        useGroups: next.useGroups,
      });
      return { showDetails: next.showDetails };
    }),
  setSort: (sort) =>
    set((state) => {
      writePreferences({
        showHidden: state.showHidden,
        showDetails: state.showDetails,
        sort,
        useGroups: state.useGroups,
      });
      return { sort };
    }),
  toggleGroups: () =>
    set((state) => {
      const useGroups = !state.useGroups;
      writePreferences({
        showHidden: state.showHidden,
        showDetails: state.showDetails,
        sort: state.sort,
        useGroups,
      });
      return { useGroups };
    }),
  setClipboard: (entries, mode) =>
    set({
      clipboard:
        entries.length > 0
          ? {
              mode,
              entries: [...entries],
            }
          : null,
    }),
  clearClipboard: () => set({ clipboard: null }),
  resetVolumeRoot: (volumeId) =>
    set((state) => ({
      history: state.history.map((location) =>
        location.volumeId === volumeId ? { ...location, path: "" } : location,
      ),
      clipboard: state.clipboard?.entries.some(
        (entry) => entry.locator.volume_id === volumeId,
      )
        ? null
        : state.clipboard,
    })),
  removeVolume: (volumeId) =>
    set((state) => {
      const currentRemoved = state.history[state.index]?.volumeId === volumeId;
      const history = state.history.filter(
        (location) => location.volumeId !== volumeId,
      );
      const before = state.history
        .slice(0, state.index + 1)
        .filter((location) => location.volumeId !== volumeId).length;
      return {
        history,
        index: history.length ? Math.max(0, before - 1) : -1,
        page:
          currentRemoved && state.page === "browser" ? "overview" : state.page,
        clipboard: state.clipboard?.entries.some(
          (entry) => entry.locator.volume_id === volumeId,
        )
          ? null
          : state.clipboard,
      };
    }),
}));
