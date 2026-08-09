globalThis.Module = {
  locateFile(path) {
    return chrome.runtime.getURL(`sherpa/${path}`);
  },
  setStatus(status) {
    const match = String(status).match(/Downloading data\.\.\. \((\d+)\/(\d+)\)/);
    const progress = match ? Math.round((Number(match[1]) / Math.max(1, Number(match[2]))) * 100) : undefined;
    globalThis.dispatchEvent(new CustomEvent("pxh-sherpa-status", { detail: { status, progress } }));
  },
  onRuntimeInitialized() {
    globalThis.__pxhSherpaRuntimeReady = true;
    globalThis.dispatchEvent(new Event("pxh-sherpa-ready"));
  },
};

const modelParts = [
  "sherpa-onnx-wasm-main-asr.data.part-00",
  "sherpa-onnx-wasm-main-asr.data.part-01",
  "sherpa-onnx-wasm-main-asr.data.part-02",
];
const modelSize = 199059238;

async function loadModelParts() {
  const model = new Uint8Array(modelSize);
  let offset = 0;
  for (const name of modelParts) {
    const response = await fetch(chrome.runtime.getURL(`sherpa/${name}`));
    if (!response.ok || !response.body) throw new Error(`Không tải được ${name}`);
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      model.set(value, offset);
      offset += value.length;
      Module.setStatus(`Downloading data... (${offset}/${modelSize})`);
    }
  }
  if (offset !== modelSize) throw new Error(`Model thiếu dữ liệu: ${offset}/${modelSize}`);
  Module.getPreloadedPackage = () => model.buffer;
  const runtime = document.createElement("script");
  runtime.src = chrome.runtime.getURL("sherpa/sherpa-onnx-wasm-main-asr.js");
  runtime.onerror = () => globalThis.dispatchEvent(new CustomEvent("pxh-sherpa-error", { detail: "Không tải được Sherpa WASM" }));
  document.head.append(runtime);
}

void loadModelParts().catch((error) => {
  globalThis.dispatchEvent(new CustomEvent("pxh-sherpa-error", { detail: error instanceof Error ? error.message : String(error) }));
});
