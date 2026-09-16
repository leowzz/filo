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
};
export const useBrowser = create<State>((set) => ({
  page: "overview",
  history: [],
  index: -1,
  showHidden: false,
  showDetails: true,
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
}));
