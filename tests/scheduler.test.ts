import { describe, expect, it } from "vitest";
import { speechPlaybackRate } from "../src/extension/audio/scheduler";

describe("tốc độ phát giọng nói", () => {
  it("chỉ tăng nhẹ câu dài để giữ giọng tự nhiên", () => expect(speechPlaybackRate(4, 2_000, 1)).toBe(1.15));
  it("chỉ giảm nhẹ khi câu ngắn", () => expect(speechPlaybackRate(1, 4_000, 1)).toBe(0.95));
  it("tính cả tốc độ video", () => expect(speechPlaybackRate(2, 2_000, 1.25)).toBe(1.25));
});
