let stream: MediaStream | undefined;
let recorder: MediaRecorder | undefined;
let timer = 0;
let targetTabId: number | undefined;
let audioContext: AudioContext | undefined;
let gainNode: GainNode | undefined;
let mediaSource: MediaStreamAudioSourceNode | undefined;
let assemblySocket: WebSocket | undefined;
let assemblyProcessor: ScriptProcessorNode | undefined;
let assemblySink: GainNode | undefined;
let assemblyClosing = false;
const discardedRecorders = new WeakSet<MediaRecorder>();

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function stopCapture(): void {
  window.clearTimeout(timer);
  stopAssemblyStream();
  recorder?.stop(); recorder = undefined;
  stream?.getTracks().forEach((track) => track.stop()); stream = undefined;
  void audioContext?.close(); audioContext = undefined;
  gainNode = undefined;
  mediaSource = undefined;
  targetTabId = undefined;
}

function stopAssemblyStream(): void {
  if (mediaSource && assemblyProcessor) {
    try { mediaSource.disconnect(assemblyProcessor); }
    catch { /* Node may already be disconnected during capture shutdown. */ }
  }
  assemblyProcessor?.disconnect(); assemblyProcessor = undefined;
  assemblySink?.disconnect(); assemblySink = undefined;
  if (assemblySocket) {
    assemblyClosing = true;
    if (assemblySocket.readyState === WebSocket.OPEN) assemblySocket.send(JSON.stringify({ type: "Terminate" }));
    assemblySocket.close();
    assemblySocket = undefined;
  }
}

function sendAssemblyFailure(message: string): void {
  if (targetTabId !== undefined) void chrome.runtime.sendMessage({ action: "assembly-stream-error", tabId: targetTabId, message });
}

function startAssemblyStream(token: string): void {
  if (!stream?.active || !audioContext || !mediaSource || targetTabId === undefined) throw new Error("Luồng âm thanh tab chưa sẵn sàng");
  stopAssemblyStream();
  assemblyClosing = false;
  const url = new URL("wss://streaming.assemblyai.com/v3/ws");
  url.searchParams.set("token", token);
  url.searchParams.set("sample_rate", String(Math.round(audioContext.sampleRate)));
  url.searchParams.set("speech_model", "whisper-rt");
  url.searchParams.set("language_detection", "true");
  url.searchParams.set("format_turns", "true");
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  assemblySocket = socket;

  if (recorder?.state === "recording") {
    discardedRecorders.add(recorder);
    recorder.stop();
    recorder = undefined;
  }

  socket.addEventListener("open", () => {
    if (assemblySocket !== socket || !audioContext || !mediaSource) return;
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const sink = audioContext.createGain();
    sink.gain.value = 0;
    processor.onaudioprocess = (event) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const samples = event.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(samples.length);
      for (let index = 0; index < samples.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
        pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      socket.send(pcm.buffer);
    };
    mediaSource.connect(processor);
    processor.connect(sink).connect(audioContext.destination);
    assemblyProcessor = processor;
    assemblySink = sink;
  });
  socket.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(String(event.data)) as {
        type?: string; turn_order?: number; end_of_turn?: boolean; turn_is_formatted?: boolean;
        transcript?: string; utterance?: string; language_code?: string;
        words?: Array<{ start?: number; end?: number; text?: string }>;
      };
      if (payload.type !== "Turn" || !payload.end_of_turn) return;
      void chrome.runtime.sendMessage({
        action: "assembly-turn", tabId: targetTabId, turnOrder: payload.turn_order,
        text: payload.utterance?.trim() || payload.transcript?.trim() || "",
        words: payload.words ?? [], language: payload.language_code ?? "",
      });
    } catch { /* Bỏ qua message điều khiển không phải JSON Turn. */ }
  });
  socket.addEventListener("error", () => sendAssemblyFailure("Không thể kết nối AssemblyAI realtime"));
  socket.addEventListener("close", () => {
    const unexpected = !assemblyClosing && assemblySocket === socket;
    if (assemblySocket === socket) assemblySocket = undefined;
    assemblyProcessor?.disconnect(); assemblyProcessor = undefined;
    assemblySink?.disconnect(); assemblySink = undefined;
    if (unexpected) {
      sendAssemblyFailure("Kết nối AssemblyAI đã đóng");
      if (stream?.active && !recorder) recordChunk();
    }
  });
}

function recordChunk(): void {
  if (!stream || targetTabId === undefined) return;
  const chunks: Blob[] = [];
  const startedAt = Date.now();
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  const current = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 48_000 });
  recorder = current;
  current.addEventListener("dataavailable", (event) => { if (event.data.size) chunks.push(event.data); });
  current.addEventListener("stop", () => {
    if (discardedRecorders.has(current)) {
      if (stream?.active && !assemblySocket) recordChunk();
      return;
    }
    if (!chunks.length || targetTabId === undefined) return;
    const durationMs = Date.now() - startedAt;
    void new Blob(chunks, { type: mimeType }).arrayBuffer().then((buffer) => chrome.runtime.sendMessage({
      action: "capture-chunk", tabId: targetTabId, audioBase64: bufferToBase64(buffer), mimeType, durationMs,
    })).finally(() => { if (stream?.active) recordChunk(); });
  }, { once: true });
  current.start();
  timer = window.setTimeout(() => { if (current.state === "recording") current.stop(); }, 5_000);
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, respond) => {
  const request = message as { action?: string; streamId?: string; tabId?: number; sourceVolume?: number } | null;
  if (request?.action === "capture-offscreen-stop") { stopCapture(); respond({ ok: true }); return; }
  if (request?.action === "capture-offscreen-status") {
    respond({ ok: true, active: stream?.active === true, tabId: targetTabId });
    return;
  }
  if (request?.action === "capture-offscreen-volume") {
    if (gainNode) gainNode.gain.value = Math.max(0, Math.min(1, request.sourceVolume ?? 1));
    respond({ ok: Boolean(gainNode), active: stream?.active === true, tabId: targetTabId });
    return;
  }
  if (request?.action === "capture-offscreen-reset") {
    window.clearTimeout(timer);
    stopAssemblyStream();
    if (recorder?.state === "recording") {
      discardedRecorders.add(recorder);
      recorder.stop();
    } else if (stream?.active) recordChunk();
    respond({ ok: true });
    return;
  }
  if (request?.action === "assembly-offscreen-start") {
    const token = (message as { token?: string }).token;
    try {
      if (!token) throw new Error("Thiếu token AssemblyAI");
      startAssemblyStream(token);
      respond({ ok: true });
    } catch (error) {
      respond({ ok: false, message: error instanceof Error ? error.message : "Không thể bắt đầu AssemblyAI" });
    }
    return;
  }
  if (request?.action !== "capture-offscreen-start" || !request.streamId || request.tabId === undefined) return;
  void (async () => {
    stopCapture();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: request.streamId } }, video: false,
    } as MediaStreamConstraints);
    targetTabId = request.tabId;
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    mediaSource = source;
    gainNode = audioContext.createGain(); gainNode.gain.value = Math.max(0, Math.min(1, request.sourceVolume ?? 0.08));
    source.connect(gainNode).connect(audioContext.destination);
    recordChunk();
    return { ok: true };
  })().then(respond, (error: unknown) => respond({ ok: false, message: error instanceof Error ? error.message : "Không thể thu âm tab" }));
  return true;
});

export {};
