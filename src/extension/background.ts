import { YoutubeTranscript } from "youtube-transcript";
import { parseYouTubeTrainingTarget } from "./training/youtube-url";
import { runAdaptiveBatch } from "./training/adaptive-batch";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";
const allowedPaths = new Set(["/api/subtitles/youtube", "/api/translate", "/api/tts", "/api/transcribe", "/api/cache"]);
const requests = new Map<string, AbortController>();

interface PlaylistTrainingResult { total: number; trained: number; skipped: number; segments: number; failedVideoIds: string[] }
interface TrainingAudioChunk { audioBase64: string; mimeType: string; durationMs: number }
let playlistTrainingJob: Promise<void> | undefined;
let playlistTrainingCancelled = false;
let playlistTrainingController: AbortController | undefined;
let playlistTrainingTabId: number | undefined;
let playlistTrainingWindowId: number | undefined;

let trainingAudioCapture: { tabId: number; chunks: TrainingAudioChunk[]; notify: (() => void) | undefined } | undefined;

async function resetInterruptedTraining(): Promise<void> {
  const stored = (await chrome.storage.local.get("playlistTraining")).playlistTraining as { running?: boolean } | undefined;
  if (stored?.running) {
    await chrome.storage.local.set({ playlistTraining: { running: false, message: "Job cũ đã bị gián đoạn — có thể Train lại" } });
  }
}
chrome.runtime.onInstalled.addListener(() => { void resetInterruptedTraining(); });
chrome.runtime.onStartup.addListener(() => { void resetInterruptedTraining(); });
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "playlist-training-keepalive") return;
  port.onMessage.addListener(() => { /* Port traffic keeps the MV3 worker alive during long videos. */ });
});

async function postTrainingApi(path: "/api/cache" | "/api/translate" | "/api/transcribe", body: unknown, signal?: AbortSignal): Promise<any> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${API_BASE_URL}${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...(signal ? { signal } : {}),
      });
      if (response.ok) return response.json();
      const payload = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
      lastError = new Error(payload?.error?.message ?? `Backend trả lỗi ${response.status}`);
      if (response.status < 500 && response.status !== 429) throw lastError;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Không thể kết nối backend");
    }
    if (signal?.aborted) throw new DOMException("Job train đã dừng", "AbortError");
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
  }
  throw lastError ?? new Error("Backend không phản hồi");
}

async function translateTrainingBatch(body: unknown, signal: AbortSignal): Promise<{ segments: Array<{ id: string; translatedText: string }> }> {
  const requested = (body as { segments?: Array<{ id: string }> } | null)?.segments ?? [];
  const validate = (result: { segments?: Array<{ id: string; translatedText: string }> }): { segments: Array<{ id: string; translatedText: string }> } => {
    const expected = new Set(requested.map((item) => item.id));
    const returned = new Set((result.segments ?? []).map((item) => item.id));
    if (!requested.length || result.segments?.length !== requested.length || returned.size !== requested.length
      || result.segments.some((item) => !expected.has(item.id) || !item.translatedText?.trim())) {
      throw new Error("Groq trả thiếu hoặc sai ánh xạ bản dịch");
    }
    return { segments: result.segments };
  };
  const stored = await chrome.storage.local.get("groqApiKey");
  const customKey = typeof stored.groqApiKey === "string" ? stored.groqApiKey.trim() : "";
  if (customKey) {
    const direct = await requestGroqDirect("/api/translate", body, customKey, signal);
    if (direct.ok) return validate(direct.data as { segments?: Array<{ id: string; translatedText: string }> });
    const quotaFailure = direct.status === 429 || /quota|rate.?limit|limit reached|blocked_api_access/i.test(direct.message ?? "");
    if (!quotaFailure) throw new Error(direct.message ?? "Groq không thể dịch batch playlist");
  }
  return validate(await postTrainingApi("/api/translate", body, signal));
}

async function transcribeTrainingChunk(chunk: TrainingAudioChunk, signal: AbortSignal): Promise<{ segments: BackgroundSegment[] }> {
  const body = { audioBase64: chunk.audioBase64, mimeType: chunk.mimeType };
  const stored = await chrome.storage.local.get("groqApiKey");
  const customKey = typeof stored.groqApiKey === "string" ? stored.groqApiKey.trim() : "";
  if (customKey) {
    const direct = await requestGroqDirect("/api/transcribe", body, customKey, signal);
    if (direct.ok) return direct.data as { segments: BackgroundSegment[] };
    const quotaFailure = direct.status === 429 || /quota|rate.?limit|limit reached|blocked_api_access/i.test(direct.message ?? "");
    if (!quotaFailure) throw new Error(direct.message ?? "Groq không thể nhận dạng audio train");
  }
  return postTrainingApi("/api/transcribe", body, signal);
}

