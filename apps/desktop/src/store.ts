import { create } from "zustand";

type Location = { volumeId: string; path: string };
type State = {
  page: "overview" | "browser" | "transfers" | "settings";
  history: Location[];
  index: number;
  showHidden: boolean;
  showDetails: boolean;
  navigate: (location: Location) => void;
  step: (delta: number) => void;
  setPage: (page: State["page"]) => void;
  toggleHidden: () => void;
  toggleDetails: () => void;
  resetVolumeRoot: (volumeId: string) => void;
  removeVolume: (volumeId: string) => void;
};
export const useBrowser = create<State>((set) => ({
  page: "overview",
  history: [],
  index: -1,
  showHidden: false,
  showDetails: false,
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
  toggleHidden: () => set((state) => ({ showHidden: !state.showHidden })),
  toggleDetails: () => set((state) => ({ showDetails: !state.showDetails })),
  resetVolumeRoot: (volumeId) =>
    set((state) => ({
      history: state.history.map((location) =>
        location.volumeId === volumeId ? { ...location, path: "" } : location,
      ),
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
      };
    }),
}));
