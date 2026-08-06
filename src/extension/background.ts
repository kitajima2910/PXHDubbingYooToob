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

async function ensureTabCapture(tabId: number, sourceVolume: number): Promise<void> {
  await ensureOffscreenDocument();
  const status = await chrome.runtime.sendMessage({ action: "capture-offscreen-status" }) as { active?: boolean; tabId?: number } | undefined;
  if (status?.active && status.tabId === tabId) {
    await chrome.runtime.sendMessage({ action: "capture-offscreen-volume", sourceVolume });
    return;
  }
  await startTabCapture(tabId, sourceVolume);
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
  const request = message as { action?: string; requestId?: string; path?: string; body?: unknown; responseType?: "json" | "audio"; tabId?: number; sourceVolume?: number; audioBase64?: string; mimeType?: string; durationMs?: number } | null;
  if (request?.action === "capture-start") {
    const targetTabId = sender.tab?.id ?? request.tabId;
    if (targetTabId === undefined) { respond({ ok: false, message: "Không xác định được tab YouTube" }); return; }
    const sourceVolume = request.sourceVolume ?? 0.08;
    void ensureTabCapture(targetTabId, sourceVolume).then(() => respond({ ok: true }), (error: unknown) => respond({ ok: false, message: error instanceof Error ? error.message : "Không thể thu âm tab" }));
    return true;
  }
  if (request?.action === "capture-stop") { void stopTabCapture().then(() => respond({ ok: true })); return true; }
  if (request?.action === "capture-volume") {
    void chrome.runtime.sendMessage({ action: "capture-offscreen-volume", sourceVolume: request.sourceVolume ?? 1 })
      .then((result) => respond(result), () => respond({ ok: false }));
    return true;
  }
  if (request?.action === "capture-reset") {
    void chrome.runtime.sendMessage({ action: "capture-offscreen-reset" }).then(() => respond({ ok: true }), () => respond({ ok: false }));
    return true;
  }
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
