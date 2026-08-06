import type { SubtitleSegment } from "../../shared/types";
import { mapTranslations } from "../../shared/segments";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: "Dịch vụ không phản hồi" } })) as { error?: { message?: string } };
    throw new Error(error.error?.message ?? "Dịch vụ không phản hồi");
  }
  return response.json() as Promise<T>;
}

export async function translateSegments(segments: SubtitleSegment[], signal?: AbortSignal): Promise<SubtitleSegment[]> {
  const result = await post<{ segments: Array<{ id: string; translatedText: string }> }>("/api/translate", {
    segments: segments.map(({ id, sourceText }) => ({ id, sourceText })), sourceLanguage: "auto", targetLanguage: "vi",
  }, signal);
  return mapTranslations(segments, result.segments);
}

export async function createSpeech(text: string, rate: number, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`${API_BASE_URL}/api/tts`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, voice: "vi-VN-HoaiMyNeural", rate }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error("Không thể tạo giọng nói");
  return response.blob();
}

export async function loadBackendCaptions(videoId: string, fromMs: number, toMs: number, signal?: AbortSignal): Promise<{ segments: SubtitleSegment[]; source: string }> {
  return post<{ segments: SubtitleSegment[]; source: string }>("/api/subtitles/youtube", { videoId, fromMs, toMs }, signal);
}
