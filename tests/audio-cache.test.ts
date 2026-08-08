import { describe, expect, it } from "vitest";
import { audioCacheKey, hashString } from "../src/extension/audio/audio-cache";

describe("hashString (FNV-1a 64-bit)", () => {
  it("ổn định: cùng input → cùng output", () => {
    expect(hashString("Xin chào thế giới")).toBe(hashString("Xin chào thế giới"));
  });

  it("trả về đúng 16 ký tự hex", () => {
    for (const input of ["a", "việt nam", "Hôm nay trời đẹp quá!", ""]) {
      expect(hashString(input)).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("khác input → khác output", () => {
    expect(hashString("xin chào")).not.toBe(hashString("xin chao"));
    expect(hashString("Hello")).not.toBe(hashString("hello"));
    expect(hashString("a")).not.toBe(hashString("b"));
  });

  it("chạy thuần trong node (không cần crypto.subtle)", () => {
    // hashString chỉ dùng số học thuần — có thể chạy ngoài browser context.
    expect(hashString("pure")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("audioCacheKey", () => {
  it("có prefix tts:", () => {
    expect(audioCacheKey("Xin chào", "vi-VN-NamMinhNeural", 1)).toMatch(/^tts:[0-9a-f]{16}$/);
  });

  it("ổn định: cùng text + voice + rate → cùng key", () => {
    expect(audioCacheKey("Xin chào", "vi-VN-NamMinhNeural", 1))
      .toBe(audioCacheKey("Xin chào", "vi-VN-NamMinhNeural", 1));
  });

  it("khác voice → khác key", () => {
    expect(audioCacheKey("Xin chào", "vi-VN-NamMinhNeural", 1))
      .not.toBe(audioCacheKey("Xin chào", "vi-VN-HoaiMyNeural", 1));
  });

  it("khác rate → khác key", () => {
    expect(audioCacheKey("Xin chào", "vi-VN-NamMinhNeural", 1))
      .not.toBe(audioCacheKey("Xin chào", "vi-VN-NamMinhNeural", 1.25));
  });

  it("khác text → khác key", () => {
    expect(audioCacheKey("Xin chào", "vi-VN-NamMinhNeural", 1))
      .not.toBe(audioCacheKey("Chào xin", "vi-VN-NamMinhNeural", 1));
  });
});
