import { create } from "zustand";

export type FolderFavorite = { volumeId: string; path: string; name: string };
type FolderLocation = Pick<FolderFavorite, "volumeId" | "path">;
const storageKey = "filo.folder-favorites";

export function sameFolder(left: FolderLocation, right: FolderLocation) {
  return left.volumeId === right.volumeId && left.path === right.path;
}

function readFavorites(): FolderFavorite[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    if (!Array.isArray(saved)) return [];
    const favorites: FolderFavorite[] = [];
    for (const item of saved) {
      if (
        item &&
        typeof item.volumeId === "string" &&
        item.volumeId &&
        typeof item.path === "string" &&
        typeof item.name === "string" &&
        item.name &&
        !favorites.some((favorite) => sameFolder(favorite, item))
      ) {
        favorites.push({
          volumeId: item.volumeId,
          path: item.path,
          name: item.name,
        });
      }
    }
    return favorites;
  } catch {
    return [];
  }
}

function save(favorites: FolderFavorite[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(favorites));
  } catch {
    // Keep shortcuts usable for this session if local storage is unavailable.
  }
  return { favorites };
}

export const useFolderFavorites = create<{
  favorites: FolderFavorite[];
  toggle: (folder: FolderFavorite) => void;
  remove: (folder: FolderLocation) => void;
  removeVolume: (volumeId: string) => void;
  move: (folder: FolderLocation, before: FolderLocation | null) => void;
}>((set) => ({
  favorites: readFavorites(),
  toggle: (folder) =>
    set(({ favorites }) =>
      save(
        favorites.some((item) => sameFolder(item, folder))
          ? favorites.filter((item) => !sameFolder(item, folder))
          : [...favorites, { ...folder }],
      ),
    ),
  remove: (folder) =>
    set(({ favorites }) =>
      save(favorites.filter((item) => !sameFolder(item, folder))),
    ),
  removeVolume: (volumeId) =>
    set(({ favorites }) =>
      save(favorites.filter((item) => item.volumeId !== volumeId)),
    ),
  move: (folder, before) =>
    set((state) => {
      const source = state.favorites.find((item) => sameFolder(item, folder));
      if (!source || (before && sameFolder(folder, before))) return state;
      const favorites = state.favorites.filter(
        (item) => !sameFolder(item, folder),
      );
      const index = before
        ? favorites.findIndex((item) => sameFolder(item, before))
        : favorites.length;
      if (index < 0) return state;
      favorites.splice(index, 0, source);
      return save(favorites);
    }),
}));
