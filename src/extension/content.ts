import type { ExtensionState, SubtitleSegment } from "../shared/types";
import { batchSegments, selectUpcomingSegments, stripTranscriptTimestamps } from "../shared/segments";
import { createSpeech, loadBackendCaptions, loadCachedTranscript, saveCachedTranscript, transcribeAudio, translateSegments } from "./api/client";
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
let whisperQueue: WhisperChunk[] = [];
let resumeAfterWhisperWarmup = false;
let whisperInitialPauseDone = false;
let chromeTtsAvailable = false;
let recentDubbingTexts: Array<{ text: string; expiresAt: number }> = [];
const DEFAULT_DELAY_SECONDS = 5;
const DEFAULT_SOURCE_VOLUME = 0.08;

function takePendingWhisperChunk(): WhisperChunk | undefined {
  return whisperQueue.shift();
}

function videoId(): string { return new URL(location.href).searchParams.get("v") ?? ""; }
function update(patch: Partial<ExtensionState>): void { state = { ...state, ...patch }; }
function cacheContext(): { videoId: string; sourceLanguage: string } { return { videoId: currentVideoId, sourceLanguage: "auto" }; }
function translateForVideo(segments: SubtitleSegment[], signal: AbortSignal): Promise<SubtitleSegment[]> {
  return translateSegments(segments, signal, cacheContext());
}

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

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { window.clearTimeout(timer); resolve(); }, { once: true });
  });
}

async function addPreparedSpeech(segment: SubtitleSegment, signal: AbortSignal): Promise<void> {
  const text = segment.translatedText ?? segment.sourceText;
  if (chromeTtsAvailable) {
    scheduler?.addSpeech(segment, text);
    return;
  }
  scheduler?.add(segment, await createSpeech(text, 1, signal));
}

