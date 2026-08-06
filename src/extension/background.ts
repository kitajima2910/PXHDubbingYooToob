import { YoutubeTranscript } from "youtube-transcript";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";
const allowedPaths = new Set(["/api/subtitles/youtube", "/api/translate", "/api/tts", "/api/transcribe"]);
const requests = new Map<string, AbortController>();

async function ensureOffscreenDocument(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: [chrome.offscreen.Reason.USER_MEDIA], justification: "Thu âm tab YouTube để nhận dạng lời nói khi video không có phụ đề" });
}

async function startTabCapture(tabId: number, sourceVolume: number): Promise<void> {
  await ensureOffscreenDocument();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const response = await chrome.runtime.sendMessage({ action: "capture-offscreen-start", streamId, tabId, sourceVolume }) as { ok?: boolean; message?: string };
  if (!response?.ok) throw new Error(response?.message ?? "Không thể bắt đầu thu âm tab");
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
  const request = message as { action?: string; requestId?: string; path?: string; body?: unknown; responseType?: "json" | "audio"; tabId?: number; sourceVolume?: number; audioBase64?: string; mimeType?: string; durationMs?: number } | null;
  if (request?.action === "capture-start") {
    const targetTabId = request.tabId ?? sender.tab?.id;
    if (targetTabId === undefined) { respond({ ok: false, message: "Không xác định được tab YouTube" }); return; }
    void startTabCapture(targetTabId, request.sourceVolume ?? 0.18).then(() => respond({ ok: true }), (error: unknown) => respond({ ok: false, message: error instanceof Error ? error.message : "Không thể thu âm tab" }));
    return true;
  }
  if (request?.action === "capture-stop") { void stopTabCapture().then(() => respond({ ok: true })); return true; }
  if (request?.action === "capture-chunk" && request.tabId !== undefined && request.audioBase64 && request.mimeType && request.durationMs) {
    void chrome.tabs.sendMessage(request.tabId, { action: "whisper-chunk", audioBase64: request.audioBase64, mimeType: request.mimeType, durationMs: request.durationMs }).catch(() => undefined);
    respond({ ok: true }); return;
  }
  if (request?.action === "api-cancel" && request.requestId) {
    requests.get(requestKey(sender, request.requestId))?.abort();
    respond({ ok: true });
    return;
  }
  if (request?.action !== "api-request" || !request.requestId || !request.path || !allowedPaths.has(request.path)) return;
  if (sender.tab?.url && !sender.tab.url.startsWith("https://www.youtube.com/watch")) {
    respond({ ok: false, status: 403, message: "Trang gọi API không được phép" });
    return;
  }
  const key = requestKey(sender, request.requestId);
  const controller = new AbortController();
  requests.set(key, controller);
  const operation = request.path === "/api/subtitles/youtube"
    ? loadYouTubeSubtitles(request.body, controller.signal).then((data) => ({ ok: true, status: 200, data }))
    : fetch(`${API_BASE_URL}${request.path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request.body),
    signal: controller.signal,
  }).then(async (response) => {
    if (!response.ok) {
      const payload = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
      return { ok: false, status: response.status, message: payload?.error?.message ?? `Backend trả lỗi ${response.status}` };
    }
    if (request.responseType === "audio") {
      return { ok: true, status: response.status, audioBase64: bufferToBase64(await response.arrayBuffer()), mimeType: response.headers.get("content-type") ?? "audio/mpeg" };
    }
    return { ok: true, status: response.status, data: await response.json() };
  });
  void operation.catch((error: unknown) => ({ ok: false, status: 0, message: error instanceof Error ? error.message : "Không thể kết nối dịch vụ" }))
    .then(respond)
    .finally(() => requests.delete(key));
  return true;
});
