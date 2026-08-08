export interface VoiceOption {
  id: string;
  label: string;
  gender: "nam" | "nữ";
  kind: "edge" | "chrome";
}

export const EDGE_VOICES: VoiceOption[] = [
  { id: "vi-VN-NamMinhNeural", label: "Nam Minh (nam)", gender: "nam", kind: "edge" },
  { id: "vi-VN-HoaiMyNeural", label: "Hoài My (nữ)", gender: "nữ", kind: "edge" },
];

export const DEFAULT_VOICE_ID = "vi-VN-NamMinhNeural";

export const VOICE_STORAGE_KEY = "dubbingVoiceId";

export function isKnownVoice(id: string): boolean {
  return EDGE_VOICES.some((voice) => voice.id === id);
}

export function voiceOption(id: string): VoiceOption | undefined {
  return EDGE_VOICES.find((voice) => voice.id === id);
}

export function edgeVoiceIds(): string[] {
  return EDGE_VOICES.map((voice) => voice.id);
}
