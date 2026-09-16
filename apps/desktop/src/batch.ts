export type BatchFailure<T> = { item: T; error: unknown };

/** Each selected item has its own outcome; a failure never stops its siblings. */
export async function runBatch<T, R>(
  items: T[],
  operation: (item: T) => Promise<R>,
) {
  const completed: { item: T; result: R }[] = [];
  const failed: BatchFailure<T>[] = [];
  for (const item of items) {
    try {
      completed.push({ item, result: await operation(item) });
    } catch (error) {
      failed.push({ item, error });
    }
  }
  return { completed, failed };
}
