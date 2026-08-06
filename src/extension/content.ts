import type { ExtensionState, SubtitleSegment } from "../shared/types";
import { batchSegments, selectUpcomingSegments } from "../shared/segments";
import { createSpeech, loadBackendCaptions, transcribeAudio, translateSegments } from "./api/client";
import { AudioScheduler } from "./audio/scheduler";
import { loadYouTubeCaptions } from "./youtube/captions";

let state: ExtensionState = { enabled: false, status: "idle", message: "Sẵn sàng", processedSegments: 0, source: "—" };
let scheduler: AudioScheduler | undefined;
let controller: AbortController | undefined;
let currentVideoId = "";
let whisperMode = false;
let whisperDelaySeconds = 5;
let whisperChunkIndex = 0;
interface WhisperChunk { audioBase64: string; mimeType: string; durationMs: number; capturedEndMs: number }
let whisperProcessing = false;
let pendingWhisperChunk: WhisperChunk | undefined;
let resumeAfterWhisperWarmup = false;
let whisperInitialPauseDone = false;
let recentDubbingTexts: Array<{ text: string; expiresAt: number }> = [];
let floatingButton: HTMLButtonElement | undefined;
let floatingBusy = false;
const DEFAULT_DELAY_SECONDS = 6;
const DEFAULT_SOURCE_VOLUME = 0.18;

function takePendingWhisperChunk(): WhisperChunk | undefined {
  const chunk = pendingWhisperChunk;
  pendingWhisperChunk = undefined;
  return chunk;
}

function videoId(): string { return new URL(location.href).searchParams.get("v") ?? ""; }
function update(patch: Partial<ExtensionState>): void { state = { ...state, ...patch }; renderFloatingButton(); }

function speechFingerprint(text: string): string {
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("vi")
    .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function rememberDubbingText(text: string): void {
  const fingerprint = speechFingerprint(text);
  if (fingerprint.length < 8) return;
  const now = Date.now();
  recentDubbingTexts = recentDubbingTexts.filter((item) => item.expiresAt > now);
  recentDubbingTexts.push({ text: fingerprint, expiresAt: now + 45_000 });
  if (recentDubbingTexts.length > 24) recentDubbingTexts.splice(0, recentDubbingTexts.length - 24);
}

function isDubbingFeedback(text: string): boolean {
  const fingerprint = speechFingerprint(text);
  if (fingerprint.length < 8) return false;
  const now = Date.now();
  recentDubbingTexts = recentDubbingTexts.filter((item) => item.expiresAt > now);
  return recentDubbingTexts.some((item) => item.text === fingerprint
    || (Math.min(item.text.length, fingerprint.length) >= 14 && (item.text.includes(fingerprint) || fingerprint.includes(item.text))));
}

const playIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg>`;
const stopIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>`;
const spinnerIcon = `<span class="spinner" aria-hidden="true"></span>`;

function renderFloatingButton(): void {
  if (!floatingButton) return;
  // Spinner chỉ dành cho thao tác khởi động; xử lý chunk/bộ đệm nền vẫn giữ nút Stop ổn định.
  const loading = floatingBusy;
  floatingButton.innerHTML = loading ? spinnerIcon : state.enabled ? stopIcon : playIcon;
  floatingButton.dataset.active = String(state.enabled);
  floatingButton.dataset.error = String(state.status === "error");
  floatingButton.setAttribute("aria-label", state.enabled ? "Dừng lồng tiếng" : "Bắt đầu lồng tiếng");
  floatingButton.title = state.status === "error" ? state.message : state.enabled ? `Dừng — ${state.message}` : "Bắt đầu lồng tiếng";
}

function createFloatingControl(): void {
  if (document.querySelector("#pxh-dubbing-control")) return;
  const host = document.createElement("div");
  host.id = "pxh-dubbing-control";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `<style>
    :host{all:initial}.wrap{position:fixed;left:12px;top:50%;transform:translateY(-50%);z-index:2147483647;display:flex;align-items:center;gap:8px;font:600 12px system-ui,sans-serif}
    button{width:44px;height:44px;border:1px solid #ffffff38;border-radius:50%;display:grid;place-items:center;color:#fff;background:linear-gradient(145deg,#ff3048,#c50021);box-shadow:0 8px 24px #0008,0 0 0 4px #e7193720;cursor:pointer;transition:transform .18s,box-shadow .18s,filter .18s}
    button:hover{transform:scale(1.07);box-shadow:0 12px 34px #0009,0 0 0 7px #e7193728}button:active{transform:scale(.96)}button[data-active="true"]{background:linear-gradient(145deg,#2a303b,#11141a)}button[data-error="true"]{background:linear-gradient(145deg,#ff6b35,#c92b19)}
    svg{width:20px;height:20px;fill:currentColor}.spinner{width:17px;height:17px;border:2px solid #ffffff55;border-top-color:#fff;border-radius:50%;animation:spin .75s linear infinite}.hint{padding:7px 10px;border:1px solid #ffffff18;border-radius:8px;color:#fff;background:#11141aeb;box-shadow:0 6px 20px #0006;opacity:0;transform:translateX(-5px);pointer-events:none;transition:.18s;white-space:nowrap}.wrap:hover .hint{opacity:1;transform:none}@keyframes spin{to{transform:rotate(360deg)}}
  </style><div class="wrap"><button type="button"></button><span class="hint">PXH Dubbing</span></div>`;
  floatingButton = shadow.querySelector<HTMLButtonElement>("button")!;
  floatingButton.addEventListener("click", () => { void toggleFromFloatingButton(); });
  document.documentElement.append(host);
  renderFloatingButton();
}

async function toggleFromFloatingButton(): Promise<void> {
  if (floatingBusy) return;
  floatingBusy = true; renderFloatingButton();
  try {
    if (state.enabled) { await stop(); return; }
    const delaySeconds = DEFAULT_DELAY_SECONDS;
    const sourceVolume = DEFAULT_SOURCE_VOLUME;
    const capture = await chrome.runtime.sendMessage({ action: "capture-start", sourceVolume }) as { ok?: boolean; message?: string };
    const captureReady = capture?.ok === true;
    const result = await start(delaySeconds, sourceVolume);
    if (result.source === "Groq Whisper" && !captureReady) {
      await stop();
      throw new Error(capture?.message ?? "Whisper cần bạn mở icon extension một lần để cấp quyền thu âm tab");
    }
    if (!result.enabled && result.status === "error") void chrome.runtime.sendMessage({ action: "capture-stop" });
  } catch (error) {
    void chrome.runtime.sendMessage({ action: "capture-stop" });
    fail(error instanceof Error ? error.message : "Không thể bắt đầu lồng tiếng");
  } finally { floatingBusy = false; renderFloatingButton(); }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { window.clearTimeout(timer); resolve(); }, { once: true });
  });
}

