import { describe, expect, it } from "vitest";
import { parseYouTubeTrainingTarget } from "../src/extension/training/youtube-url";

describe("YouTube training URL", () => {
  it("nhận URL video watch và youtu.be", () => {
    expect(parseYouTubeTrainingTarget("https://www.youtube.com/watch?v=XjDRuB3cmbM")).toEqual({ kind: "video", videoIds: ["XjDRuB3cmbM"] });
    expect(parseYouTubeTrainingTarget("https://youtu.be/XjDRuB3cmbM?t=15")).toEqual({ kind: "video", videoIds: ["XjDRuB3cmbM"] });
  });

  it("giữ URL playlist để tải danh sách", () => {
    const target = parseYouTubeTrainingTarget("https://www.youtube.com/playlist?list=PLkD4ksZgZ-noUIybdspTAuzbl0QKj5uhC");
    expect(target.kind).toBe("playlist");
  });

  it("ưu tiên playlist khi URL watch có cả v và list", () => {
    expect(parseYouTubeTrainingTarget("https://www.youtube.com/watch?v=XjDRuB3cmbM&list=PL123").kind).toBe("playlist");
  });

  it("từ chối domain và video ID không hợp lệ", () => {
    expect(() => parseYouTubeTrainingTarget("https://example.com/watch?v=XjDRuB3cmbM")).toThrow();
    expect(() => parseYouTubeTrainingTarget("https://youtube.com/watch?v=short")).toThrow();
  });
});
