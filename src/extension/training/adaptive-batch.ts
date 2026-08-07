export async function runAdaptiveBatch<T, R>(
  items: T[],
  process: (batch: T[]) => Promise<R[]>,
): Promise<R[]> {
  if (!items.length) return [];
  try {
    return await process(items);
  } catch (error) {
    if (items.length === 1) throw error;
    const middle = Math.ceil(items.length / 2);
    const left = await runAdaptiveBatch(items.slice(0, middle), process);
    const right = await runAdaptiveBatch(items.slice(middle), process);
    return [...left, ...right];
  }
}
