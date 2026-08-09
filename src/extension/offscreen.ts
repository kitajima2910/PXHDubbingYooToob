import { pcmRms, shouldFlushSpeech } from "./local-stt/vad";
import pcmWorkletUrl from "./local-stt/pcm-worklet.ts?worker&url";

let stream: MediaStream | undefined;
let targetTabId: number | undefined;
let audioContext: AudioContext | undefined;
let gainNode: GainNode | undefined;
let workletNode: AudioWorkletNode | undefined;
let modelWorker: Worker | undefined;
let modelReady = false;
let modelError = "";
let modelProgress = 0;
let recognitionBackend: "sherpa" | "whisper" | "loading" = "loading";
let sherpaRecognizer: any;
let sherpaStream: any;
let sherpaLastPartial = "";
let sherpaCommittedSource = "";
let sherpaUtteranceStartedAt = 0;
let transcriptionId = 0;
let backpressureActive = false;
const modelSubscribers = new Set<number>();
const pendingTranscriptions = new Map<number, { tabId: number; durationMs: number; capturedAt: number }>();

declare global {
  var Module: Record<string, unknown>;
  var createOnlineRecognizer: ((module: Record<string, unknown>) => any) | undefined;
  var __pxhSherpaRuntimeReady: boolean | undefined;
}

const FRAME_MS = 100;
const START_RMS = 0.012;
const END_SILENCE_MS = 350;
const MIN_SPEECH_MS = 400;
const MAX_SPEECH_MS = 5_000;
let preRoll: Float32Array[] = [];
let speechFrames: Float32Array[] = [];
let speaking = false;
let silenceMs = 0;

function worker(): Worker {
  if (!modelWorker) {
    modelWorker = new Worker(new URL("./local-stt/whisper-worker.ts", import.meta.url), { type: "module" });
    modelWorker.addEventListener("message", onWorkerMessage);
  }
  return modelWorker;
}

function publishModelEvent(event: Record<string, unknown>): void {
  for (const tabId of modelSubscribers) void chrome.runtime.sendMessage({ action: "local-model-event", tabId, ...event });
}

function onWorkerMessage(event: MessageEvent<Record<string, unknown>>): void {
  const message = event.data;
  if (message.type === "model-progress") {
    modelProgress = typeof message.progress === "number" ? message.progress : modelProgress;
    publishModelEvent({ type: "progress", progress: modelProgress });
    return;
  }
  if (message.type === "model-ready") {
    modelReady = true; modelError = ""; modelProgress = 100;
    publishModelEvent({ type: "ready", progress: 100 });
    return;
  }
  if (message.type === "model-error") {
    modelReady = false; modelError = String(message.message ?? "Không tải được Whisper local");
    publishModelEvent({ type: "error", message: modelError });
    return;
  }
  if (message.type === "transcription" || message.type === "transcription-error") {
    const id = Number(message.id);
    const pending = pendingTranscriptions.get(id);
    if (!pending) return;
    pendingTranscriptions.delete(id);
    updateBackpressure(pending.tabId);
    if (message.type === "transcription-error") {
      void chrome.runtime.sendMessage({ action: "capture-local-error", tabId: pending.tabId, message: message.message });
    } else {
      void chrome.runtime.sendMessage({
        action: "capture-local-chunk", tabId: pending.tabId, durationMs: pending.durationMs, capturedAt: pending.capturedAt,
        segments: Array.isArray(message.segments) ? message.segments : [],
      });
    }
  }
}

function updateBackpressure(tabId: number): void {
  const active = pendingTranscriptions.size >= 2;
  if (active === backpressureActive) return;
  backpressureActive = active;
  void chrome.runtime.sendMessage({ action: "capture-local-backpressure", tabId, active });
}

function initWhisperModel(): void {
  recognitionBackend = "whisper";
  worker().postMessage({ type: "init" });
}

function initializeSherpa(): void {
  if (sherpaRecognizer || !globalThis.__pxhSherpaRuntimeReady) return;
  try {
    if (typeof globalThis.createOnlineRecognizer !== "function") throw new Error("Sherpa API chưa sẵn sàng");
    sherpaRecognizer = globalThis.createOnlineRecognizer(globalThis.Module);
    recognitionBackend = "sherpa";
    modelReady = true; modelError = ""; modelProgress = 100;
    publishModelEvent({ type: "ready", progress: 100, backend: "sherpa-streaming" });
  } catch (error) {
    modelError = error instanceof Error ? error.message : "Không khởi tạo được sherpa-onnx";
    initWhisperModel();
  }
}

