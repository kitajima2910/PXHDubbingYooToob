import { describe, expect, it } from "vitest";
import { parseVideoIdFromUrl, selectChangedSegments } from "../src/extension/subtitle-editor";

describe("parse video id từ URL YouTube", () => {
  it("lấy id từ URL watch", () => {
    expect(parseVideoIdFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("chấp nhận id có gạch ngang và gạch dưới", () => {
    expect(parseVideoIdFromUrl("https://www.youtube.com/watch?v=AbC_123-xyz")).toBe("AbC_123-xyz");
  });

  it("trả undefined khi thiếu tham số v", () => {
    expect(parseVideoIdFromUrl("https://www.youtube.com/watch?list=abc")).toBeUndefined();
  });

  it("trả undefined cho trang không phải YouTube", () => {
    expect(parseVideoIdFromUrl("https://example.com/watch?v=dQw4w9WgXcQ")).toBeUndefined();
  });

  it("trả undefined cho URL hỏng", () => {
    expect(parseVideoIdFromUrl("not a url")).toBeUndefined();
  });

  it("trả undefined cho URL rỗng", () => {
    expect(parseVideoIdFromUrl(undefined)).toBeUndefined();
  });
});

describe("chọn câu bản dịch đã sửa", () => {
  const originals = [
    { id: "a", sourceText: "Hello", translatedText: "Xin chào" },
    { id: "b", sourceText: "World", translatedText: "Thế giới" },
    { id: "c", sourceText: "Again", translatedText: "" },
  ];

  it("chỉ chọn câu thay đổi so với bản gốc", () => {
    const changed = selectChangedSegments(originals, [
      { id: "a", translatedText: "Chào bạn" },
      { id: "b", translatedText: "Thế giới" },
      { id: "c", translatedText: "Lần nữa" },
    ]);
    expect(changed).toEqual([
      { sourceText: "Hello", translatedText: "Chào bạn" },
      { sourceText: "Again", translatedText: "Lần nữa" },
    ]);
  });

  it("bỏ qua câu rỗng hoặc chỉ khoảng trắng", () => {
    const changed = selectChangedSegments(originals, [
      { id: "a", translatedText: "" },
      { id: "b", translatedText: "   " },
    ]);
    expect(changed).toEqual([]);
  });

  it("trim khoảng trắng thừa quanh bản dịch", () => {
    const changed = selectChangedSegments(originals, [{ id: "a", translatedText: "  Chào bạn  " }]);
    expect(changed).toEqual([{ sourceText: "Hello", translatedText: "Chào bạn" }]);
  });

  it("bỏ qua câu không có trong danh sách gốc", () => {
    const changed = selectChangedSegments(originals, [{ id: "unknown", translatedText: "X" }]);
    expect(changed).toEqual([]);
  });

  it("bỏ qua khi sửa giống y hệt bản gốc dù thừa khoảng trắng", () => {
    const changed = selectChangedSegments(originals, [{ id: "b", translatedText: "  Thế giới  " }]);
    expect(changed).toEqual([]);
  });
});
