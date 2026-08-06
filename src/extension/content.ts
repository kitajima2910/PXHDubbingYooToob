import type { ExtensionState, SubtitleSegment } from "../shared/types";
import { batchSegments, selectUpcomingSegments } from "../shared/segments";
import { createSpeech, loadBackendCaptions, translateSegments } from "./api/client";
import { AudioScheduler } from "./audio/scheduler";
import { loadYouTubeCaptions } from "./youtube/captions";

let state: ExtensionState = { enabled: false, status: "idle", message: "Sẵn sàng", processedSegments: 0, source: "—" };
let scheduler: AudioScheduler | undefined;
let controller: AbortController | undefined;
let currentVideoId = "";

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
        const durationSeconds = Math.max(0.5, (segment.endMs - segment.startMs) / 1000);
        const rate = Math.min(1.3, Math.max(0.85, segment.sourceText.length / (durationSeconds * 14)));
        try {
          const audio = await createSpeech(segment.translatedText ?? segment.sourceText, rate, signal);
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
  await stop();
  const video = document.querySelector<HTMLVideoElement>("video");
  if (!video || !videoId()) return fail("Không tìm thấy video YouTube");
  currentVideoId = videoId();
  controller = new AbortController();
  const sessionController = controller;
  scheduler = new AudioScheduler(video, sourceVolume);
  update({ enabled: true, status: "loading", message: "Đang tải phụ đề", processedSegments: 0 });
  try {
    let captions: { segments: SubtitleSegment[]; source: string };
    let useBackend = false;
    try { captions = await loadYouTubeCaptions(); }
    catch {
      useBackend = true;
      captions = await loadBackendCaptions(currentVideoId, Math.round(video.currentTime * 1000), Math.round(video.currentTime * 1000) + 60_000, sessionController.signal);
    }
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

async function stop(): Promise<ExtensionState> {
  controller?.abort(); controller = undefined;
  scheduler?.clear(); scheduler = undefined;
  update({ enabled: false, status: "idle", message: "Sẵn sàng" });
  return state;
}

function fail(message: string): ExtensionState { update({ enabled: false, status: "error", message }); scheduler?.clear(); return state; }

chrome.runtime.onMessage.addListener((request: { action?: string; delaySeconds?: number; sourceVolume?: number }, _sender, respond) => {
  if (request.action === "status") { respond(state); return; }
  const operation = request.action === "stop" ? stop() : start(request.delaySeconds ?? 5, request.sourceVolume ?? 0.25);
  void operation.then(respond);
  return true;
});

setInterval(() => { if (state.enabled && currentVideoId && videoId() !== currentVideoId) void stop(); }, 1000);
