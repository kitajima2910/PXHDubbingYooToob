import { describe, expect, it } from "vitest";
import {
  DEFAULT_VOICE_ID,
  EDGE_VOICES,
  VOICE_STORAGE_KEY,
  edgeVoiceIds,
  isKnownVoice,
  voiceOption,
} from "../src/shared/voices";

describe("voice library", () => {
  it("DEFAULT_VOICE_ID tồn tại trong EDGE_VOICES", () => {
    expect(EDGE_VOICES.some((voice) => voice.id === DEFAULT_VOICE_ID)).toBe(true);
  });

  it("edgeVoiceIds trả về đúng danh sách id Edge TTS", () => {
    const ids = edgeVoiceIds();
    expect(ids).toHaveLength(2);
    expect(ids).toContain("vi-VN-NamMinhNeural");
    expect(ids).toContain("vi-VN-HoaiMyNeural");
    expect(ids.every((id) => typeof id === "string")).toBe(true);
  });

  it("isKnownVoice nhận diện giọng đã biết", () => {
    expect(isKnownVoice("vi-VN-NamMinhNeural")).toBe(true);
    expect(isKnownVoice("vi-VN-UnknownNeural")).toBe(false);
    expect(isKnownVoice("")).toBe(false);
  });

  it("voiceOption trả về option tương ứng hoặc undefined", () => {
    const nam = voiceOption("vi-VN-NamMinhNeural");
    expect(nam?.label).toBe("Nam Minh (nam)");
    expect(nam?.gender).toBe("nam");
    expect(nam?.kind).toBe("edge");
    const nu = voiceOption("vi-VN-HoaiMyNeural");
    expect(nu?.label).toBe("Hoài My (nữ)");
    expect(nu?.gender).toBe("nữ");
    expect(voiceOption("vi-VN-UnknownNeural")).toBeUndefined();
  });

  it("mọi giọng đều là giọng edge/Edge TTS đã biết", () => {
    for (const voice of EDGE_VOICES) {
      expect(typeof voice.id).toBe("string");
      expect(voice.id.length).toBeGreaterThan(0);
      expect(["nam", "nữ"]).toContain(voice.gender);
      expect(["edge", "chrome"]).toContain(voice.kind);
    }
  });

  it("VOICE_STORAGE_KEY là khóa storage ổn định", () => {
    expect(VOICE_STORAGE_KEY).toBe("dubbingVoiceId");
  });
});
