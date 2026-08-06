let stream: MediaStream | undefined;
let recorder: MediaRecorder | undefined;
let timer = 0;
let targetTabId: number | undefined;
let audioContext: AudioContext | undefined;
let gainNode: GainNode | undefined;
const discardedRecorders = new WeakSet<MediaRecorder>();

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function stopCapture(): void {
  window.clearTimeout(timer);
  recorder?.stop(); recorder = undefined;
  stream?.getTracks().forEach((track) => track.stop()); stream = undefined;
  void audioContext?.close(); audioContext = undefined;
  gainNode = undefined;
  targetTabId = undefined;
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
      if (stream?.active) recordChunk();
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
    if (recorder?.state === "recording") {
      discardedRecorders.add(recorder);
      recorder.stop();
    } else if (stream?.active) recordChunk();
    respond({ ok: true });
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
    gainNode = audioContext.createGain(); gainNode.gain.value = Math.max(0, Math.min(1, request.sourceVolume ?? 0.18));
    source.connect(gainNode).connect(audioContext.destination);
    recordChunk();
    return { ok: true };
  })().then(respond, (error: unknown) => respond({ ok: false, message: error instanceof Error ? error.message : "Không thể thu âm tab" }));
  return true;
});

export {};
