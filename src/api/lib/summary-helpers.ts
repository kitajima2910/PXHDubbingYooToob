export interface SummarySegment {
  sourceText: string;
  translatedText?: string | undefined;
}

/**
 * Gom text từ segments: ưu tiên translatedText, fallback sourceText.
 * Giới hạn tổng chars để vừa context window Groq.
 * Trả về object chứa text đã gom và số segments thực tế được dùng.
 */
export function formatSegmentsForSummary(
  segments: SummarySegment[],
  maxChars: number,
): { text: string; usedCount: number } {
  if (!segments.length) throw new Error("Danh sách segments không được rỗng");
  const trimmed = segments.map((s) => ({
    text: (s.translatedText || s.sourceText).trim(),
    len: (s.translatedText || s.sourceText).trim().length,
  })).filter((s) => s.len > 0);
  if (!trimmed.length) throw new Error("Không có nội dung để tóm tắt");
  let total = 0;
  let count = 0;
  for (const item of trimmed) {
    if (total + item.len + (count > 0 ? 1 : 0) > maxChars) break;
    total += item.len + (count > 0 ? 1 : 0);
    count += 1;
  }
  if (count === 0) count = 1;
  const parts = trimmed.slice(0, count).map((s) => s.text);
  const joined = parts.join(" ");
  const truncated = joined.length > maxChars ? joined.slice(0, maxChars) : joined;
  return { text: truncated, usedCount: count };
}
