export type BatchFailure<T> = { item: T; error: unknown };

/** Each selected item has its own outcome; a failure never stops its siblings. */
export async function runBatch<T, R>(
  items: T[],
  operation: (item: T) => Promise<R>,
  concurrency = 1,
) {
  const results: (
    { ok: true; item: T; result: R } | { ok: false; item: T; error: unknown }
  )[] = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      const item = items[index];
      try {
        results[index] = { ok: true, item, result: await operation(item) };
      } catch (error) {
        results[index] = { ok: false, item, error };
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(items.length, Math.max(1, concurrency)) },
      worker,
    ),
  );
  return {
    completed: results.flatMap((result) =>
      result.ok ? [{ item: result.item, result: result.result }] : [],
    ),
    failed: results.flatMap((result) =>
      result.ok ? [] : [{ item: result.item, error: result.error }],
    ),
  };
}
