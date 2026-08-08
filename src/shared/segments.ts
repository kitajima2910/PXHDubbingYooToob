import type { SubtitleSegment } from "./types.js";

export function stripTranscriptTimestamps(text: string, knownTimestamp = ""): string {
  let cleaned = text;
  const known = knownTimestamp.replace(/\s+/g, " ").trim();
  if (known) {
    const escaped = known.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(new RegExp(escaped, "g"), " ");
  }
  return cleaned
    .replace(/(^|[^\d])\d{1,3}(?:(?::|：|\.)\d{2}){1,2}(?!\d)/gu, "$1")
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .trim();
}

function joinWithoutRepeatedBoundary(parts: string[]): string {
  const output: string[] = [];
  const normalized = (value: string): string => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  for (const part of parts) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let overlap = 0;
    for (let size = Math.min(12, output.length, words.length); size >= 2; size -= 1) {
      const tail = output.slice(-size).map(normalized);
      const head = words.slice(0, size).map(normalized);
      if (tail.every((word, index) => word && word === head[index])) { overlap = size; break; }
    }
    output.push(...words.slice(overlap));
  }
  return output.join(" ");
}

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

export function selectUpcomingSegments(segments: SubtitleSegment[], fromMs: number, windowMs: number, queued: ReadonlySet<string>, limit = 15): SubtitleSegment[] {
  const toMs = fromMs + windowMs;
  return segments.filter((item) => item.endMs >= fromMs && item.startMs <= toMs && !queued.has(item.id)).slice(0, limit);
}

// Batch khởi động nhanh: chỉ 5 câu để respond popup trong <2s
export function selectUpcomingSegmentsFast(segments: SubtitleSegment[], fromMs: number, windowMs: number, queued: ReadonlySet<string>): SubtitleSegment[] {
  return selectUpcomingSegments(segments, fromMs, windowMs, queued, 5);
}
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
    const translatedParts = group.map((item) => item.translatedText?.trim() ?? "");
    const translatedText = translatedParts.every(Boolean) ? joinWithoutRepeatedBoundary(translatedParts) : undefined;
    merged.push({
      id: `merged-${first.id}-${last.id}`,
      startMs: first.startMs,
      endMs,
      sourceText: joinWithoutRepeatedBoundary(group.map((item) => item.sourceText)),
      ...(translatedText ? { translatedText } : {}),
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
