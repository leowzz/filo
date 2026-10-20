import { reviewApi, type PhotoPreview } from "./photoApi";

export const previewAhead = 5;
export const previewBehind = 3;
const previewBudget = 192 * 1024 * 1024;
const thumbnailBudget = 8 * 1024 * 1024;
type Args = [string, boolean, boolean, boolean];
type Cached = { value: PhotoPreview; bytes: number; decoded?: unknown };
type Request = {
  key: string;
  args: Args;
  foreground: boolean;
  promise: Promise<PhotoPreview>;
  resolve: (value: PhotoPreview) => void;
  reject: (error: unknown) => void;
};
const keyFor = (args: Args) => args.join(":");

async function decodePreview(value: PhotoPreview) {
  if (typeof Image === "undefined") return;
  const image = new Image();
  image.src = `data:${value.mime};base64,${value.content}`;
  await image.decode();
  return image;
}

export class PhotoPreviewCache {
  private cache = new Map<string, Cached>();
  private thumbnails = new Map<string, Cached>();
  private requests = new Map<string, Request>();
  private queue: Request[] = [];
  private retained: Set<string> | null = null;
  private running = 0;
  private background = 0;
  private thumbnailRunning = 0;
  private listeners = new Set<() => void>();

  constructor(
    private load = reviewApi.preview,
    private decode: (value: PhotoPreview) => Promise<unknown> = decodePreview,
  ) {}

  peek(id: string, original = false, thumbnail = false, rawOnly = false) {
    return (thumbnail ? this.thumbnails : this.cache).get(
      keyFor([id, original, thumbnail, rawOnly]),
    )?.value;
  }

  get(id: string, original = false, thumbnail = false, rawOnly = false) {
    return this.request([id, original, thumbnail, rawOnly], !thumbnail);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  state(id: string, rawOnly: boolean) {
    const keys = [false, true].map((original) =>
      keyFor([id, original, false, rawOnly]),
    );
    if (keys.some((key) => this.cache.has(key))) return "ready";
    if (keys.some((key) => this.requests.has(key))) return "pending";
    return "empty";
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  // The input follows the filtered navigation order, including the current photo.
  setWindow(ids: string[], current: string | null, rawOnly: boolean) {
    const index = ids.indexOf(current ?? "");
    const window =
      index < 0
        ? []
        : ids.slice(
            Math.max(0, index - previewBehind),
            index + previewAhead + 1,
          );
    const ahead =
      index < 0 ? [] : ids.slice(index + 1, index + previewAhead + 1);
    this.retained = new Set(
      window.map((id) => keyFor([id, false, false, rawOnly])),
    );
    if (current) this.retained.add(keyFor([current, true, false, rawOnly]));
    for (const key of this.cache.keys())
      if (!this.retained.has(key)) this.cache.delete(key);
    const wanted = new Set(
      ahead.map((id) => keyFor([id, false, false, rawOnly])),
    );
    if (current) {
      wanted.add(keyFor([current, false, false, rawOnly]));
      wanted.add(keyFor([current, true, false, rawOnly]));
    }
    this.queue = this.queue.filter((request) => {
      if (request.args[2]) return true;
      if (wanted.has(request.key)) {
        request.foreground = request.args[0] === current;
        return true;
      }
      this.requests.delete(request.key);
      request.reject(new Error("预览已移出预加载范围"));
      return false;
    });
    for (const id of ahead)
      void this.request([id, false, false, rawOnly], false).catch(() => {});
    this.queue.sort((a, b) => ids.indexOf(a.args[0]) - ids.indexOf(b.args[0]));
    this.notify();
  }

  clearWindow() {
    this.setWindow([], null, false);
    for (const request of this.queue) {
      this.requests.delete(request.key);
      request.reject(new Error("已退出审图"));
    }
    this.queue = [];
  }

  private request(args: Args, foreground: boolean): Promise<PhotoPreview> {
    const key = keyFor(args);
    const cache = args[2] ? this.thumbnails : this.cache;
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return Promise.resolve(cached.value);
    }
    const pending = this.requests.get(key);
    if (pending) {
      if (foreground) pending.foreground = true;
      queueMicrotask(() => this.drain());
      return pending.promise;
    }
    let resolve!: Request["resolve"];
    let reject!: Request["reject"];
    const promise = new Promise<PhotoPreview>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const request = { key, args, foreground, promise, resolve, reject };
    this.requests.set(key, request);
    this.queue.push(request);
    if (!args[2]) this.notify();
    // Let the current photo join/promote its request before starting speculative work.
    queueMicrotask(() => this.drain());
    return promise;
  }

  private drain() {
    for (;;) {
      let index =
        this.running < 2
          ? this.queue.findIndex(
              (request) => request.foreground && !request.args[2],
            )
          : -1;
      if (index < 0 && this.running < 2 && this.background === 0)
        index = this.queue.findIndex((request) => !request.args[2]);
      // Thumbnails have their own backend slots and must not delay the main image.
      if (index < 0 && this.thumbnailRunning < 1)
        index = this.queue.findIndex((request) => request.args[2]);
      if (index < 0) return;
      const request = this.queue.splice(index, 1)[0];
      const thumbnail = request.args[2];
      const background = !thumbnail && !request.foreground;
      if (thumbnail) this.thumbnailRunning++;
      else this.running++;
      if (background) this.background++;
      void this.run(request).finally(() => {
        if (thumbnail) this.thumbnailRunning--;
        else this.running--;
        if (background) this.background--;
        this.requests.delete(request.key);
        if (!thumbnail) this.notify();
        this.drain();
      });
    }
  }

  private async run(request: Request) {
    try {
      const value = await this.load(...request.args);
      const thumbnail = request.args[2];
      const retained = () =>
        thumbnail || this.retained === null || this.retained.has(request.key);
      if (!retained()) {
        request.resolve(value);
        return;
      }
      // Keep decoded images alive as well as IPC data, so navigation avoids decoding again.
      const decoded = thumbnail ? undefined : await this.decode(value);
      if (retained()) {
        const cache = thumbnail ? this.thumbnails : this.cache;
        const budget = thumbnail ? thumbnailBudget : previewBudget;
        const bytes =
          value.content.length * 2 +
          (decoded ? value.width * value.height * 4 : 0);
        if (bytes <= budget) {
          cache.set(request.key, { value, bytes, decoded });
          let total = [...cache.values()].reduce(
            (sum, entry) => sum + entry.bytes,
            0,
          );
          while (total > budget || cache.size > 80) {
            const key = cache.keys().next().value!;
            total -= cache.get(key)!.bytes;
            cache.delete(key);
          }
        }
      }
      request.resolve(value);
    } catch (error) {
      request.reject(error);
    }
  }
}

export const photoPreviews = new PhotoPreviewCache();
export const photoPreview = (
  id: string,
  original = false,
  thumbnail = false,
  rawOnly = false,
) => photoPreviews.get(id, original, thumbnail, rawOnly);
