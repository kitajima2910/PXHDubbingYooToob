import type { SubtitleSegment } from "../../shared/types";
import { mapTranslations } from "../../shared/segments";

interface ApiResponse<T> { ok: boolean; status: number; data?: T; audioBase64?: string; mimeType?: string; message?: string }
export interface CacheContext { videoId: string; sourceLanguage: string }
let cacheAvailable: boolean | undefined;

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

async function cachePost<T>(body: unknown, signal?: AbortSignal): Promise<T | undefined> {
  if (cacheAvailable === false) return undefined;
  try {
    const result = await post<T & { enabled?: boolean }>("/api/cache", body, signal);
    cacheAvailable = result.enabled !== false;
    return cacheAvailable ? result : undefined;
  } catch (error) {
    if (!signal?.aborted) console.warn("PXHDubbingYooToob: bỏ qua cache Neon", error);
    return undefined;
  }
}

export async function translateSegments(segments: SubtitleSegment[], signal?: AbortSignal, cache?: CacheContext): Promise<SubtitleSegment[]> {
  const requested = segments.map(({ id, sourceText }) => ({ id, sourceText }));
  const cached = cache ? await cachePost<{ segments?: Array<{ id: string; translatedText: string }> }>({
    action: "translations:get", ...cache, targetLanguage: "vi", segments: requested,
  }, signal) : undefined;
  const cachedById = new Map((cached?.segments ?? []).map((item) => [item.id, item.translatedText]));
  const missing = segments.filter((segment) => !cachedById.has(segment.id));
  let translatedMissing: SubtitleSegment[] = [];
  if (missing.length) {
    const result = await post<{ segments: Array<{ id: string; translatedText: string }> }>("/api/translate", {
      segments: missing.map(({ id, sourceText }) => ({ id, sourceText })), sourceLanguage: cache?.sourceLanguage ?? "auto", targetLanguage: "vi",
    }, signal);
    translatedMissing = mapTranslations(missing, result.segments);
    if (cache) void cachePost({
      action: "translations:put", ...cache, targetLanguage: "vi",
      segments: translatedMissing.map((segment) => ({ sourceText: segment.sourceText, translatedText: segment.translatedText ?? segment.sourceText })),
    }).catch(() => undefined);
  }
  const translatedById = new Map(translatedMissing.map((segment) => [segment.id, segment.translatedText ?? segment.sourceText]));
  return segments.map((segment) => ({ ...segment, translatedText: cachedById.get(segment.id) ?? translatedById.get(segment.id) ?? segment.sourceText }));
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

export async function transcribeAudio(audioBase64: string, mimeType: string, signal?: AbortSignal): Promise<{ segments: SubtitleSegment[]; source: string; language?: string }> {
  return post<{ segments: SubtitleSegment[]; source: string; language?: string }>("/api/transcribe", { audioBase64, mimeType }, signal);
}

export async function loadCachedTranscript(
  cache: CacheContext,
  fromMs?: number,
  toMs?: number,
  signal?: AbortSignal,
): Promise<{ segments: SubtitleSegment[]; source?: string; complete: boolean } | undefined> {
  return cachePost({ action: "transcript:get", ...cache, fromMs, toMs }, signal);
}

export async function saveCachedTranscript(
  cache: CacheContext,
  source: string,
  segments: SubtitleSegment[],
  complete: boolean,
  signal?: AbortSignal,
): Promise<void> {
  await cachePost({ action: "transcript:put", ...cache, source, segments, complete }, signal);
}