async function buildWindow(segments: SubtitleSegment[], video: HTMLVideoElement, signal: AbortSignal, queued: Set<string>, onFirstAudio: () => void): Promise<number> {
  const fromMs = Math.max(0, video.currentTime * 1000);
  const candidates = selectUpcomingSegments(segments, fromMs, 45_000, queued);
  for (const item of candidates) queued.add(item.id);
  for (const batch of batchSegments(candidates, 8)) {
    if (signal.aborted) return 0;
    update({ status: "translating", message: "Đang dịch" });
    let translated: SubtitleSegment[];
    try { translated = await translateSegments(batch, signal); }
    catch (error) { for (const item of batch) queued.delete(item.id); throw error; }
    update({ status: "speaking", message: state.processedSegments ? "Đang tạo bộ đệm" : "Đang tạo giọng nói" });
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (!signal.aborted) {
        const segment = translated[nextIndex++];
        if (!segment) return;
        try {
          const audio = await createSpeech(segment.translatedText ?? segment.sourceText, 1, signal);
          scheduler?.add(segment, audio);
          update({ processedSegments: state.processedSegments + 1 });
          if (state.processedSegments === 1) onFirstAudio();
        } catch (error) { queued.delete(segment.id); if (!signal.aborted) console.warn("PXHDubbingYooToob: bỏ qua một câu TTS lỗi", error); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, translated.length) }, worker));
  }
  return candidates.length;
}

