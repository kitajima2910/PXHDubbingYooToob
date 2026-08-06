import { describe, expect, it } from "vitest";
import { speechPlaybackRate } from "../src/extension/audio/scheduler";

describe("tốc độ phát giọng nói", () => {
  it("tăng tốc câu dài để vừa khung thời gian", () => expect(speechPlaybackRate(4, 2_000, 1)).toBe(1.3));
  it("giữ tốc độ trong giới hạn khi câu ngắn", () => expect(speechPlaybackRate(1, 4_000, 1)).toBe(0.85));
  it("tính cả tốc độ video", () => expect(speechPlaybackRate(2, 2_000, 1.25)).toBe(1.25));
});
