import { describe, expect, it } from "vitest";
import { pcmRms, shouldFlushSpeech } from "../src/extension/local-stt/vad";

describe("local STT voice activity detection", () => {
  it("phân biệt im lặng và tín hiệu giọng nói", () => {
    expect(pcmRms(new Float32Array(1_600))).toBe(0);
    expect(pcmRms(new Float32Array(1_600).fill(0.02))).toBeCloseTo(0.02, 5);
  });

  it("chỉ đóng câu sau khoảng lặng đủ dài", () => {
    expect(shouldFlushSpeech(400, 700)).toBe(false);
    expect(shouldFlushSpeech(1_000, 500)).toBe(false);
    expect(shouldFlushSpeech(1_000, 600)).toBe(true);
  });

  it("giới hạn câu dài để giữ độ trễ", () => {
    expect(shouldFlushSpeech(7_900, 0)).toBe(false);
    expect(shouldFlushSpeech(8_000, 0)).toBe(true);
  });
});
