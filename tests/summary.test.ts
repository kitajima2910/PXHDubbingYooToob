import { describe, expect, it } from "vitest";
import { formatSegmentsForSummary } from "../src/api/lib/summary-helpers";
import type { SummarySegment } from "../src/api/lib/summary-helpers";

function seg(sourceText: string, translatedText?: string): SummarySegment {
  return translatedText !== undefined ? { sourceText, translatedText } : { sourceText };
}

describe("formatSegmentsForSummary", () => {
  it("ném lỗi khi segments rỗng", () => {
    expect(() => formatSegmentsForSummary([], 6_000)).toThrow("rỗng");
  });

  it("ném lỗi khi tất cả text rỗng", () => {
    expect(() => formatSegmentsForSummary([seg(""), seg("  ")], 6_000)).toThrow("Không có nội dung");
  });

  it("gom text, ưu tiên translatedText", () => {
    const { text, usedCount } = formatSegmentsForSummary(
      [seg("Hello", "Xin chào"), seg("World", "Thế giới")],
      6_000,
    );
    expect(text).toBe("Xin chào Thế giới");
    expect(usedCount).toBe(2);
  });

  it("fallback về sourceText khi không có translatedText", () => {
    const { text } = formatSegmentsForSummary(
      [seg("Hello world")],
      6_000,
    );
    expect(text).toBe("Hello world");
  });

  it("truncates đúng chars khi text quá dài", () => {
    const segments = Array.from({ length: 50 }, (_, i) => seg(`segment-${i}-` + "x".repeat(200)));
    const { usedCount, text } = formatSegmentsForSummary(segments, 1_000);
    expect(usedCount).toBeLessThanOrEqual(50);
    expect(text.length).toBeLessThanOrEqual(1_000);
  });

  it("lấy ít nhất 1 segment khi segments có content", () => {
    const longSeg = seg("x".repeat(5_000));
    const { usedCount, text } = formatSegmentsForSummary([longSeg], 1_000);
    expect(usedCount).toBe(1);
    expect(text.length).toBe(1_000);
  });
});
