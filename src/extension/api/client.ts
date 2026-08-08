import type { SubtitleSegment } from "../../shared/types";
import { mapTranslations } from "../../shared/segments";
import { translateWithBrowser } from "../translation/browser-translator";

async function googleTranslate(text: string, signal?: AbortSignal): Promise<string> {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=vi&dt=t&q=${encodeURIComponent(text)}`;
  const response = await fetch(url, { signal: signal ?? null });
  if (!response.ok) throw new Error(`Google Translate HTTP ${response.status}`);
  const data = await response.json() as [[string, string, null, null, number][]];
  const translation = data[0]?.map((item) => item[0]).join("")?.trim();
  if (!translation) throw new Error("Google Translate trả kết quả rỗng");
  return translation;
}

async function translateWithGoogleFallback(segments: SubtitleSegment[], signal?: AbortSignal): Promise<SubtitleSegment[]> {
  const results: SubtitleSegment[] = [];
  for (const segment of segments) {
    try {
      results.push({ ...segment, translatedText: await googleTranslate(segment.sourceText, signal) });
    } catch { /* bỏ qua câu lỗi */ }
  }
  return results;
}
import { runAdaptiveBatchSettled } from "../translation/adaptive-batch";
import { audioCacheKey, getCachedAudio, setCachedAudio } from "../audio/audio-cache";

interface ApiResponse<T> { ok: boolean; status: number; data?: T; audioBase64?: string; mimeType?: string; message?: string }
export interface CacheContext { videoId: string; sourceLanguage: string }
const cacheAvailability: Partial<Record<"transcript" | "translations", boolean>> = {};

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
  const action = (body as { action?: string }).action ?? "";
  const cacheType = action.startsWith("transcript:") ? "transcript" : "translations";
  if (cacheAvailability[cacheType] === false) return undefined;
  try {
    const result = await post<T & { enabled?: boolean }>("/api/cache", body, signal);
    cacheAvailability[cacheType] = result.enabled !== false;
    return cacheAvailability[cacheType] ? result : undefined;
  } catch (error) {
    // silent — cache miss is expected for new videos
    return undefined;
  }
}

// Session-level flags — tránh thử lại các provider đã biết là không hoạt động
let groqDefinitelyDown = false;
let braveTranslatorBroken = false;

export async function translateSegments(segments: SubtitleSegment[], signal?: AbortSignal, cache?: CacheContext): Promise<SubtitleSegment[]> {
  const requested = segments.map(({ id, sourceText }) => ({ id, sourceText }));
  const cached = cache ? await cachePost<{ segments?: Array<{ id: string; translatedText: string }> }>({
    action: "translations:get", sourceLanguage: cache.sourceLanguage, targetLanguage: "vi", segments: requested,
  }, signal) : undefined;
  const cachedById = new Map((cached?.segments ?? []).map((item) => [item.id, item.translatedText]));
  const missing = segments.filter((segment) => !cachedById.has(segment.id));
  let translatedMissing: SubtitleSegment[] = [];
  if (missing.length) {
    let cloudUnavailable = groqDefinitelyDown;
    const cloud = await runAdaptiveBatchSettled(missing, async (batch) => {
      if (cloudUnavailable) throw new Error("Groq đang tạm không khả dụng");
      try {
        const result = await post<{ segments: Array<{ id: string; translatedText: string }> }>("/api/translate", {
          segments: batch.map(({ id, sourceText }) => ({ id, sourceText })), sourceLanguage: cache?.sourceLanguage ?? "auto", targetLanguage: "vi",
        }, signal);
        const expected = new Set(batch.map((segment) => segment.id));
        if (result.segments.length !== batch.length || new Set(result.segments.map((item) => item.id)).size !== batch.length
          || result.segments.some((item) => !expected.has(item.id) || !item.translatedText?.trim())) {
          throw new Error("Groq trả thiếu hoặc sai ánh xạ bản dịch");
        }
        return mapTranslations(batch, result.segments);
      } catch (error) {
        if (batch.length === 1) { cloudUnavailable = true; groqDefinitelyDown = true; }
        throw error;
      }
    });
    if (signal?.aborted) return [];
    translatedMissing = cloud.results;
    if (cloud.failed.length) {
      // Translator API — chỉ thử 1 lần mỗi session
      if (!braveTranslatorBroken) {
        try {
          const local = await translateWithBrowser(cloud.failed);
          translatedMissing.push(...local);
        } catch {
          braveTranslatorBroken = true;
          console.info("PXHDubbingYooToob: Translator API không khả dụng, dùng Google Translate");
        }
      }
      // Google Translate: nhanh, free, không cần chờ cooldown
      const stillFailed = cloud.failed.filter(s => !translatedMissing.some(t => t.id === s.id));
      if (stillFailed.length) {
        console.info(`PXHDubbingYooToob: Google Translate ${stillFailed.length} câu...`);
        const googleTranslated = await translateWithGoogleFallback(stillFailed, signal);
        translatedMissing.push(...googleTranslated);
      }
    }
    if (cache) void cachePost({
      action: "translations:put", sourceLanguage: cache.sourceLanguage, targetLanguage: "vi",
      segments: translatedMissing.map((segment) => ({ sourceText: segment.sourceText, translatedText: segment.translatedText ?? segment.sourceText })),
    }).catch(() => undefined);
  }
  const translatedById = new Map(translatedMissing.map((segment) => [segment.id, segment.translatedText ?? segment.sourceText]));
  return segments.flatMap((segment) => {
    const translatedText = cachedById.get(segment.id) ?? translatedById.get(segment.id);
    return translatedText ? [{ ...segment, translatedText }] : [];
  });
}

export async function createSpeech(text: string, rate: number, signal?: AbortSignal, voice = "vi-VN-NamMinhNeural"): Promise<Blob> {
  const requestId = crypto.randomUUID();
  const onAbort = (): void => { void chrome.runtime.sendMessage({ action: "api-cancel", requestId }); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    // Cache audio IndexedDB: replay cùng text + voice + rate không gọi lại /api/tts.
    const cacheKey = await audioCacheKey(text, voice, rate);
    const cached = await getCachedAudio(cacheKey);
    if (cached) return cached;
    const response = await chrome.runtime.sendMessage({
      action: "api-request", requestId, path: "/api/tts", responseType: "audio",
      body: { text, voice, rate },
    }) as ApiResponse<never>;
    if (!response.ok || !response.audioBase64) throw new Error(response.message ?? "Không thể tạo giọng nói");
    const binary = atob(response.audioBase64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const blob = new Blob([bytes], { type: response.mimeType ?? "audio/mpeg" });
    void setCachedAudio(cacheKey, blob).catch(() => undefined);
    return blob;
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
): Promise<{ segments: SubtitleSegment[]; source?: string; complete: boolean; covered?: boolean } | undefined> {
  return cachePost({ action: "transcript:get", ...cache, fromMs, toMs }, signal);
}

export async function saveCachedTranscript(
  cache: CacheContext,
  source: string,
  segments: SubtitleSegment[],
  complete: boolean,
  signal?: AbortSignal,
  window?: { fromMs: number; toMs: number },
): Promise<void> {
  await cachePost({ action: "transcript:put", ...cache, source, segments, complete, ...(window ? { window } : {}) }, signal);
}
