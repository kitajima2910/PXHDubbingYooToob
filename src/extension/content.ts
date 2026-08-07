import type { ExtensionState, SubtitleSegment } from "../shared/types";
import { batchSegments, mergeOverlappingSegments, selectUpcomingSegments, stripTranscriptTimestamps } from "../shared/segments";
import { createSpeech, loadBackendCaptions, loadCachedTranscript, saveCachedTranscript, transcribeAudio, translateSegments } from "./api/client";
import { AudioScheduler } from "./audio/scheduler";
import { loadYouTubeCaptions } from "./youtube/captions";
import { prepareBrowserTranslation } from "./translation/browser-translator";

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
let trainingRecorder: MediaRecorder | undefined;
let trainingStream: MediaStream | undefined;
let trainingKeepAlivePort: chrome.runtime.Port | undefined;
let trainingKeepAliveTimer = 0;
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

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function stopTrainingRecorder(): void {
  window.clearInterval(trainingKeepAliveTimer);
  trainingKeepAliveTimer = 0;
  trainingKeepAlivePort?.disconnect();
  trainingKeepAlivePort = undefined;
  if (trainingRecorder?.state !== "inactive") trainingRecorder?.stop();
  trainingRecorder = undefined;
  trainingStream?.getTracks().forEach((track) => track.stop());
  trainingStream = undefined;
}

async function startTrainingRecorder(video: HTMLVideoElement): Promise<void> {
  stopTrainingRecorder();
  const captureStream = (video as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream;
  if (typeof captureStream !== "function") throw new Error("Trình duyệt không hỗ trợ thu audio trực tiếp từ video");
  const captured = captureStream.call(video);
  let audioTracks = captured.getAudioTracks();
  for (let attempt = 0; !audioTracks.length && attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    audioTracks = captured.getAudioTracks();
  }
  if (!audioTracks.length) {
    captured.getTracks().forEach((track) => track.stop());
    throw new Error("Video đã phát nhưng Brave không cung cấp audio track sau 5 giây");
  }
  captured.getVideoTracks().forEach((track) => track.stop());
  trainingStream = new MediaStream(audioTracks);
  trainingKeepAlivePort = chrome.runtime.connect({ name: "playlist-training-keepalive" });
  trainingKeepAliveTimer = window.setInterval(() => {
    try { trainingKeepAlivePort?.postMessage({ active: true, currentMs: Math.round(video.currentTime * 1000) }); } catch { /* Port closed during extension reload. */ }
  }, 20_000);
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  const recorder = new MediaRecorder(trainingStream, { mimeType, audioBitsPerSecond: 48_000 });
  trainingRecorder = recorder;
  let chunkStartedAt = Date.now();
  recorder.addEventListener("dataavailable", (event) => {
    if (!event.data.size) return;
    const durationMs = Math.max(500, Date.now() - chunkStartedAt);
    chunkStartedAt = Date.now();
    void event.data.arrayBuffer().then((buffer) => chrome.runtime.sendMessage({
      action: "training-capture-chunk", audioBase64: bufferToBase64(buffer), mimeType, durationMs,
    }));
  });
  recorder.start(5_000);
}

async function addPreparedSpeech(segment: SubtitleSegment, signal: AbortSignal): Promise<void> {
  const text = segment.translatedText ?? segment.sourceText;
  // Whisper đang thu chính tab: ưu tiên Chrome TTS nam để giọng dubbing không
  // lọt ngược vào audio nhận dạng. Luồng transcript dùng MP3 Nam Minh ổn định,
  // có duration thật để scheduler căn tốc độ chính xác hơn.
  if (whisperMode && chromeTtsAvailable) {
    scheduler?.addSpeech(segment, text);
    return;
  }
  try {
    scheduler?.add(segment, await createSpeech(text, 1, signal));
  } catch (error) {
    if (!chromeTtsAvailable) throw error;
    scheduler?.addSpeech(segment, text);
  }
}

async function buildWindow(segments: SubtitleSegment[], video: HTMLVideoElement, signal: AbortSignal, queued: Set<string>): Promise<number> {
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
    // Dịch/cache theo từng caption gốc để tiếp tục tận dụng Translation Memory,
    // sau đó mới ghép thành cụm nói dài hơn cho TTS tự nhiên.
    const speechSegments = mergeOverlappingSegments(translated);
    update({ status: "speaking", message: state.processedSegments ? "Đang tạo bộ đệm" : "Đang tạo giọng nói" });
    let nextIndex = 0;
    const prepare = async (segment: SubtitleSegment): Promise<void> => {
      try {
        await addPreparedSpeech(segment, signal);
        update({ processedSegments: state.processedSegments + 1 });
      } catch (error) {
        for (const source of batch) {
          if (source.startMs >= segment.startMs && source.startMs < segment.endMs) queued.delete(source.id);
        }
        if (!signal.aborted) console.warn("PXHDubbingYooToob: bỏ qua một câu TTS lỗi", error);
      }
    };
    // Chuẩn bị tuần tự cho đến khi câu đầu tiên thật sự sẵn sàng. Trước đây
    // một trong ba câu phía sau có thể hoàn thành trước và làm video chạy sớm.
    while (!signal.aborted && state.processedSegments === 0 && nextIndex < speechSegments.length) {
      await prepare(speechSegments[nextIndex++]!);
    }
    const worker = async (): Promise<void> => {
      while (!signal.aborted) {
        const segment = speechSegments[nextIndex++];
        if (!segment) return;
        await prepare(segment);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, speechSegments.length) }, worker));
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
      const prepared = await buildWindow(segments, video, signal, queued);
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
  scheduler = new AudioScheduler(video, sourceVolume, (_segment, text) => createSpeech(text, 1, sessionController.signal));
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
    await buildWindow(captions.segments, video, sessionController.signal, queued);
    if (state.processedSegments === 0) {
      update({ status: "ready", message: "Chưa có bản dịch cache — đang tiếp tục theo dõi" });
    }
    if (resumeWhenReady && !sessionController.signal.aborted) void video.play().catch(() => undefined);
    if (!sessionController.signal.aborted) update({ status: "ready", message: "Sẵn sàng" });
    if (!sessionController.signal.aborted) {
      void bufferContinuously(video, currentVideoId, captions.segments, useBackend, sessionController.signal, queued);
    }
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

