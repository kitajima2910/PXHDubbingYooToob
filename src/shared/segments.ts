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
