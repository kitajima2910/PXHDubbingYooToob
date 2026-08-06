import { describe, expect, it } from "vitest";
import { batchSegments, mapTranslations, mergeOverlappingSegments, selectUpcomingSegments, stripTranscriptTimestamps } from "../src/shared/segments";
import type { SubtitleSegment } from "../src/shared/types";

const segments: SubtitleSegment[] = [
  { id: "a", startMs: 0, endMs: 1000, sourceText: "Hello" },
  { id: "b", startMs: 1000, endMs: 2000, sourceText: "World" },
  { id: "c", startMs: 2000, endMs: 3000, sourceText: "Again" },
];

describe("xử lý đoạn phụ đề", () => {
  it("chia batch không làm đổi thứ tự", () => {
    const ids = batchSegments(segments, 2).map((batch) => batch.map((item) => item.id));
    expect(ids).toEqual([["a", "b"], ["c"]]);
  });

  it("ánh xạ bản dịch theo id", () => {
    const result = mapTranslations(segments, [{ id: "b", translatedText: "Thế giới" }]);
    expect(result.map((item) => item.translatedText)).toEqual(["Hello", "Thế giới", "Again"]);
  });

  it("chọn cửa sổ sắp phát và loại đoạn đã xếp hàng", () => {
    const result = selectUpcomingSegments(segments, 900, 1_200, new Set(["b"]));
    expect(result.map((item) => item.id)).toEqual(["a", "c"]);
  });

  it("ghép caption chồng lấn mà không làm mất từ", () => {
    const overlapping: SubtitleSegment[] = [
      { id: "1", startMs: 0, endMs: 4_680, sourceText: "Welcome to Cloud Wizard." },
      { id: "2", startMs: 2_880, endMs: 7_120, sourceText: "In this video we dive" },
      { id: "3", startMs: 4_680, endMs: 9_440, sourceText: "into recommendation systems." },
      { id: "4", startMs: 7_120, endMs: 11_720, sourceText: "They power your feed." },
    ];
    const result = mergeOverlappingSegments(overlapping);
    expect(result[0]?.sourceText).toBe("Welcome to Cloud Wizard. In this video we dive into recommendation systems.");
    expect(result[0]?.endMs).toBe(result[1]?.startMs);
    expect(result.map((item) => item.sourceText).join(" ")).toContain("They power your feed.");
  });

  it("loại timestamp transcript dùng dấu hai chấm, dấu chấm và timestamp đã biết", () => {
    expect(stripTranscriptTimestamps("0:42 super useful", "0:42")).toBe("super useful");
    expect(stripTranscriptTimestamps("0.51 this will be useful")).toBe("this will be useful");
    expect(stripTranscriptTimestamps("Text 1：02 tiếp theo")).toBe("Text tiếp theo");
    expect(stripTranscriptTimestamps("0:42", "0:42")).toBe("");
    expect(stripTranscriptTimestamps("0:19Nội dung tiếp theo", "0:19")).toBe("Nội dung tiếp theo");
  });
});
