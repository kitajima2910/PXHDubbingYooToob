import { env, pipeline } from "@huggingface/transformers";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import jsepWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url";

const MODEL_ID = "onnx-community/whisper-tiny";
type Transcriber = Awaited<ReturnType<typeof pipeline<"automatic-speech-recognition">>>;
let transcriberPromise: Promise<Transcriber> | undefined;
interface TranscriptionJob { id: number; samples: Float32Array }
const transcriptionQueue: TranscriptionJob[] = [];
let transcriptionRunning = false;

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.useWasmCache = true;
env.backends.onnx.wasm!.wasmPaths = {
  "ort-wasm-simd-threaded.wasm": wasmUrl,
  "ort-wasm-simd-threaded.jsep.wasm": jsepWasmUrl,
} as never;
// MV3 Worker không cho ONNX tạo blob worker phụ; một thread là đường fallback
// ổn định. WebGPU vẫn là backend ưu tiên trên máy hỗ trợ.
env.backends.onnx.wasm!.numThreads = 1;

interface ProgressInfo { status?: string; file?: string; progress?: number; loaded?: number; total?: number }
const files = new Map<string, { loaded: number; total: number }>();

function reportProgress(info: ProgressInfo): void {
  const file = info.file ?? info.status ?? "model";
  if (Number.isFinite(info.total) && (info.total ?? 0) > 0) {
    files.set(file, { loaded: info.loaded ?? 0, total: info.total ?? 0 });
  }
  let loaded = 0; let total = 0;
  for (const value of files.values()) { loaded += value.loaded; total += value.total; }
  const progress = total > 0 ? Math.round(loaded / total * 100) : Math.round(info.progress ?? 0);
  self.postMessage({ type: "model-progress", progress: Math.max(0, Math.min(100, progress)), status: info.status ?? "downloading" });
}

async function createTranscriber(device: "webgpu" | "wasm"): Promise<Transcriber> {
  return pipeline("automatic-speech-recognition", MODEL_ID, {
    device,
    dtype: device === "webgpu" ? "fp16" : "q8",
    progress_callback: reportProgress,
  });
}

async function getTranscriber(): Promise<Transcriber> {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      try {
        if ("gpu" in navigator) return await createTranscriber("webgpu");
      } catch (error) {
        self.postMessage({ type: "model-warning", message: `WebGPU không khả dụng, chuyển sang CPU: ${error instanceof Error ? error.message : "lỗi không xác định"}` });
      }
      return createTranscriber("wasm");
    })();
  }
  try { return await transcriberPromise; }
  catch (error) { transcriberPromise = undefined; throw error; }
}

async function transcribe(id: number, samples: Float32Array): Promise<void> {
  const transcriber = await getTranscriber();
  const result = await transcriber(samples, { return_timestamps: true, task: "transcribe" });
  const output = result as { text?: string; chunks?: Array<{ text?: string; timestamp?: [number | null, number | null] }> };
  const segments = (output.chunks ?? []).flatMap((chunk, index) => {
    const text = chunk.text?.replace(/\s+/g, " ").trim();
    if (!text) return [];
    const start = chunk.timestamp?.[0] ?? 0;
    const end = chunk.timestamp?.[1] ?? Math.max(start + 0.5, samples.length / 16_000);
    return [{ id: `local-${id}-${index}`, startMs: Math.max(0, Math.round(start * 1000)), endMs: Math.max(500, Math.round(end * 1000)), sourceText: text }];
  });
  if (!segments.length && output.text?.trim()) {
    segments.push({ id: `local-${id}-0`, startMs: 0, endMs: Math.max(500, Math.round(samples.length / 16)), sourceText: output.text.trim() });
  }
  self.postMessage({ type: "transcription", id, segments });
}

function drainTranscriptions(): void {
  if (transcriptionRunning) return;
  transcriptionRunning = true;
  void (async () => {
    while (transcriptionQueue.length) {
      const job = transcriptionQueue.shift()!;
      try { await transcribe(job.id, job.samples); }
      catch (error) {
        self.postMessage({ type: "transcription-error", id: job.id, message: error instanceof Error ? error.message : "Whisper local thất bại" });
      }
    }
  })().finally(() => {
    transcriptionRunning = false;
    if (transcriptionQueue.length) drainTranscriptions();
  });
}

function enqueueTranscription(job: TranscriptionJob): void {
  // Giữ câu đang xử lý và tối đa hai câu mới nhất; không để inference chồng nhau
  // làm tranh GPU với video. Câu quá cũ được báo bỏ để offscreen giải phóng pending.
  while (transcriptionQueue.length >= 2) {
    const dropped = transcriptionQueue.shift()!;
    self.postMessage({ type: "transcription-error", id: dropped.id, message: "Máy đang bận, bỏ đoạn nhận dạng đã quá cũ" });
  }
  transcriptionQueue.push(job);
  drainTranscriptions();
}

self.addEventListener("message", (event: MessageEvent<{ type?: string; id?: number; samples?: Float32Array }>) => {
  if (event.data.type === "init") {
    void getTranscriber().then(
      () => self.postMessage({ type: "model-ready" }),
      (error: unknown) => self.postMessage({ type: "model-error", message: error instanceof Error ? error.message : "Không tải được Whisper local" }),
    );
  }
  if (event.data.type === "transcribe" && event.data.samples && event.data.id !== undefined) {
    enqueueTranscription({ id: event.data.id, samples: event.data.samples });
  }
});

export {};
