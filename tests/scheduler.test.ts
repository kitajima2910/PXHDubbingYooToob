import { describe, expect, it } from "vitest";
import { canStartSpeechAt, speechCatchupRate, speechPlaybackRate } from "../src/extension/audio/scheduler";

describe("tốc độ phát giọng nói", () => {
  it("tăng vừa phải câu dài để giảm tích lũy độ trễ", () => expect(speechPlaybackRate(4, 2_000, 1)).toBe(1.25));
  it("chỉ giảm nhẹ khi câu ngắn", () => expect(speechPlaybackRate(1, 4_000, 1)).toBe(0.95));
  it("tính cả tốc độ video", () => expect(speechPlaybackRate(2, 2_000, 1.25)).toBe(1.25));
  it("bắt kịp nhẹ khi câu bắt đầu muộn", () => {
    expect(speechCatchupRate(0)).toBe(1);
    expect(speechCatchupRate(4_000)).toBe(1.1);
    expect(speechCatchupRate(20_000)).toBe(1.1);
  });

  it("vẫn phát câu đến muộn khi slot của câu chưa kết thúc", () => {
    const segment = { id: "a", startMs: 10_000, endMs: 16_000, sourceText: "Xin chào" };
    expect(canStartSpeechAt(segment, 12_000)).toBe(true);
    expect(canStartSpeechAt(segment, 13_000)).toBe(true);
    expect(canStartSpeechAt(segment, 15_900)).toBe(false);
  });
});
