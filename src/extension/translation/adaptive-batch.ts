export async function runAdaptiveBatchSettled<T, R>(
  items: T[],
  process: (batch: T[]) => Promise<R[]>,
): Promise<{ results: R[]; failed: T[] }> {
  if (!items.length) return { results: [], failed: [] };
  try {
    return { results: await process(items), failed: [] };
  } catch {
    if (items.length === 1) return { results: [], failed: items };
    const middle = Math.ceil(items.length / 2);
    const left = await runAdaptiveBatchSettled(items.slice(0, middle), process);
    const right = await runAdaptiveBatchSettled(items.slice(middle), process);
    return { results: [...left.results, ...right.results], failed: [...left.failed, ...right.failed] };
  }
}