async function buildWindow(segments: SubtitleSegment[], video: HTMLVideoElement, signal: AbortSignal, queued: Set<string>, onFirstAudio: () => void): Promise<number> {
  const fromMs = Math.max(0, video.currentTime * 1000);
  const upcoming = selectUpcomingSegments(segments, fromMs, 45_000, queued);
  for (const item of upcoming) queued.add(item.id);
  const candidates = upcoming
    .map((segment) => ({ ...segment, sourceText: stripTranscriptTimestamps(segment.sourceText) }))
    .filter((segment) => segment.sourceText.length > 0);
  for (const batch of batchSegments(candidates, 8)) {
    if (signal.aborted) return 0;
    update({ status: "translating", message: "Đang dịch" });
    let translated: SubtitleSegment[];
    try { translated = await translateForVideo(batch, signal); }
    catch (error) { for (const item of batch) queued.delete(item.id); throw error; }
    update({ status: "speaking", message: state.processedSegments ? "Đang tạo bộ đệm" : "Đang tạo giọng nói" });
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (!signal.aborted) {
        const segment = translated[nextIndex++];
        if (!segment) return;
        try {
          await addPreparedSpeech(segment, signal);
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
  const capturedStartMs = chunk.capturedEndMs - chunk.durationMs;
  const cached = await loadCachedTranscript(cacheContext(), capturedStartMs, chunk.capturedEndMs, signal);
  let sourceSegments = cached?.covered ? cached.segments : [];
  const fromCache = cached?.covered === true;
  if (!fromCache) {
    const result = await transcribeAudio(chunk.audioBase64, chunk.mimeType, signal);
    if (signal.aborted) return;
    const vietnameseFeedback = /^(?:vi|vie|vietnamese|tiếng việt)$/i.test(result.language?.trim() ?? "")
      && recentDubbingTexts.length > 0;
    sourceSegments = vietnameseFeedback ? [] : result.segments.filter((segment) => !isDubbingFeedback(segment.sourceText));
  }
  if (!sourceSegments.length) {
    if (!fromCache) {
      await saveCachedTranscript(cacheContext(), "Groq Whisper", [], false, signal, {
        fromMs: capturedStartMs, toMs: chunk.capturedEndMs,
      });
    }
    update({ status: "ready", message: "Đang nghe video" });
    if (resumeAfterWhisperWarmup) {
      resumeAfterWhisperWarmup = false;
      void video.play().catch(() => undefined);
    }
    return;
  }
  const chunkId = whisperChunkIndex++;
  const desiredStartMs = capturedStartMs + whisperDelaySeconds * 1000;
  const anchorMs = Math.round(Math.max(desiredStartMs, video.currentTime * 1000 + 250));
  const segments = fromCache ? sourceSegments.map((segment, index) => ({
    ...segment, id: `cache-${chunkId}-${index}`,
    startMs: Math.max(anchorMs, segment.startMs + whisperDelaySeconds * 1000),
    endMs: Math.max(anchorMs + 500, segment.endMs + whisperDelaySeconds * 1000),
  })) : sourceSegments.map((segment, index) => ({
    ...segment, id: `whisper-${chunkId}-${index}`,
    startMs: anchorMs + segment.startMs,
    endMs: anchorMs + Math.max(segment.startMs + 500, segment.endMs),
  }));
  if (!fromCache) {
    const transcriptSegments = segments.map((segment) => ({
      ...segment,
      startMs: segment.startMs - whisperDelaySeconds * 1000,
      endMs: segment.endMs - whisperDelaySeconds * 1000,
    }));
    await saveCachedTranscript(cacheContext(), "Groq Whisper", transcriptSegments, false, signal, {
      fromMs: capturedStartMs, toMs: chunk.capturedEndMs,
    });
  }
  update({ status: "translating", message: "Đang dịch giọng nói" });
  const translated = await translateForVideo(segments, signal);
  update({ status: "speaking", message: "Đang tạo giọng nói" });
  await Promise.all(translated.map(async (segment) => {
    const dubbingText = segment.translatedText ?? segment.sourceText;
    await addPreparedSpeech(segment, signal);
    rememberDubbingText(dubbingText);
    update({ processedSegments: state.processedSegments + 1 });
    if (resumeAfterWhisperWarmup) {
      resumeAfterWhisperWarmup = false;
      void video.play().catch(() => undefined);
    }
  }));
  if (!signal.aborted) update({ status: "ready", message: "Đang lồng tiếng bằng Whisper" });
}

function drainWhisperQueue(signal: AbortSignal): void {
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
    if (whisperQueue.length && !signal.aborted && whisperMode) drainWhisperQueue(signal);
  });
}

function queueWhisperChunk(chunk: WhisperChunk, signal: AbortSignal): void {
  // FIFO preserves every 5-second window. Replacing the pending item caused
  // complete phrases to disappear whenever recognition/TTS took over 5 seconds.
  whisperQueue.push(chunk);
  drainWhisperQueue(signal);
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
      if (useBackend) {
        const loaded = await loadBackendCaptions(sessionVideoId, fromMs, fromMs + 60_000, signal);
        segments = loaded.segments;
        void saveCachedTranscript(cacheContext(), loaded.source, loaded.segments, false).catch(() => undefined);
      }
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
  whisperQueue = []; resumeAfterWhisperWarmup = false; whisperInitialPauseDone = false;
  recentDubbingTexts = [];
  const sessionController = controller;
  scheduler = new AudioScheduler(video, sourceVolume);
  const ttsStatus = await chrome.runtime.sendMessage({ action: "tts-status" }).catch(() => undefined) as { available?: boolean } | undefined;
  chromeTtsAvailable = ttsStatus?.available === true;
  update({ enabled: true, status: "loading", message: "Đang tải phụ đề", processedSegments: 0 });
  try {
    let captions: { segments: SubtitleSegment[]; source: string };
    let useBackend = false;
    let completeTranscript = false;
    try {
      captions = await loadYouTubeCaptions();
      completeTranscript = true;
      void saveCachedTranscript(cacheContext(), captions.source, captions.segments, true).catch(() => undefined);
    }
    catch (bridgeError) {
      useBackend = true;
      try {
        captions = await loadBackendCaptions(currentVideoId, Math.round(video.currentTime * 1000), Math.round(video.currentTime * 1000) + 60_000, sessionController.signal);
      } catch (backendError) {
        const cached = await loadCachedTranscript(cacheContext(), undefined, undefined, sessionController.signal);
        if (cached?.complete && cached.segments.length) {
          captions = { segments: cached.segments, source: "Neon cache — đồng bộ" };
          useBackend = false;
          completeTranscript = true;
        } else {
          // Giảm riêng video xuống 8%; output tabCapture phải giữ 100% để không hạ luôn TTS.
          await chrome.runtime.sendMessage({ action: "capture-volume", sourceVolume: 1 }).catch(() => undefined);
          scheduler.start();
          console.info("PXHDubbingYooToob: chuyển sang Whisper", bridgeError, backendError);
          whisperMode = true;
          update({ enabled: true, status: "ready", message: "Đang nghe video bằng Whisper", source: "Whisper — trễ khoảng 5–8 giây" });
          await chrome.runtime.sendMessage({ action: "capture-reset" }).catch(() => undefined);
          if (resumeWhenReady) void video.play().catch(() => undefined);
          return state;
        }
      }
    }
    if (!completeTranscript && captions.segments.length) {
      void saveCachedTranscript(cacheContext(), captions.source, captions.segments, false).catch(() => undefined);
    }
    void chrome.runtime.sendMessage({ action: "capture-stop" });
    update({ source: captions.source.startsWith("Neon cache") ? captions.source : "Transcript — đồng bộ" });
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
  whisperMode = false; whisperProcessing = false; whisperQueue = [];
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
  if (request.action === "training-transcript") {
    void loadYouTubeCaptions(45_000).then(
      (captions) => respond({ segments: captions.segments }),
      (error: unknown) => respond({ message: error instanceof Error ? error.message : "Không thể lấy transcript" }),
    );
    return true;
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
      } else whisperQueue.push(whisperChunk);
    }
    respond({ ok: true }); return;
  }
  const operation = request.action === "stop" ? stop() : start(request.delaySeconds ?? DEFAULT_DELAY_SECONDS, request.sourceVolume ?? DEFAULT_SOURCE_VOLUME);
  void operation.then(respond);
  return true;
});

setInterval(() => { if (state.enabled && currentVideoId && videoId() !== currentVideoId) void stop(); }, 1000);