async function playlistVideoIds(value: string): Promise<string[]> {
  const target = parseYouTubeTrainingTarget(value);
  if (target.kind === "video") return target.videoIds;
  const response = await fetch(target.url);
  if (!response.ok) throw new Error(`YouTube trả lỗi ${response.status}`);
  const html = await response.text();
  const ids = [...html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)].map((match) => match[1]!);
  const current = new URL(target.url).searchParams.get("v");
  if (current && /^[A-Za-z0-9_-]{11}$/.test(current)) ids.unshift(current);
  const unique = [...new Set(ids)].slice(0, 100);
  if (!unique.length) throw new Error("Không tìm thấy video công khai trong playlist");
  return unique;
}

async function waitForTrainingContent(tabId: number, videoId: string, signal: AbortSignal): Promise<void> {
  let lastMessageError: unknown;
  let injectionError: unknown;
  let injected = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (signal.aborted) throw new DOMException("Job train đã dừng", "AbortError");
    try {
      const ready = await chrome.tabs.sendMessage(tabId, { action: "training-ready" }) as { ok?: boolean; videoId?: string };
      if (ready?.ok && ready.videoId === videoId) return;
    } catch (error) { lastMessageError = error; }
    if (!injected && attempt >= 8) {
      injected = true;
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["page-bridge.js"], world: "MAIN" });
        await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"], world: "ISOLATED" });
      } catch (error) { injectionError = error; }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const messageDetail = lastMessageError instanceof Error ? lastMessageError.message : "không có listener";
  const injectionDetail = injectionError instanceof Error ? `; inject: ${injectionError.message}` : "";
  throw new Error(`Content script trainer chưa sẵn sàng sau 15 giây: ${messageDetail}${injectionDetail}`);
}

async function waitForTrainingPage(tabId: number, videoId: string, signal: AbortSignal): Promise<void> {
  let lastUrl = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (signal.aborted) throw new DOMException("Job train đã dừng", "AbortError");
    const current = await chrome.tabs.get(tabId);
    lastUrl = current.url ?? current.pendingUrl ?? "";
    let currentVideoId = "";
    try { currentVideoId = new URL(lastUrl).searchParams.get("v") ?? ""; } catch { /* Initial about:blank. */ }
    if (current.status === "complete" && currentVideoId === videoId) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`YouTube chưa tải đúng video ${videoId} sau 25 giây (URL hiện tại: ${lastUrl || "trống"})`);
}

async function loadTrainingTranscript(videoId: string, signal: AbortSignal): Promise<BackgroundSegment[]> {
  const trainingUrl = `https://www.youtube.com/watch?v=${videoId}&autoplay=0`;
  let tab: chrome.tabs.Tab;
  if (playlistTrainingTabId === undefined) {
    const workerWindow = await chrome.windows.create({ url: trainingUrl, focused: false, state: "minimized", type: "popup" });
    const workerTab = workerWindow?.tabs?.[0];
    if (!workerWindow || !workerTab || workerTab.id === undefined || workerWindow.id === undefined) throw new Error("Không thể mở worker train nền");
    tab = workerTab;
    playlistTrainingTabId = tab.id;
    playlistTrainingWindowId = workerWindow.id;
    await chrome.tabs.update(tab.id, { muted: true });
  } else {
    const updatedTab = await chrome.tabs.update(playlistTrainingTabId, { url: trainingUrl, active: true });
    if (!updatedTab) throw new Error("Không thể chuyển worker sang video kế tiếp");
    tab = updatedTab;
    await chrome.tabs.update(playlistTrainingTabId, { muted: true });
  }
  if (tab.id === undefined) throw new Error("Không xác định được tab train nền");
  await waitForTrainingPage(tab.id, videoId, signal);
  await waitForTrainingContent(tab.id, videoId, signal);
  const response = await chrome.tabs.sendMessage(tab.id, { action: "training-transcript" }) as { segments?: BackgroundSegment[]; message?: string };
  if (!response?.segments?.length) throw new Error(response?.message ?? "Transcript rỗng");
  return response.segments;
}

