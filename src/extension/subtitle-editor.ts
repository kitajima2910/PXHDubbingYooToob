// Pure helpers for the Subtitle Editor popup section.
// NO DOM imports — unit-testable without jsdom.

export interface EditorTranslation {
  id: string;
  sourceText: string;
  translatedText: string;
}

export interface EditorEdit {
  id: string;
  translatedText: string;
}

export interface ChangedSegment {
  sourceText: string;
  translatedText: string;
}

/** Trích videoId (11 ký tự) từ URL video YouTube, trả undefined nếu không phải. */
export function parseVideoIdFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!["www.youtube.com", "youtube.com", "m.youtube.com"].includes(parsed.hostname)) return undefined;
    const videoId = parsed.searchParams.get("v") ?? "";
    return /^[A-Za-z0-9_-]{11}$/.test(videoId) ? videoId : undefined;
  } catch {
    return undefined;
  }
}

/** Chọn những câu bản dịch đã thay đổi (khác bản gốc sau khi trim) và không rỗng. */
export function selectChangedSegments(originals: EditorTranslation[], edits: EditorEdit[]): ChangedSegment[] {
  const originalById = new Map(originals.map((item) => [item.id, item]));
  const changed: ChangedSegment[] = [];
  for (const edit of edits) {
    const original = originalById.get(edit.id);
    if (!original) continue;
    const translatedText = edit.translatedText.trim();
    if (!translatedText || translatedText === original.translatedText.trim()) continue;
    changed.push({ sourceText: original.sourceText, translatedText });
  }
  return changed;
}
