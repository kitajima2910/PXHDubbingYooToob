import type { SubtitleSegment } from "../../shared/types";
import { mapTranslations } from "../../shared/segments";

interface ApiResponse<T> { ok: boolean; status: number; data?: T; audioBase64?: string; mimeType?: string; message?: string }

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const requestId = crypto.randomUUID();
  const onAbort = (): void => { void chrome.runtime.sendMessage({ action: "api-cancel", requestId }); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await chrome.runtime.sendMessage({ action: "api-request", requestId, path, body, responseType: "json" }) as ApiResponse<T>;
    if (!response.ok || response.data === undefined) throw new Error(response.message ?? "Dịch vụ không phản hồi");
    return response.data;
  } finally { signal?.removeEventListener("abort", onAbort); }
}

export async function translateSegments(segments: SubtitleSegment[], signal?: AbortSignal): Promise<SubtitleSegment[]> {
  const result = await post<{ segments: Array<{ id: string; translatedText: string }> }>("/api/translate", {
    segments: segments.map(({ id, sourceText }) => ({ id, sourceText })), sourceLanguage: "auto", targetLanguage: "vi",
  }, signal);
  return mapTranslations(segments, result.segments);
}

export async function createSpeech(text: string, rate: number, signal?: AbortSignal): Promise<Blob> {
  const requestId = crypto.randomUUID();
  const onAbort = (): void => { void chrome.runtime.sendMessage({ action: "api-cancel", requestId }); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await chrome.runtime.sendMessage({
      action: "api-request", requestId, path: "/api/tts", responseType: "audio",
      body: { text, voice: "vi-VN-HoaiMyNeural", rate },
    }) as ApiResponse<never>;
    if (!response.ok || !response.audioBase64) throw new Error(response.message ?? "Không thể tạo giọng nói");
    const binary = atob(response.audioBase64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new Blob([bytes], { type: response.mimeType ?? "audio/mpeg" });
  } finally { signal?.removeEventListener("abort", onAbort); }
}

export async function loadBackendCaptions(videoId: string, fromMs: number, toMs: number, signal?: AbortSignal): Promise<{ segments: SubtitleSegment[]; source: string }> {
  return post<{ segments: SubtitleSegment[]; source: string }>("/api/subtitles/youtube", { videoId, fromMs, toMs }, signal);
}