function waitForTrainingChunk(capture: NonNullable<typeof trainingAudioCapture>, signal: AbortSignal): Promise<TrainingAudioChunk> {
  const queued = capture.chunks.shift();
  if (queued) return Promise.resolve(queued);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { capture.notify = undefined; reject(new Error("Không nhận được audio từ video trong 12 giây")); }, 12_000);
    const abort = (): void => { clearTimeout(timer); capture.notify = undefined; reject(new DOMException("Job train đã dừng", "AbortError")); };
    capture.notify = () => {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      capture.notify = undefined;
      const chunk = capture.chunks.shift();
      if (chunk) resolve(chunk); else reject(new Error("Audio train rỗng"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function whisperTrainingTranscript(videoId: string, signal: AbortSignal): Promise<BackgroundSegment[]> {
  const tabId = playlistTrainingTabId;
  if (tabId === undefined) throw new Error("Worker train không còn hoạt động");
  const progressStorage = await chrome.storage.local.get("playlistTrainingWhisperProgress");
  const progress = (progressStorage.playlistTrainingWhisperProgress ?? {}) as Record<string, number>;
  let capturedUntilMs = Math.max(0, Number(progress[videoId] ?? 0));
  const cached = await postTrainingApi("/api/cache", {
    action: "transcript:get", videoId, sourceLanguage: "auto",
  }, signal) as { segments?: BackgroundSegment[]; complete?: boolean };
  if (cached.complete && cached.segments?.length) return cached.segments;
  trainingAudioCapture = { tabId, chunks: [], notify: undefined };
  const allSegments: BackgroundSegment[] = [...(cached.segments ?? [])];
  let completed = false;
  try {
    const started = await chrome.tabs.sendMessage(tabId, { action: "training-playback-start", startMs: capturedUntilMs }) as { ok?: boolean; message?: string; durationMs?: number };
    if (!started?.ok) throw new Error(started?.message ?? "Không thể phát video để nhận dạng audio");
    while (!signal.aborted) {
      const chunk = await waitForTrainingChunk(trainingAudioCapture, signal);
      const fromMs = capturedUntilMs;
      const toMs = fromMs + Math.max(500, chunk.durationMs);
      const result = await transcribeTrainingChunk(chunk, signal);
      const timed = (result.segments ?? []).map((segment, index) => ({
        ...segment, id: `train-whisper-${fromMs}-${index}`,
        startMs: fromMs + segment.startMs, endMs: fromMs + Math.max(segment.startMs + 500, segment.endMs),
      }));
      await postTrainingApi("/api/cache", {
        action: "transcript:put", videoId, sourceLanguage: "auto", source: "Playlist trainer — Groq Whisper",
        complete: false, segments: timed, window: { fromMs, toMs },
      }, signal);
      allSegments.push(...timed);
      capturedUntilMs = toMs;
      progress[videoId] = capturedUntilMs;
      await chrome.storage.local.set({ playlistTrainingWhisperProgress: progress });
      await chrome.storage.local.set({ playlistTraining: { running: true, updatedAt: Date.now(), message: `Whisper ${videoId}: ${Math.round(capturedUntilMs / 1000)} giây` } });
      const playback = await chrome.tabs.sendMessage(tabId, { action: "training-playback-status" }) as { ended?: boolean; currentMs?: number };
      const durationReached = typeof started.durationMs === "number" && started.durationMs > 0 && capturedUntilMs >= started.durationMs - 750;
      if (durationReached || playback?.ended || (typeof playback?.currentMs === "number" && playback.currentMs + 1_000 < capturedUntilMs)) { completed = true; break; }
    }
  } finally {
    trainingAudioCapture = undefined;
    await chrome.tabs.sendMessage(tabId, { action: "training-playback-stop" }).catch(() => undefined);
  }
  if (completed) {
    delete progress[videoId];
    await chrome.storage.local.set({ playlistTrainingWhisperProgress: progress });
  }
  return mergeTranscriptSegments(allSegments);
}

async function loadTrainingTranscriptWithFallback(videoId: string, signal: AbortSignal): Promise<BackgroundSegment[]> {
  let transcriptError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await loadTrainingTranscript(videoId, signal); }
    catch (error) {
      transcriptError = error;
      if (signal.aborted) throw error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  try { return await whisperTrainingTranscript(videoId, signal); }
  catch (whisperError) {
    const transcriptMessage = transcriptError instanceof Error ? transcriptError.message : "không lấy được transcript";
    const whisperMessage = whisperError instanceof Error ? whisperError.message : "Whisper thất bại";
    throw new Error(`Transcript: ${transcriptMessage}; fallback Whisper: ${whisperMessage}`);
  }
}

async function closeTrainingWindow(): Promise<void> {
  const windowId = playlistTrainingWindowId;
  playlistTrainingWindowId = undefined;
  playlistTrainingTabId = undefined;
  if (windowId !== undefined) await chrome.windows.remove(windowId).catch(() => undefined);
}

async function notifyTraining(title: string, message: string): Promise<void> {
  await chrome.notifications.create({
    type: "basic", iconUrl: chrome.runtime.getURL("icons/pxh-128.png"), title, message,
  });
}

async function trainPlaylist(value: string, signal: AbortSignal): Promise<PlaylistTrainingResult> {
  const videoIds = await playlistVideoIds(value);
  const result: PlaylistTrainingResult = { total: videoIds.length, trained: 0, skipped: 0, segments: 0, failedVideoIds: [] };
  await chrome.storage.local.set({ playlistTraining: { ...result, running: true, message: "Đang đọc video/playlist" } });
  for (const [videoIndex, videoId] of videoIds.entries()) {
    if (playlistTrainingCancelled) throw new Error("Job train đã được hủy");
    try {
      const segments = (await loadTrainingTranscriptWithFallback(videoId, signal)).slice(0, 2_000);
      if (!segments.length) throw new Error("Transcript rỗng");
      await chrome.storage.local.set({ playlistTraining: { ...result, running: true, updatedAt: Date.now(), message: `Đã đọc xong ${videoId} — đang lưu transcript` } });
      await postTrainingApi("/api/cache", {
        action: "transcript:put", videoId, sourceLanguage: "auto", source: "Playlist trainer", complete: true, segments,
      }, signal);
      for (let index = 0; index < segments.length; index += 20) {
        const batch = segments.slice(index, index + 20);
        await chrome.storage.local.set({ playlistTraining: {
          ...result, running: true, updatedAt: Date.now(),
          message: `Đang dịch ${videoId}: ${Math.min(index + batch.length, segments.length)}/${segments.length} câu`,
        } });
        const cached = await postTrainingApi("/api/cache", {
          action: "translations:get", sourceLanguage: "auto", targetLanguage: "vi",
          segments: batch.map(({ id, sourceText }) => ({ id, sourceText })),
        }, signal) as { segments?: Array<{ id: string; translatedText: string }> };
        const hitIds = new Set((cached.segments ?? []).map((item) => item.id));
        const missing = batch.filter((item) => !hitIds.has(item.id));
        if (missing.length) {
          const sourceById = new Map(missing.map((item) => [item.id, item.sourceText]));
          await runAdaptiveBatch(missing, async (translationBatch) => {
            const translated = await translateTrainingBatch({
              sourceLanguage: "auto", targetLanguage: "vi",
              segments: translationBatch.map(({ id, sourceText }) => ({ id, sourceText })),
            }, signal);
            await postTrainingApi("/api/cache", {
              action: "translations:put", sourceLanguage: "auto", targetLanguage: "vi",
              segments: translated.segments.map((item) => ({ sourceText: sourceById.get(item.id), translatedText: item.translatedText })),
            }, signal);
            return translated.segments;
          });
        }
      }
      result.trained += 1; result.segments += segments.length;
    } catch (error) {
      console.info(`PXHDubbingYooToob: chưa train được video ${videoId}`, error instanceof Error ? error.message : error);
      result.skipped += 1;
      result.failedVideoIds.push(videoId);
    }
    await chrome.storage.local.set({ playlistTraining: { ...result, running: true, message: `Đã xử lý ${videoIndex + 1}/${videoIds.length} video` } });
  }
  const failedSuffix = result.failedVideoIds.length ? ` — thử lại: ${result.failedVideoIds.slice(0, 4).join(", ")}${result.failedVideoIds.length > 4 ? "…" : ""}` : "";
  await chrome.storage.local.set({ playlistTraining: { ...result, running: false, message: `Hoàn tất ${result.trained}/${result.total} video${failedSuffix}` } });
  await notifyTraining("PXH Dubbing — Train hoàn tất", `Đã train ${result.trained}/${result.total} video, bỏ qua ${result.skipped}.`);
  return result;
}

function startPlaylistTraining(value: string): void {
  if (playlistTrainingJob) return;
  playlistTrainingCancelled = false;
  playlistTrainingController = new AbortController();
  const signal = playlistTrainingController.signal;
  playlistTrainingJob = chrome.storage.local.set({ playlistTraining: { running: true, message: "Đang khởi tạo video/playlist" } })
    .then(() => trainPlaylist(value, signal)).then(() => undefined, async (error: unknown) => {
    const message = error instanceof Error ? error.message : "Không thể train video/playlist";
    if (signal.aborted) {
      await chrome.storage.local.set({ playlistTraining: { running: false, message: "Đã dừng Train" } });
      return;
    }
    await chrome.storage.local.set({ playlistTraining: { running: false, message } });
    await notifyTraining("PXH Dubbing — Train thất bại", message);
  }).finally(async () => {
    await closeTrainingWindow();
    playlistTrainingJob = undefined; playlistTrainingController = undefined;
  });
}

let creatingOffscreen: Promise<void> | undefined;
async function ensureOffscreenDocument(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (contexts.length) return;
  creatingOffscreen ??= chrome.offscreen.createDocument({
    url: "offscreen.html", reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.WORKERS],
    justification: "Tải Whisper local và thu âm tab YouTube khi video không có phụ đề",
  }).finally(() => { creatingOffscreen = undefined; });
  await creatingOffscreen;
}

async function startTabCapture(tabId: number, sourceVolume: number, grantedStreamId?: string): Promise<void> {
  await ensureOffscreenDocument();
  const streamId = grantedStreamId ?? await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const response = await chrome.runtime.sendMessage({ action: "capture-offscreen-start", streamId, tabId, sourceVolume }) as { ok?: boolean; message?: string };
  if (!response?.ok) throw new Error(response?.message ?? "Không thể bắt đầu thu âm tab");
}

async function ensureTabCapture(tabId: number, sourceVolume: number, grantedStreamId?: string): Promise<void> {
  await ensureOffscreenDocument();
  const status = await chrome.runtime.sendMessage({ action: "capture-offscreen-status" }) as { active?: boolean; tabId?: number } | undefined;
  if (status?.active && status.tabId === tabId) {
    await chrome.runtime.sendMessage({ action: "capture-offscreen-volume", sourceVolume });
    return;
  }
  await startTabCapture(tabId, sourceVolume, grantedStreamId);
}

async function stopTabCapture(): Promise<void> {
  await chrome.runtime.sendMessage({ action: "capture-offscreen-stop" }).catch(() => undefined);
}

function requestKey(sender: chrome.runtime.MessageSender, requestId: string): string {
  return `${sender.tab?.id ?? "extension"}:${requestId}`;
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

interface DirectApiResult { ok: boolean; status: number; data?: unknown; message?: string; retryAfterMs?: number }

function retryAfterMs(value: string | null): number {
  if (!value) return 5 * 60_000;
  const seconds = Number(value);
  const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Math.min(24 * 60 * 60_000, Math.max(30_000, Number.isFinite(duration) ? duration : 5 * 60_000));
}

async function groqError(response: Response): Promise<DirectApiResult> {
  const payload = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
  return {
    ok: false, status: response.status,
    message: payload?.error?.message ?? `Groq trả lỗi ${response.status}`,
    retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
  };
}

async function requestGroqDirect(path: string, body: unknown, apiKey: string, signal: AbortSignal): Promise<DirectApiResult> {
  if (path === "/api/translate") {
    const input = body as { segments?: Array<{ id: string; sourceText: string }> } | null;
    if (!input?.segments?.length) return { ok: false, status: 400, message: "Dữ liệu dịch không hợp lệ" };
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST", signal,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile", temperature: 0.2, response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Dịch tự nhiên sang tiếng Việt để đọc lồng tiếng. Giữ nguyên id, tên riêng, thuật ngữ và số liệu; viết ngắn gọn; không giải thích. Trả JSON dạng {\"segments\":[{\"id\":\"...\",\"translatedText\":\"...\"}]}" },
          { role: "user", content: JSON.stringify({ segments: input.segments }) },
        ],
      }),
    });
    if (!response.ok) return groqError(response);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const parsed = JSON.parse(payload.choices?.[0]?.message?.content ?? "{}") as { segments?: Array<{ id: string; translatedText: string }> };
    if (!Array.isArray(parsed.segments)) return { ok: false, status: 502, message: "Kết quả dịch Groq không hợp lệ" };
    return { ok: true, status: 200, data: { segments: parsed.segments } };
  }
  if (path === "/api/transcribe") {
    const input = body as { audioBase64?: string; mimeType?: string } | null;
    if (!input?.audioBase64 || !input.mimeType) return { ok: false, status: 400, message: "Dữ liệu audio không hợp lệ" };
    const form = new FormData();
    const audioBytes = base64ToBytes(input.audioBase64);
    const audioBuffer = audioBytes.buffer.slice(audioBytes.byteOffset, audioBytes.byteOffset + audioBytes.byteLength) as ArrayBuffer;
    form.append("file", new Blob([audioBuffer], { type: input.mimeType }), "chunk.webm");
    form.append("model", "whisper-large-v3-turbo");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    form.append("temperature", "0");
    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST", signal, headers: { authorization: `Bearer ${apiKey}` }, body: form,
    });
    if (!response.ok) return groqError(response);
    const payload = await response.json() as { text?: string; language?: string; segments?: Array<{ start?: number; end?: number; text?: string }> };
    const segments = (payload.segments ?? []).flatMap((segment, index) => {
      const sourceText = segment.text?.replace(/\s+/g, " ").trim();
      if (!sourceText) return [];
      return [{ id: `whisper-${index}`, startMs: Math.max(0, Math.round((segment.start ?? 0) * 1000)), endMs: Math.max(500, Math.round((segment.end ?? 0) * 1000)), sourceText }];
    });
    if (!segments.length && payload.text?.trim()) segments.push({ id: "whisper-0", startMs: 0, endMs: 5_000, sourceText: payload.text.trim() });
    return { ok: true, status: 200, data: { segments, source: "Groq Whisper (API key riêng)", language: payload.language ?? "" } };
  }
  return { ok: false, status: 400, message: "Endpoint Groq không được hỗ trợ" };
}

