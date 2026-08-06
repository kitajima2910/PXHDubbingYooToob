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
let whisperQueue: Promise<void> = Promise.resolve();

function videoId(): string { return new URL(location.href).searchParams.get("v") ?? ""; }
function update(patch: Partial<ExtensionState>): void { state = { ...state, ...patch }; }

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

async function processWhisperChunk(audioBase64: string, mimeType: string, signal: AbortSignal): Promise<void> {
  const video = document.querySelector<HTMLVideoElement>("video");
  if (!video || signal.aborted || !whisperMode) return;
  update({ status: "loading", message: "Đang nhận dạng giọng nói" });
  const result = await transcribeAudio(audioBase64, mimeType, signal);
  if (!result.segments.length || signal.aborted) { update({ status: "ready", message: "Đang nghe video" }); return; }
  const chunkId = whisperChunkIndex++;
  const anchorMs = Math.round(video.currentTime * 1000 + whisperDelaySeconds * 1000);
  const segments = result.segments.map((segment, index) => ({
    ...segment,
    id: `whisper-${chunkId}-${index}`,
    startMs: anchorMs + segment.startMs,
    endMs: anchorMs + Math.max(segment.startMs + 500, segment.endMs),
  }));
  update({ status: "translating", message: "Đang dịch giọng nói" });
  const translated = await translateSegments(segments, signal);
  update({ status: "speaking", message: "Đang tạo giọng nói" });
  await Promise.all(translated.map(async (segment) => {
    const audio = await createSpeech(segment.translatedText ?? segment.sourceText, 1, signal);
    scheduler?.add(segment, audio);
    update({ processedSegments: state.processedSegments + 1 });
  }));
  if (!signal.aborted) update({ status: "ready", message: "Đang lồng tiếng bằng Whisper" });
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
  currentVideoId = videoId();
  controller = new AbortController();
  whisperMode = false; whisperDelaySeconds = delaySeconds; whisperChunkIndex = 0; whisperQueue = Promise.resolve();
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
    if (!sessionController.signal.aborted) update({ status: "ready", message: "Sẵn sàng" });
    void completion.then(() => {
      if (controller === sessionController && !sessionController.signal.aborted) {
        update({ status: "ready", message: "Sẵn sàng" });
        void bufferContinuously(video, currentVideoId, captions.segments, useBackend, sessionController.signal, queued);
      }
    })
      .catch((error: unknown) => { if (controller === sessionController && !sessionController.signal.aborted) fail(error instanceof Error ? error.message : "Không thể tạo bộ đệm"); });
  } catch (error) {
    if (!sessionController.signal.aborted) fail(error instanceof Error ? error.message : "Không thể bắt đầu lồng tiếng");
  }
  return state;
}

async function stop(stopCapture = true): Promise<ExtensionState> {
  controller?.abort(); controller = undefined;
  whisperMode = false; whisperQueue = Promise.resolve();
  if (stopCapture) void chrome.runtime.sendMessage({ action: "capture-stop" });
  scheduler?.clear(); scheduler = undefined;
  update({ enabled: false, status: "idle", message: "Sẵn sàng" });
  return state;
}

function fail(message: string): ExtensionState { update({ enabled: false, status: "error", message }); scheduler?.clear(); return state; }

function pauseForLostFocus(): ExtensionState {
  if (!state.enabled) return state;
  const video = document.querySelector<HTMLVideoElement>("video");
  if (video && !video.paused) video.pause();
  if (whisperMode) void chrome.runtime.sendMessage({ action: "capture-stop" });
  update({ status: "ready", message: "Đã tạm dừng vì Chrome không hoạt động" });
  return state;
}

chrome.runtime.onMessage.addListener((request: { action?: string; delaySeconds?: number; sourceVolume?: number }, _sender, respond) => {
  if (request.action === "status") { respond(state); return; }
  if (request.action === "pause-window") { respond(pauseForLostFocus()); return; }
  if (request.action === "whisper-chunk") {
    const chunk = request as typeof request & { audioBase64?: string; mimeType?: string };
    if (whisperMode && controller && chunk.audioBase64 && chunk.mimeType) {
      const signal = controller.signal;
      whisperQueue = whisperQueue.then(() => processWhisperChunk(chunk.audioBase64!, chunk.mimeType!, signal)).catch((error: unknown) => {
        if (!signal.aborted) {
          whisperMode = false;
          void chrome.runtime.sendMessage({ action: "capture-stop" });
          update({ enabled: false, status: "error", message: error instanceof Error ? error.message : "Whisper không thể xử lý audio" });
        }
      });
    }
    respond({ ok: true }); return;
  }
  const operation = request.action === "stop" ? stop() : start(request.delaySeconds ?? 5, request.sourceVolume ?? 0.25);
  void operation.then(respond);
  return true;
});

setInterval(() => { if (state.enabled && currentVideoId && videoId() !== currentVideoId) void stop(); }, 1000);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) pauseForLostFocus();
});
