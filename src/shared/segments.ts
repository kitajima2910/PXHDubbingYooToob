import type { SubtitleSegment } from "./types.js";

export function stripTranscriptTimestamps(text: string, knownTimestamp = ""): string {
  let cleaned = text;
  const known = knownTimestamp.replace(/\s+/g, " ").trim();
  if (known) {
    const escaped = known.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(new RegExp(escaped, "g"), " ");
  }
  return cleaned
    .replace(/^\s*\d{1,3}:\d{2}\s*/g, "")
    .replace(/^\s*\d{1,3}:\d{2}:\d{2}\s*/g, "")
    .replace(/^\s*\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}\s*/g, "")
    .replace(/^\s*\d+:\d+\s+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function batchSegments<T>(segments: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < segments.length; i += batchSize) {
    batches.push(segments.slice(i, i + batchSize));
  }
  return batches;
}

export function selectUpcomingSegments(segments: SubtitleSegment[], fromMs: number, windowMs: number, queued: ReadonlySet<string>, limit = 15): SubtitleSegment[] {
  const toMs = fromMs + windowMs;
  return segments.filter((item) => item.endMs >= fromMs && item.startMs <= toMs && !queued.has(item.id)).slice(0, limit);
}

export function mergeOverlappingSegments(segments: SubtitleSegment[], targetSpanMs = 6_000, maxCharacters = 180): SubtitleSegment[] {
  const sorted = [...segments].sort((left, right) => left.startMs - right.startMs);
  const merged: SubtitleSegment[] = [];
  for (const segment of sorted) {
    const last = merged[merged.length - 1];
    if (!last) { merged.push({ ...segment }); continue; }
    const gap = segment.startMs - last.endMs;
    const totalText = last.sourceText + " " + segment.sourceText;
    if (gap <= targetSpanMs && totalText.length <= maxCharacters) {
      last.endMs = Math.max(last.endMs, segment.endMs);
      last.sourceText = totalText;
      last.translatedText = last.translatedText && segment.translatedText ? last.translatedText + " " + segment.translatedText : undefined;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

export function selectChangedSegments(original: Array<{ id: string; translatedText: string }>, edits: Array<{ id: string; translatedText: string }>): Array<{ sourceText: string; translatedText: string }> {
  const originalById = new Map(original.map((item) => [item.id, item.translatedText]));
  const changed: Array<{ sourceText: string; translatedText: string }> = [];
  for (const edit of edits) {
    const before = originalById.get(edit.id);
    if (before !== edit.translatedText && edit.translatedText.trim()) {
      changed.push({ sourceText: edit.id, translatedText: edit.translatedText.trim() });
    }
  }
  return changed;
}

export function mapTranslations(segments: SubtitleSegment[], translated: Array<{ id: string; translatedText: string }>): SubtitleSegment[] {
  const byId = new Map(translated.map((item) => [item.id, item.translatedText]));
  return segments.map((segment) => ({ ...segment, translatedText: byId.get(segment.id) ?? segment.translatedText ?? undefined })) as SubtitleSegment[];
}