interface BackgroundSegment { id: string; startMs: number; endMs: number; sourceText: string }

function mergeTranscriptSegments(segments: BackgroundSegment[]): BackgroundSegment[] {
  const merged: BackgroundSegment[] = [];
  let group: BackgroundSegment[] = [];
  const flush = (nextStartMs?: number): void => {
    const first = group[0]; const last = group[group.length - 1];
    if (!first || !last) return;
    merged.push({
      id: `merged-${first.id}-${last.id}`,
      startMs: first.startMs,
      endMs: Math.max(first.startMs + 500, nextStartMs ?? Math.max(...group.map((item) => item.endMs))),
      sourceText: group.map((item) => item.sourceText.trim()).filter(Boolean).join(" ").replace(/\s+/g, " "),
    });
    group = [];
  };
  const sorted = [...segments].sort((left, right) => left.startMs - right.startMs);
  for (let index = 0; index < sorted.length; index += 1) {
    const segment = sorted[index]!; const next = sorted[index + 1];
    group.push(segment);
    const first = group[0]!;
    const textLength = group.reduce((total, item) => total + item.sourceText.length + 1, 0);
    const largeGap = next ? next.startMs - segment.startMs > 3_500 : true;
    const targetReached = next ? next.startMs - first.startMs >= 6_000 : true;
    const hardSpanReached = next ? next.startMs - first.startMs >= 10_000 : true;
    if (!next || largeGap || hardSpanReached || textLength >= 180 || (targetReached && /[.!?,;:]\s*$/.test(segment.sourceText))) flush(next?.startMs);
  }
  return merged.filter((item) => item.sourceText.length > 0);
}

