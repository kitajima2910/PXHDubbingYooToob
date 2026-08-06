import { describe, expect, it } from "vitest";
import { batchSegments, mapTranslations, selectUpcomingSegments } from "../src/shared/segments";
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
});