async function processWhisperChunk(chunk: WhisperChunk, signal: AbortSignal): Promise<void> {
  const video = document.querySelector<HTMLVideoElement>("video");
  if (!video || signal.aborted || !whisperMode) return;
  update({ status: "loading", message: "Đang nhận dạng giọng nói" });
  const result = await transcribeAudio(chunk.audioBase64, chunk.mimeType, signal);
  if (signal.aborted) return;
  const vietnameseFeedback = /^(?:vi|vie|vietnamese|tiếng việt)$/i.test(result.language?.trim() ?? "")
    && recentDubbingTexts.length > 0;
  const sourceSegments = vietnameseFeedback ? [] : result.segments.filter((segment) => !isDubbingFeedback(segment.sourceText));
  if (!sourceSegments.length) {
    update({ status: "ready", message: "Đang nghe video" });
    if (resumeAfterWhisperWarmup) {
      resumeAfterWhisperWarmup = false;
      void video.play().catch(() => undefined);
    }
    return;
  }
  const chunkId = whisperChunkIndex++;
  const capturedStartMs = chunk.capturedEndMs - chunk.durationMs;
  const desiredStartMs = capturedStartMs + whisperDelaySeconds * 1000;
  const anchorMs = Math.round(Math.max(desiredStartMs, video.currentTime * 1000 + 250));
  const segments = sourceSegments.map((segment, index) => ({
    ...segment,
    id: `whisper-${chunkId}-${index}`,
    startMs: anchorMs + segment.startMs,
    endMs: anchorMs + Math.max(segment.startMs + 500, segment.endMs),
  }));
  update({ status: "translating", message: "Đang dịch giọng nói" });
  const translated = await translateSegments(segments, signal);
  update({ status: "speaking", message: "Đang tạo giọng nói" });
  await Promise.all(translated.map(async (segment) => {
    const dubbingText = segment.translatedText ?? segment.sourceText;
    const audio = await createSpeech(dubbingText, 1, signal);
    scheduler?.add(segment, audio);
    rememberDubbingText(dubbingText);
    update({ processedSegments: state.processedSegments + 1 });
    if (resumeAfterWhisperWarmup) {
      resumeAfterWhisperWarmup = false;
      void video.play().catch(() => undefined);
    }
  }));
  if (!signal.aborted) update({ status: "ready", message: "Đang lồng tiếng bằng Whisper" });
}

function queueWhisperChunk(chunk: WhisperChunk, signal: AbortSignal): void {
  // Giữ chunk mới nhất thay vì để backend xử lý một hàng đợi cũ ngày càng dài.
  pendingWhisperChunk = chunk;
  if (whisperProcessing) return;
  whisperProcessing = true;
  void (async () => {
    while (!signal.aborted && whisperMode) {
      const next = takePendingWhisperChunk();
      if (!next) break;
      await processWhisperChunk(next, signal);
    }
  })().catch((error: unknown) => {
    if (!signal.aborted) {
      const video = document.querySelector<HTMLVideoElement>("video");
      if (resumeAfterWhisperWarmup) void video?.play().catch(() => undefined);
      resumeAfterWhisperWarmup = false;
      whisperMode = false;
      void chrome.runtime.sendMessage({ action: "capture-stop" });
      update({ enabled: false, status: "error", message: error instanceof Error ? error.message : "Whisper không thể xử lý audio" });
    }
  }).finally(() => {
    whisperProcessing = false;
    const latest = takePendingWhisperChunk();
    if (latest && !signal.aborted && whisperMode) queueWhisperChunk(latest, signal);
  });
}

async function bufferContinuously(
  video: HTMLVideoElement,
  sessionVideoId: string,
  initialSegments: SubtitleSegment[],
  useBackend: boolean,
  signal: AbortSignal,
  queued: Set<string>,
): Promise<void> {
  let segments = initialSegments;
  while (!signal.aborted) {
    try {
      const fromMs = Math.max(0, Math.round(video.currentTime * 1000));
      const prepared = await buildWindow(segments, video, signal, queued, () => undefined);
      if (!signal.aborted) update({ status: "ready", message: "Sẵn sàng" });
      if (prepared > 0) { await wait(250, signal); continue; }
      await wait(4_000, signal);
      if (signal.aborted) return;
      if (useBackend) segments = (await loadBackendCaptions(sessionVideoId, fromMs, fromMs + 60_000, signal)).segments;
    } catch (error) {
      if (!signal.aborted) {
        update({ status: "ready", message: "Đang tạo bộ đệm" });
        console.warn("PXHDubbingYooToob: sẽ thử nạp lại bộ đệm", error);
      }
      await wait(4_000, signal);
    }
  }
}

