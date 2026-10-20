import type { Photo, PhotoFlag, PhotoSort } from "./photoApi";

const photoNameOrder = new Intl.Collator(undefined, { numeric: true }).compare;
export function sortPhotos(photos: Photo[], sort: PhotoSort) {
  const descending = sort.endsWith("desc") ? -1 : 1;
  return [...photos].sort((a, b) => {
    const name =
      photoNameOrder(
        a.original_path.split("/").at(-1) ?? "",
        b.original_path.split("/").at(-1) ?? "",
      ) || photoNameOrder(a.original_path, b.original_path);
    if (sort.startsWith("name")) return name * descending;
    if (!a.capture_time || !b.capture_time)
      return a.capture_time ? -1 : b.capture_time ? 1 : name;
    return (
      (a.capture_time < b.capture_time
        ? -1
        : a.capture_time > b.capture_time
          ? 1
          : 0) * descending || name
    );
  });
}
export const matchesPhoto = (photo: Photo, filter: string, minimum: number) =>
  photo.rating >= minimum && (filter === "all" || photo.flag === filter);
export const isReviewConflict = (error: unknown) =>
  !!error &&
  typeof error === "object" &&
  "code" in error &&
  error.code === "conflict";

export type PhotoFeedback = {
  id: number;
  photoId: string;
  kind: "up" | "down" | "flag" | "undo";
  rating: number;
  flag: PhotoFlag;
  from: number;
};
type Mark = { rating: number; flag: PhotoFlag };
export const hasRaw = (photo: Photo) =>
  photo.files.some((f) => f.kind === "raw");
type Dependencies = {
  save: (id: string, mark: Mark) => Promise<Photo>;
  undo: () => Promise<Photo | null>;
  changed: () => void;
  saved: (photo: Photo) => void;
  feedback: (feedback: PhotoFeedback | null) => void;
  error: (
    message: string,
    retry: (() => void) | null,
    reload?: boolean,
  ) => void;
};