globalThis.addEventListener("pxh-sherpa-ready", initializeSherpa);
globalThis.addEventListener("pxh-sherpa-error", (event) => {
  modelError = String((event as CustomEvent<unknown>).detail ?? "Sherpa streaming không khả dụng");
  if (!modelReady && recognitionBackend === "loading") initWhisperModel();
});
globalThis.addEventListener("pxh-sherpa-status", (event) => {
  const detail = (event as CustomEvent<{ progress?: number }>).detail;
  if (typeof detail?.progress === "number") modelProgress = detail.progress;
  publishModelEvent({ type: "progress", progress: modelProgress, backend: "sherpa-streaming" });
});

function initModel(tabId?: number): void {
  if (tabId !== undefined) modelSubscribers.add(tabId);
  if (modelReady) { publishModelEvent({ type: "ready", progress: 100 }); return; }
  modelError = "";
  publishModelEvent({ type: "progress", progress: modelProgress });
  initializeSherpa();
  if (!globalThis.__pxhSherpaRuntimeReady) {
    globalThis.setTimeout(() => { if (!modelReady && recognitionBackend === "loading") initWhisperModel(); }, 20_000);
  }
}

function resetVad(): void {
  preRoll = []; speechFrames = []; speaking = false; silenceMs = 0;
  if (sherpaStream) { sherpaStream.free(); sherpaStream = undefined; }
  sherpaLastPartial = ""; sherpaCommittedSource = ""; sherpaUtteranceStartedAt = 0;
}

function stablePrefix(previous: string, current: string): string {
  let length = 0;
  while (length < previous.length && length < current.length && previous[length] === current[length]) length += 1;
  let prefix = current.slice(0, length).trimEnd();
  if (!/[\u3400-\u9fff]/u.test(prefix)) prefix = prefix.slice(0, Math.max(0, prefix.lastIndexOf(" "))).trimEnd();
  return prefix;
}

function publishStableSpeech(previous: string, current: string): void {
  if (targetTabId === undefined || !previous || !current) return;
  const stable = stablePrefix(previous, current);
  if (!stable.startsWith(sherpaCommittedSource)) return;
  const delta = stable.slice(sherpaCommittedSource.length).trim();
  const enough = /[.!?。！？,，;；:]$/u.test(delta)
    || (/[\u3400-\u9fff]/u.test(delta) ? delta.length >= 6 : delta.split(/\s+/u).length >= 3);
  if (!enough) return;
  sherpaCommittedSource = stable;
  void chrome.runtime.sendMessage({ action: "capture-local-stable", tabId: targetTabId, text: delta });
}

function joinFrames(frames: Float32Array[]): Float32Array {
  const length = frames.reduce((total, frame) => total + frame.length, 0);
  const output = new Float32Array(length);
  let offset = 0;
  for (const frame of frames) { output.set(frame, offset); offset += frame.length; }
  return output;
}

function flushSpeech(): void {
  if (targetTabId === undefined || speechFrames.length * FRAME_MS < MIN_SPEECH_MS) { resetVad(); return; }
  const samples = joinFrames(speechFrames);
  const id = transcriptionId++;
  pendingTranscriptions.set(id, { tabId: targetTabId, durationMs: Math.round(samples.length / 16), capturedAt: Date.now() });
  updateBackpressure(targetTabId);
  worker().postMessage({ type: "transcribe", id, samples }, [samples.buffer]);
  resetVad();
}

