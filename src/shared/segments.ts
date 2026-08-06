import type { SubtitleSegment } from "./types.js";

export function batchSegments(segments: SubtitleSegment[], size = 8): SubtitleSegment[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error("Kích thước batch phải là số nguyên dương");
  const batches: SubtitleSegment[][] = [];
  for (let index = 0; index < segments.length; index += size) batches.push(segments.slice(index, index + size));
  return batches;
}

export function mapTranslations(segments: SubtitleSegment[], translated: Array<{ id: string; translatedText: string }>): SubtitleSegment[] {
  const byId = new Map(translated.map((item) => [item.id, item.translatedText]));
  return segments.map((segment) => ({ ...segment, translatedText: byId.get(segment.id) ?? segment.sourceText }));
}

export function selectUpcomingSegments(segments: SubtitleSegment[], fromMs: number, windowMs: number, queued: ReadonlySet<string>, limit = 8): SubtitleSegment[] {
  const toMs = fromMs + windowMs;
  return segments.filter((item) => item.endMs >= fromMs && item.startMs <= toMs && !queued.has(item.id)).slice(0, limit);
}

export function mergeOverlappingSegments(segments: SubtitleSegment[], targetSpanMs = 6_000, maxCharacters = 180): SubtitleSegment[] {
  const sorted = [...segments].sort((left, right) => left.startMs - right.startMs);
  const merged: SubtitleSegment[] = [];
  let group: SubtitleSegment[] = [];

  const flush = (nextStartMs?: number): void => {
    const first = group[0];
    const last = group[group.length - 1];
    if (!first || !last) return;
    const naturalEnd = Math.max(...group.map((item) => item.endMs));
    const endMs = Math.max(first.startMs + 500, nextStartMs ?? naturalEnd);
    merged.push({
      id: `merged-${first.id}-${last.id}`,
      startMs: first.startMs,
      endMs,
      sourceText: group.map((item) => item.sourceText.trim()).filter(Boolean).join(" ").replace(/\s+/g, " "),
    });
    group = [];
  };

  for (let index = 0; index < sorted.length; index += 1) {
    const segment = sorted[index]!;
    const next = sorted[index + 1];
    group.push(segment);
    const first = group[0]!;
    const textLength = group.reduce((total, item) => total + item.sourceText.length + 1, 0);
    const largeGap = next ? next.startMs - segment.startMs > 3_500 : true;
    const targetReached = next ? next.startMs - first.startMs >= targetSpanMs : true;
    const hardSpanReached = next ? next.startMs - first.startMs >= 10_000 : true;
    const naturalBoundary = /[.!?,;:]\s*$/.test(segment.sourceText);
    if (!next || largeGap || hardSpanReached || textLength >= maxCharacters || (targetReached && naturalBoundary)) flush(next?.startMs);
  }
  return merged.filter((item) => item.sourceText.length > 0);
}