async function start(delaySeconds: number, sourceVolume: number): Promise<ExtensionState> {
  await stop(false);
  const video = document.querySelector<HTMLVideoElement>("video");
  if (!video || !videoId()) return fail("Không tìm thấy video YouTube");
  const resumeWhenReady = !video.paused;
  if (resumeWhenReady) video.pause();
  currentVideoId = videoId();
  controller = new AbortController();
  whisperMode = false; whisperDelaySeconds = delaySeconds; whisperChunkIndex = 0; whisperProcessing = false;
  pendingWhisperChunk = undefined; resumeAfterWhisperWarmup = false; whisperInitialPauseDone = false;
  recentDubbingTexts = [];
  const sessionController = controller;
  scheduler = new AudioScheduler(video, sourceVolume);
  update({ enabled: true, status: "loading", message: "Đang tải phụ đề", processedSegments: 0 });
  try {
    let captions: { segments: SubtitleSegment[]; source: string };
    let useBackend = false;
    try { captions = await loadYouTubeCaptions(); }
    catch (bridgeError) {
      useBackend = true;
      try {
        captions = await loadBackendCaptions(currentVideoId, Math.round(video.currentTime * 1000), Math.round(video.currentTime * 1000) + 60_000, sessionController.signal);
      } catch (backendError) {
        console.info("PXHDubbingYooToob: chuyển sang Whisper", bridgeError, backendError);
        whisperMode = true;
        scheduler.setSourceVolume(1);
        update({ enabled: true, status: "ready", message: "Đang nghe video bằng Whisper", source: "Groq Whisper" });
        scheduler.start();
        await chrome.runtime.sendMessage({ action: "capture-reset" }).catch(() => undefined);
        if (resumeWhenReady) void video.play().catch(() => undefined);
        return state;
      }
    }
    void chrome.runtime.sendMessage({ action: "capture-stop" });
    update({ source: captions.source });
    scheduler.start();
    const queued = new Set<string>();
    let markFirstAudio!: () => void;
    const firstAudio = new Promise<void>((resolve) => { markFirstAudio = resolve; });
    const completion = buildWindow(captions.segments, video, sessionController.signal, queued, markFirstAudio);
    const completedBeforeAudio = await Promise.race([firstAudio.then(() => false), completion.then(() => true)]);
    if (completedBeforeAudio && state.processedSegments === 0) throw new Error("Không thể tạo audio cho các câu sắp phát");
    if (resumeWhenReady && !sessionController.signal.aborted) void video.play().catch(() => undefined);
    if (!sessionController.signal.aborted) update({ status: "ready", message: "Sẵn sàng" });
    void completion.then(() => {
      if (controller === sessionController && !sessionController.signal.aborted) {
        update({ status: "ready", message: "Sẵn sàng" });
        void bufferContinuously(video, currentVideoId, captions.segments, useBackend, sessionController.signal, queued);
      }
    })
      .catch((error: unknown) => { if (controller === sessionController && !sessionController.signal.aborted) fail(error instanceof Error ? error.message : "Không thể tạo bộ đệm"); });
  } catch (error) {
    if (resumeWhenReady && video.paused) void video.play().catch(() => undefined);
    if (!sessionController.signal.aborted) fail(error instanceof Error ? error.message : "Không thể bắt đầu lồng tiếng");
  }
  return state;
}

async function stop(stopCapture = true): Promise<ExtensionState> {
  controller?.abort(); controller = undefined;
  whisperMode = false; whisperProcessing = false; pendingWhisperChunk = undefined;
  resumeAfterWhisperWarmup = false; whisperInitialPauseDone = false;
  recentDubbingTexts = [];
  if (stopCapture) void chrome.runtime.sendMessage({ action: "capture-stop" });
  scheduler?.clear(); scheduler = undefined;
  update({ enabled: false, status: "idle", message: "Sẵn sàng" });
  return state;
}

function fail(message: string): ExtensionState { update({ enabled: false, status: "error", message }); scheduler?.clear(); return state; }

chrome.runtime.onMessage.addListener((request: { action?: string; delaySeconds?: number; sourceVolume?: number; durationMs?: number }, _sender, respond) => {
  if (request.action === "status") { respond(state); return; }
  if (request.action === "capture-ready") {
    if (!state.enabled && state.status === "error" && /invoked|current page|tab.?capture/i.test(state.message)) {
      update({ status: "idle", message: "Đã cấp quyền — nhấn Play bên trái video" });
    }
    respond(state);
    return;
  }
  if (request.action === "whisper-chunk") {
    const chunk = request as typeof request & { audioBase64?: string; mimeType?: string };
    const video = document.querySelector<HTMLVideoElement>("video");
    if (controller && video && !video.paused && chunk.audioBase64 && chunk.mimeType) {
      const signal = controller.signal;
      const whisperChunk: WhisperChunk = {
        audioBase64: chunk.audioBase64,
        mimeType: chunk.mimeType,
        durationMs: Math.max(500, request.durationMs ?? 5_000),
        capturedEndMs: Math.round(video.currentTime * 1000),
      };
      if (whisperMode) {
        if (state.processedSegments === 0 && !whisperInitialPauseDone) {
          whisperInitialPauseDone = true;
          resumeAfterWhisperWarmup = true;
          video.pause();
        }
        queueWhisperChunk(whisperChunk, signal);
      } else pendingWhisperChunk = whisperChunk;
    }
    respond({ ok: true }); return;
  }
  const operation = request.action === "stop" ? stop() : start(request.delaySeconds ?? DEFAULT_DELAY_SECONDS, request.sourceVolume ?? DEFAULT_SOURCE_VOLUME);
  void operation.then(respond);
  return true;
});

setInterval(() => { if (state.enabled && currentVideoId && videoId() !== currentVideoId) void stop(); }, 1000);

createFloatingControl();