function acceptPcm(samples: Float32Array): void {
  if (recognitionBackend === "sherpa" && sherpaRecognizer && targetTabId !== undefined) {
    if (!sherpaStream) {
      sherpaStream = sherpaRecognizer.createStream();
      sherpaUtteranceStartedAt = Date.now();
    }
    sherpaStream.acceptWaveform(16_000, samples);
    while (sherpaRecognizer.isReady(sherpaStream)) sherpaRecognizer.decode(sherpaStream);
    const text = String(sherpaRecognizer.getResult(sherpaStream)?.text ?? "").trim();
    if (text && text !== sherpaLastPartial) {
      publishStableSpeech(sherpaLastPartial, text);
      sherpaLastPartial = text;
      void chrome.runtime.sendMessage({ action: "capture-local-partial", tabId: targetTabId, text });
    }
    if (sherpaRecognizer.isEndpoint(sherpaStream)) {
      const durationMs = Math.max(400, Date.now() - sherpaUtteranceStartedAt);
      const remainingText = text.startsWith(sherpaCommittedSource) ? text.slice(sherpaCommittedSource.length).trim() : text;
      if (text) void chrome.runtime.sendMessage({
        action: "capture-local-final", tabId: targetTabId, durationMs, capturedAt: Date.now(), text: remainingText, fullText: text,
      });
      sherpaRecognizer.reset(sherpaStream);
      sherpaLastPartial = ""; sherpaCommittedSource = ""; sherpaUtteranceStartedAt = Date.now();
    }
    return;
  }
  const rms = pcmRms(samples);
  if (!speaking) {
    preRoll.push(samples);
    if (preRoll.length > 2) preRoll.shift();
    if (rms >= START_RMS) {
      speaking = true; speechFrames = [...preRoll]; preRoll = []; silenceMs = 0;
    }
    return;
  }
  speechFrames.push(samples);
  silenceMs = rms < START_RMS ? silenceMs + FRAME_MS : 0;
  const durationMs = speechFrames.length * FRAME_MS;
  if (shouldFlushSpeech(durationMs, silenceMs, MIN_SPEECH_MS, END_SILENCE_MS, MAX_SPEECH_MS)) flushSpeech();
}

function stopCapture(): void {
  resetVad();
  pendingTranscriptions.clear(); backpressureActive = false;
  workletNode?.disconnect(); workletNode = undefined;
  stream?.getTracks().forEach((track) => track.stop()); stream = undefined;
  void audioContext?.close(); audioContext = undefined;
  gainNode = undefined; targetTabId = undefined;
}

async function startCapture(streamId: string, tabId: number, sourceVolume: number): Promise<{ ok: true }> {
  if (!modelReady) throw new Error(modelError || "Model Whisper local chưa sẵn sàng");
  stopCapture();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } }, video: false,
  } as MediaStreamConstraints);
  targetTabId = tabId;
  audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule(pcmWorkletUrl);
  const source = audioContext.createMediaStreamSource(stream);
  gainNode = audioContext.createGain(); gainNode.gain.value = Math.max(0, Math.min(1, sourceVolume));
  workletNode = new AudioWorkletNode(audioContext, "pxh-pcm-processor", { numberOfInputs: 1, numberOfOutputs: 0 });
  workletNode.port.onmessage = (event: MessageEvent<{ type?: string; samples?: Float32Array }>): void => {
    if (event.data.type === "pcm" && event.data.samples) acceptPcm(event.data.samples);
  };
  source.connect(gainNode).connect(audioContext.destination);
  source.connect(workletNode);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, respond) => {
  const request = message as { action?: string; streamId?: string; tabId?: number; sourceVolume?: number } | null;
  if (request?.action === "capture-offscreen-model-init") {
    initModel(request.tabId); respond({ ok: true, ready: modelReady, progress: modelProgress, message: modelError }); return;
  }
  if (request?.action === "capture-offscreen-model-status") {
    respond({ ok: true, ready: modelReady, progress: modelProgress, message: modelError }); return;
  }
  if (request?.action === "capture-offscreen-stop") { stopCapture(); respond({ ok: true }); return; }
  if (request?.action === "capture-offscreen-status") { respond({ ok: true, active: stream?.active === true, tabId: targetTabId, modelReady }); return; }
  if (request?.action === "capture-offscreen-volume") {
    if (gainNode) gainNode.gain.value = Math.max(0, Math.min(1, request.sourceVolume ?? 1));
    respond({ ok: Boolean(gainNode), active: stream?.active === true, tabId: targetTabId }); return;
  }
  if (request?.action === "capture-offscreen-reset") { resetVad(); respond({ ok: true }); return; }
  if (request?.action !== "capture-offscreen-start" || !request.streamId || request.tabId === undefined) return;
  void startCapture(request.streamId, request.tabId, request.sourceVolume ?? 0.08).then(respond, (error: unknown) =>
    respond({ ok: false, message: error instanceof Error ? error.message : "Không thể thu âm tab" }));
  return true;
});

export {};
