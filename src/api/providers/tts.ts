// Legacy re-export — sử dụng AzureTtsProvider (primary) và EdgeTtsProvider (fallback) từ các file riêng.
export type { TtsProvider } from "./azure-tts.js";
export { AzureTtsProvider } from "./azure-tts.js";
export { EdgeTtsProvider } from "./tts-edge.js";
