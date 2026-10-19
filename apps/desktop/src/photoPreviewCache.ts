import { reviewApi, type PhotoPreview } from "./photoApi";
const cache = new Map<string, PhotoPreview>();
const inflight = new Map<string, Promise<PhotoPreview>>();
const budget = 32 * 1024 * 1024;
let bytes = 0;
export function photoPreview(id: string, original = false, thumbnail = false) {
  const key = `${id}:${original}:${thumbnail}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return Promise.resolve(cached);
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const request = reviewApi
    .preview(id, original, thumbnail)
    .then((value) => {
      if (value.content.length < budget) {
        cache.set(key, value);
        bytes += value.content.length;
        while (bytes > budget || cache.size > 80) {
          const first = cache.keys().next().value!;
          bytes -= cache.get(first)!.content.length;
          cache.delete(first);
        }
      }
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}
