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
    expect(stripTranscriptTimestamps("Mở đầu0:42Nội dung tiếp theo")).toBe("Mở đầuNội dung tiếp theo");
    expect(stripTranscriptTimestamps("Text (1：02), rồi 2.03 kết thúc")).toBe("Text, rồi kết thúc");
  });

  it("loại phần từ bị lặp ở ranh giới caption chồng lấn", () => {
    const result = mergeOverlappingSegments([
      { id: "a", startMs: 0, endMs: 4_000, sourceText: "This is how it works today" },
      { id: "b", startMs: 3_000, endMs: 7_000, sourceText: "it works today in practice." },
    ]);
    expect(result[0]?.sourceText).toBe("This is how it works today in practice.");
  });

  it("ghép caption ngắn thành cụm nói tự nhiên nhưng giữ timeline", () => {
    const result = mergeOverlappingSegments([
      { id: "1", startMs: 0, endMs: 2_000, sourceText: "This is", translatedText: "Đây là" },
      { id: "2", startMs: 2_000, endMs: 4_000, sourceText: "a smoother", translatedText: "một câu" },
      { id: "3", startMs: 4_000, endMs: 6_000, sourceText: "sentence.", translatedText: "mượt hơn." },
      { id: "4", startMs: 6_000, endMs: 8_000, sourceText: "Next part.", translatedText: "Phần tiếp theo." },
    ]);
    expect(result[0]).toMatchObject({
      startMs: 0, endMs: 6_000,
      sourceText: "This is a smoother sentence.", translatedText: "Đây là một câu mượt hơn.",
    });
    expect(result[1]).toMatchObject({ startMs: 6_000, sourceText: "Next part." });
  });
});