chrome.runtime.onMessage.addListener((request: { action?: string; delaySeconds?: number; sourceVolume?: number; durationMs?: number; startMs?: number }, _sender, respond) => {
  if (request.action === "training-ready") { respond({ ok: true, videoId: videoId() }); return; }
  if (request.action === "prepare-offline-translation") {
    void prepareBrowserTranslation().then(
      (message) => respond({ ok: true, message }),
      (error: unknown) => respond({ ok: false, message: error instanceof Error ? error.message : "Dịch offline không khả dụng" }),
    );
    return true;
  }
  if (request.action === "status") { respond(state); return; }
  if (request.action === "training-playback-start") {
    const video = document.querySelector<HTMLVideoElement>("video");
    if (!video) { respond({ ok: false, message: "Không tìm thấy trình phát YouTube" }); return; }
    const startSeconds = Math.max(0, (request.startMs ?? 0) / 1000);
    void (async () => {
      video.loop = false;
      video.playbackRate = 1;
      video.currentTime = startSeconds;
      await video.play();
      await startTrainingRecorder(video);
      // Replay from the exact checkpoint after the stream exposes its audio track.
      video.currentTime = startSeconds;
      return { ok: true, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0 };
    })().then(respond, (error: unknown) => {
      stopTrainingRecorder();
      respond({ ok: false, message: error instanceof Error ? error.message : "Không thể phát/thu audio video" });
    });
    return true;
  }
  if (request.action === "training-playback-status") {
    const video = document.querySelector<HTMLVideoElement>("video");
    respond(video ? { ok: true, ended: video.ended, paused: video.paused, currentMs: Math.round(video.currentTime * 1000) } : { ok: false });
    return;
  }
  if (request.action === "training-playback-stop") {
    document.querySelector<HTMLVideoElement>("video")?.pause();
    stopTrainingRecorder();
    respond({ ok: true });
    return;
  }
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