// Requests are serialized and carry immutable photo IDs and complete desired marks.
// Late failures can only roll back the latest unsaved state of their own photo.
export class PhotoReviewController {
  photos: Photo[];
  current: string | null;
  pending = 0;
  rawOnly: boolean;
  private committed = new Map<string, Photo>();
  private latest = new Map<string, number>();
  private sequence = 0;
  private navigation = 0;
  private queue = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  constructor(
    photos: Photo[],
    current: string | null,
    private deps: Dependencies,
    rawOnly = false,
  ) {
    this.photos = photos;
    this.rawOnly = rawOnly;
    this.current = photos.some(
      (p) => p.id === current && (!rawOnly || hasRaw(p)),
    )
      ? current
      : (photos.find((p) => !rawOnly || hasRaw(p))?.id ?? null);
    for (const photo of photos) this.committed.set(photo.id, photo);
  }
  get photo() {
    return this.photos.find(
      (p) => p.id === this.current && (!this.rawOnly || hasRaw(p)),
    );
  }
  setRawOnly(value: boolean) {
    this.rawOnly = value;
    this.select(
      this.photo?.id ??
        this.photos.find((p) => !value || hasRaw(p))?.id ??
        null,
    );
  }
  activate() {
    this.disposed = false;
  }
  private replace(photo: Photo) {
    this.photos = this.photos.map((p) => (p.id === photo.id ? photo : p));
  }
  select(id: string | null) {
    this.navigation++;
    clearTimeout(this.timer);
    this.current =
      id && this.rawOnly && !this.photos.some((p) => p.id === id && hasRaw(p))
        ? (this.photos.find(hasRaw)?.id ?? null)
        : id;
    this.deps.feedback(null);
    this.deps.changed();
  }
  step(delta: number, ids: string[]) {
    if (!ids.length) return;
    const index = ids.indexOf(this.current ?? "");
    this.select(ids[Math.max(0, Math.min(ids.length - 1, index + delta))]);
  }
  mark(mark: Mark, advance: boolean, next: () => void) {
    const photo = this.photo;
    if (!photo || this.disposed) return;
    const desired = {
      rating: Math.max(0, Math.min(5, mark.rating)),
      flag: mark.flag,
    };
    const actualChange =
      desired.rating !== photo.rating || desired.flag !== photo.flag;
    if (!actualChange) {
      // Explicit Shift at a rating boundary still advances exactly once.
      if (advance) {
        clearTimeout(this.timer);
        const id = ++this.sequence;
        const navigation = this.navigation;
        this.queue = this.queue.then(() => {
          const saved = this.committed.get(photo.id);
          if (
            !this.disposed &&
            this.sequence === id &&
            this.current === photo.id &&
            this.navigation === navigation &&
            saved?.rating === desired.rating &&
            saved.flag === desired.flag
          )
            next();
        });
      }
      return;
    }
    clearTimeout(this.timer);
    const id = ++this.sequence;
    const navigation = this.navigation;
    this.latest.set(photo.id, id);
    this.pending++;
    this.replace({ ...photo, ...desired });
    this.deps.changed();
    this.queue = this.queue.then(async () => {
      try {
        const saved = await this.deps.save(photo.id, desired);
        this.committed.set(photo.id, saved);
        this.deps.saved(saved);
        if (this.latest.get(photo.id) === id) this.replace(saved);
        if (
          !this.disposed &&
          this.sequence === id &&
          this.current === photo.id &&
          this.navigation === navigation
        ) {
          if (actualChange)
            this.deps.feedback({
              id,
              photoId: photo.id,
              kind:
                desired.flag !== photo.flag
                  ? "flag"
                  : desired.rating > photo.rating
                    ? "up"
                    : "down",
              ...desired,
              from: photo.rating,
            });
          if (advance)
            this.timer = setTimeout(() => {
              if (
                !this.disposed &&
                this.sequence === id &&
                this.current === photo.id &&
                this.navigation === navigation
              )
                next();
            }, 180);
          this.deps.error("", null);
        }
      } catch (error) {
        if (this.latest.get(photo.id) === id) {
          const previous = this.committed.get(photo.id);
          if (previous) this.replace(previous);
          if (!this.disposed)
            this.deps.error(
              `${photo.original_path}：${error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error)}`,
              () => {
                this.select(photo.id);
                this.mark(desired, false, next);
              },
              isReviewConflict(error),
            );
        }
      } finally {
        this.pending--;
        if (!this.disposed) this.deps.changed();
      }
    });
  }
  undo() {
    clearTimeout(this.timer);
    const id = ++this.sequence;
    this.pending++;
    this.deps.changed();
    this.queue = this.queue.then(async () => {
      try {
        const photo = await this.deps.undo();
        if (photo) {
          this.committed.set(photo.id, photo);
          if ((this.latest.get(photo.id) ?? 0) < id) this.replace(photo);
          this.deps.saved(photo);
          if (!this.disposed && this.sequence === id) {
            this.select(photo.id);
            this.deps.feedback({
              id,
              photoId: photo.id,
              kind: "undo",
              rating: photo.rating,
              flag: photo.flag,
              from: photo.rating,
            });
          }
        }
      } catch (error) {
        if (!this.disposed)
          this.deps.error(
            String((error as { message?: string })?.message ?? error),
            () => this.undo(),
            isReviewConflict(error),
          );
      } finally {
        this.pending--;
        if (!this.disposed) this.deps.changed();
      }
    });
  }
  async settle() {
    await this.queue;
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.deps.feedback(null);
  }
}

export type PhotoKeyAction =
  | { type: "rating"; value: number; relative: boolean; advance: boolean }
  | { type: "flag"; value: PhotoFlag; advance: boolean }
  | { type: "step"; delta: number }
  | { type: "undo" | "zoom" | "escape" };
export function photoKeyAction(
  event: Pick<
    KeyboardEvent,
    "key" | "code" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey" | "repeat"
  >,
  autoAdvance: boolean,
): PhotoKeyAction | null {
  if (event.altKey) return null;
  if (
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === "z" &&
    !event.shiftKey
  )
    return event.repeat ? null : { type: "undo" };
  if (event.metaKey || event.ctrlKey) return null;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight")
    return { type: "step", delta: event.key === "ArrowLeft" ? -1 : 1 };
  if (event.repeat) return null;
  if (event.key === "Escape") return { type: "escape" };
  if (event.code === "BracketLeft" || event.code === "BracketRight")
    return {
      type: "rating",
      value: event.code === "BracketRight" ? 1 : -1,
      relative: true,
      advance: event.shiftKey,
    };
  if (/^(Digit|Numpad)[0-5]$/.test(event.code))
    return {
      type: "rating",
      value: Number(event.code.slice(-1)),
      relative: false,
      advance: autoAdvance || event.shiftKey,
    };
  const key = event.key.toLowerCase();
  if (["c", "p", "x", "u"].includes(key))
    return {
      type: "flag",
      value:
        key === "c" || key === "p" ? "pick" : key === "x" ? "reject" : "none",
      advance: autoAdvance || event.shiftKey,
    };
  if (key === "z") return { type: "zoom" };
  return null;
}