async function loadYouTubeSubtitles(body: unknown, signal: AbortSignal): Promise<unknown> {
  const input = body as { videoId?: string; fromMs?: number; toMs?: number } | null;
  if (!input?.videoId || !/^[A-Za-z0-9_-]{11}$/.test(input.videoId)
    || typeof input.fromMs !== "number" || typeof input.toMs !== "number"
    || input.fromMs < 0 || input.toMs <= input.fromMs || input.toMs - input.fromMs > 120_000) {
    throw new Error("Khoảng phụ đề yêu cầu không hợp lệ");
  }
  const fetchWithSignal: typeof globalThis.fetch = (url, init) => globalThis.fetch(url, { ...init, signal });
  let transcript;
  try {
    transcript = await YoutubeTranscript.fetchTranscript(input.videoId, { fetch: fetchWithSignal });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/transcript is disabled|transcript disabled|subtitles are disabled/i.test(message)) {
      throw new Error("Video này đã tắt phụ đề; cần nhận dạng âm thanh bằng Whisper");
    }
    throw error;
  }
  const durations = transcript.map((item) => item.duration).filter((duration) => Number.isFinite(duration) && duration > 0).sort((left, right) => left - right);
  const medianDuration = durations[Math.floor(durations.length / 2)] ?? 0;
  const detectedScale = medianDuration > 0 && medianDuration < 100 ? 1_000 : 1;
  const normalize = (scale: number): BackgroundSegment[] => mergeTranscriptSegments(transcript.flatMap((item, index) => {
    const sourceText = item.text.replace(/\s+/g, " ").trim();
    if (!sourceText) return [];
    const startMs = Math.round(item.offset * scale);
    return [{ id: `${startMs}-${index}`, startMs, endMs: startMs + Math.max(200, Math.round(item.duration * scale)), sourceText }];
  })).filter((item) => item.endMs >= input.fromMs! && item.startMs <= input.toMs!);
  let segments = normalize(detectedScale);
  if (!segments.length) segments = normalize(detectedScale === 1 ? 1_000 : 1);
  if (!segments.length) throw new Error("Không tìm thấy phụ đề trong khoảng đang phát");
  return { segments, source: "YouTube" };
}

chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  const request = message as { action?: string; requestId?: string; path?: string; body?: unknown; responseType?: "json" | "audio"; tabId?: number; streamId?: string; sourceVolume?: number; audioBase64?: string; mimeType?: string; durationMs?: number; capturedAt?: number; text?: string; rate?: number; type?: string; progress?: number; segments?: BackgroundSegment[]; message?: string; active?: boolean } | null;
  if (request?.action === "local-model-init") {
    const tabId = sender.tab?.id ?? request.tabId;
    void ensureOffscreenDocument()
      .then(() => chrome.runtime.sendMessage({ action: "capture-offscreen-model-init", tabId }))
      .then(respond, (error: unknown) => respond({ ok: false, message: error instanceof Error ? error.message : "Không khởi tạo được Whisper local" }));
    return true;
  }
  if (request?.action === "local-model-status") {
    void ensureOffscreenDocument()
      .then(() => chrome.runtime.sendMessage({ action: "capture-offscreen-model-status" }))
      .then(respond, (error: unknown) => respond({ ok: false, message: error instanceof Error ? error.message : "Không đọc được trạng thái Whisper local" }));
    return true;
  }
  if (request?.action === "local-model-event" && request.tabId !== undefined) {
    void chrome.tabs.sendMessage(request.tabId, {
      action: "local-model-event", type: request.type, progress: request.progress, message: request.message,
    }).catch(() => undefined);
    respond({ ok: true }); return;
  }
  if (request?.action === "capture-local-chunk" && request.tabId !== undefined) {
    void chrome.tabs.sendMessage(request.tabId, {
      action: "whisper-local-chunk", durationMs: request.durationMs, capturedAt: request.capturedAt, segments: request.segments ?? [],
    }).catch(() => undefined);
    respond({ ok: true }); return;
  }
  if (request?.action === "capture-local-error" && request.tabId !== undefined) {
    void chrome.tabs.sendMessage(request.tabId, { action: "whisper-local-error", message: request.message }).catch(() => undefined);
    respond({ ok: true }); return;
  }
  if (request?.action === "capture-local-backpressure" && request.tabId !== undefined) {
    void chrome.tabs.sendMessage(request.tabId, { action: "whisper-local-backpressure", active: request.active === true }).catch(() => undefined);
    respond({ ok: true }); return;
  }
  if (request?.action === "playlist-train-reset") {
    playlistTrainingCancelled = true;
    playlistTrainingController?.abort();
    void closeTrainingWindow();
    void chrome.storage.local.set({ playlistTraining: { running: false, message: "Đã dừng Train" } })
      .then(() => respond({ ok: true }));
    return true;
  }
  if (request?.action === "playlist-train" && typeof request.body === "string") {
    startPlaylistTraining(request.body);
    respond({ ok: true, started: true });
    return;
  }
  if (request?.action === "capture-start") {
    const targetTabId = sender.tab?.id ?? request.tabId;
    if (targetTabId === undefined) { respond({ ok: false, message: "Không xác định được tab YouTube" }); return; }
    const sourceVolume = request.sourceVolume ?? 0.08;
    void ensureTabCapture(targetTabId, sourceVolume, request.streamId).then(() => respond({ ok: true }), (error: unknown) => respond({ ok: false, message: error instanceof Error ? error.message : "Không thể thu âm tab" }));
    return true;
  }
  if (request?.action === "capture-stop") {
    void stopTabCapture().then(() => respond({ ok: true }));
    return true;
  }
  if (request?.action === "capture-volume") {
    void chrome.runtime.sendMessage({ action: "capture-offscreen-volume", sourceVolume: request.sourceVolume ?? 1 })
      .then((result) => respond(result), () => respond({ ok: false }));
    return true;
  }
  if (request?.action === "capture-reset") {
    void chrome.runtime.sendMessage({ action: "capture-offscreen-reset" }).then(() => respond({ ok: true }), () => respond({ ok: false }));
    return true;
  }
  if (request?.action === "tts-status") {
    chrome.tts.getVoices((voices) => respond({ ok: true, available: voices.some((voice) =>
      voice.lang?.toLocaleLowerCase().startsWith("vi") === true) }));
    return true;
  }
  if (request?.action === "tts-speak" && request.text) {
    chrome.tts.getVoices((voices) => {
      const vietnamese = voices.filter((item) => item.lang?.toLocaleLowerCase().startsWith("vi") === true).sort((left, right) => {
        const leftName = left.voiceName?.toLocaleLowerCase() ?? "";
        const rightName = right.voiceName?.toLocaleLowerCase() ?? "";
        const preferred = (name: string): boolean => name.includes("namminh") || name.includes("nam minh") || /\b(?:male|nam)\b/.test(name);
        return Number(!preferred(leftName)) - Number(!preferred(rightName));
      });
      if (!vietnamese.length) { respond({ ok: false, message: "Máy chưa có giọng tiếng Việt" }); return; }
      const attempt = (index: number): void => {
        const voice = vietnamese[index];
        if (!voice) { respond({ ok: false, message: "Tất cả giọng Chrome tiếng Việt đều lỗi" }); return; }
        chrome.tts.speak(request.text!, {
          lang: voice.lang ?? "vi-VN", ...(voice.voiceName ? { voiceName: voice.voiceName } : {}),
          rate: Math.max(0.5, Math.min(2, request.rate ?? 1)), volume: 1,
          onEvent: (event) => {
            if (event.type === "end") respond({ ok: true, voice: voice.voiceName });
            else if (event.type === "error" && index + 1 < vietnamese.length) attempt(index + 1);
            else if (["error", "cancelled", "interrupted"].includes(event.type)) respond({ ok: false, message: event.errorMessage ?? event.type });
          },
        });
      };
      attempt(0);
    });
    return true;
  }
  if (request?.action === "tts-stop") { chrome.tts.stop(); respond({ ok: true }); return; }
  if (request?.action === "tts-pause") { chrome.tts.pause(); respond({ ok: true }); return; }
  if (request?.action === "tts-resume") { chrome.tts.resume(); respond({ ok: true }); return; }
  if ((request?.action === "capture-chunk" || request?.action === "training-capture-chunk") && request.audioBase64 && request.mimeType && request.durationMs) {
    const captureTabId = request.tabId ?? sender.tab?.id;
    if (captureTabId !== undefined && trainingAudioCapture?.tabId === captureTabId) {
      trainingAudioCapture.chunks.push({ audioBase64: request.audioBase64, mimeType: request.mimeType, durationMs: request.durationMs });
      trainingAudioCapture.notify?.();
      respond({ ok: true }); return;
    }
    if (request.action === "capture-chunk" && request.tabId !== undefined) {
      void chrome.tabs.sendMessage(request.tabId, { action: "whisper-chunk", audioBase64: request.audioBase64, mimeType: request.mimeType, durationMs: request.durationMs }).catch(() => undefined);
    }
    respond({ ok: true }); return;
  }
  if (request?.action === "api-cancel" && request.requestId) {
    requests.get(requestKey(sender, request.requestId))?.abort();
    respond({ ok: true });
    return;
  }
  if (request?.action !== "api-request" || !request.requestId || !request.path || !allowedPaths.has(request.path)) return;
  if (sender.tab?.url && !/^https?:\/\//i.test(sender.tab.url)) {
    respond({ ok: false, status: 403, message: "Trang gọi API không được phép" });
    return;
  }
  const key = requestKey(sender, request.requestId);
  const controller = new AbortController();
  requests.set(key, controller);
  const operation = (async () => {
    if (request.path === "/api/subtitles/youtube") {
      return { ok: true, status: 200, data: await loadYouTubeSubtitles(request.body, controller.signal) };
    }
    const stored = await chrome.storage.local.get("groqApiKey");
    const customKey = typeof stored.groqApiKey === "string" ? stored.groqApiKey.trim() : "";
    if (customKey && (request.path === "/api/translate" || request.path === "/api/transcribe")) {
      const session = await chrome.storage.session.get("groqCooldownUntil");
      const cooldownUntil = Number(session.groqCooldownUntil ?? 0);
      if (cooldownUntil <= Date.now()) {
        const directResult = await requestGroqDirect(request.path, request.body, customKey, controller.signal);
        if (directResult.ok) return directResult;
        const quotaFailure = directResult.status === 429
          || (directResult.status === 400 && /quota|rate.?limit|limit reached|blocked_api_access/i.test(directResult.message ?? ""));
        if (!quotaFailure) return directResult;
        await chrome.storage.session.set({ groqCooldownUntil: Date.now() + (directResult.retryAfterMs ?? 5 * 60_000) });
        // Không trả lỗi: retry chính request hiện tại bằng key mặc định qua backend.
      }
    }
    const response = await fetch(`${API_BASE_URL}${request.path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request.body), signal: controller.signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
      return { ok: false, status: response.status, message: payload?.error?.message ?? `Backend trả lỗi ${response.status}` };
    }
    if (request.responseType === "audio") {
      return { ok: true, status: response.status, audioBase64: bufferToBase64(await response.arrayBuffer()), mimeType: response.headers.get("content-type") ?? "audio/mpeg" };
    }
    return { ok: true, status: response.status, data: await response.json() };
  })();
  void operation.catch((error: unknown) => ({ ok: false, status: 0, message: error instanceof Error ? error.message : "Không thể kết nối dịch vụ" }))
    .then(respond)
    .finally(() => requests.delete(key));
  return true;
});
