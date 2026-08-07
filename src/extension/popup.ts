import type { ExtensionState } from "../shared/types";
import "./popup.css";
import "./training.css";
import { prepareBrowserTranslation } from "./translation/browser-translator";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Không tìm thấy vùng giao diện");

app.innerHTML = `
  <header><img class="brand-mark" src="/PXH.jpg" alt="PXH logo"><div><h1>PXH Dubbing YooToob</h1><p>Realtime Vietnamese AI dubbing</p></div></header>
  <section class="status-card"><span id="statusDot" class="status-dot"></span><div><small>TRẠNG THÁI</small><strong id="status">Đang kiểm tra…</strong></div></section>
  <button id="dubbingToggle" class="dubbing-toggle" type="button" disabled>Bắt đầu lồng tiếng</button>
  <section class="info-grid">
    <div><span>Giọng đọc</span><strong>Chrome / Hoài My</strong></div>
    <div class="source-info"><span>Chế độ</span><strong id="source" style="overflow:visible;white-space:normal;line-height:1.25">—</strong></div>
    <div><span>Đã xử lý</span><strong id="count">0 đoạn</strong></div>
  </section>
  <section class="config-card"><div><span>Nhận dạng</span><strong>DOM → Groq Whisper</strong></div><div><span>Âm thanh gốc</span><strong>8%</strong></div></section>
  <section class="api-card">
    <div class="api-heading"><div><span>GROQ API KEY</span><strong id="keyState">Đang kiểm tra…</strong></div><small>Lưu cục bộ trên Chrome</small></div>
    <form id="keyForm"><input id="groqKey" type="password" autocomplete="off" spellcheck="false" placeholder="gsk_••••••••••••"><button type="submit">Lưu</button></form>
    <button id="useDefault" class="default-key" type="button">Dùng API key mặc định</button>
  </section>
  <section class="api-card training-card">
    <div class="api-heading"><div><span>PRE-TRAIN VIDEO / PLAYLIST</span><strong id="trainingState">Chưa chạy</strong></div><small>Tối đa 100 video/lần</small></div>
    <form id="trainingForm"><input id="playlistUrl" type="url" spellcheck="false" placeholder="Dán URL video hoặc playlist YouTube"><button id="trainPlaylist" type="submit">Train</button></form>
    <button id="resetTraining" class="stop-training" type="button" hidden>Dừng Train</button>
  </section>
  <footer>Điều khiển dubbing trực tiếp tại popup này.</footer>`;

const query = <T extends HTMLElement>(selector: string) => app.querySelector<T>(selector)!;

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  return (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
}

let tab: chrome.tabs.Tab | undefined;
let currentState: ExtensionState | undefined;
let toggling = false;

function render(state?: ExtensionState): void {
  const value = state ?? { enabled: false, status: "idle", message: "Mở một video YouTube", processedSegments: 0, source: "—" };
  currentState = value;
  query("#status").textContent = value.message;
  query("#source").textContent = value.source;
  query("#count").textContent = `${value.processedSegments} đoạn`;
  query("#statusDot").className = `status-dot ${value.status}`;
  const toggle = query<HTMLButtonElement>("#dubbingToggle");
  toggle.disabled = toggling || !tab?.id || !tab.url?.startsWith("https://www.youtube.com/watch");
  toggle.dataset.active = String(value.enabled);
  toggle.textContent = toggling ? "Đang chuẩn bị…" : value.enabled ? "Dừng lồng tiếng" : "Bắt đầu lồng tiếng";
}

const keyInput = query<HTMLInputElement>("#groqKey");
const defaultKeyButton = query<HTMLButtonElement>("#useDefault");

async function renderKeyState(): Promise<void> {
  const [stored, session] = await Promise.all([
    chrome.storage.local.get("groqApiKey"), chrome.storage.session.get("groqCooldownUntil"),
  ]);
  const hasCustomKey = typeof stored.groqApiKey === "string" && stored.groqApiKey.length > 0;
  const coolingDown = hasCustomKey && Number(session.groqCooldownUntil ?? 0) > Date.now();
  query("#keyState").textContent = coolingDown
    ? "Key riêng hết quota — đang tự dùng mặc định"
    : hasCustomKey ? "Đang dùng key riêng (có tự chuyển)" : "Đang dùng key mặc định";
  defaultKeyButton.disabled = !hasCustomKey;
  defaultKeyButton.textContent = hasCustomKey ? "Chuyển sang key mặc định" : "✓ Đang dùng API key mặc định";
}

query<HTMLFormElement>("#keyForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const apiKey = keyInput.value.trim();
  if (!/^gsk_[A-Za-z0-9_-]{20,}$/.test(apiKey)) {
    query("#keyState").textContent = "API key không hợp lệ";
    keyInput.focus();
    return;
  }
  void Promise.all([
    chrome.storage.local.set({ groqApiKey: apiKey }), chrome.storage.session.remove("groqCooldownUntil"),
  ]).then(() => {
    keyInput.value = "";
    void renderKeyState();
  });
});

defaultKeyButton.addEventListener("click", () => {
  void Promise.all([
    chrome.storage.local.remove("groqApiKey"), chrome.storage.session.remove("groqCooldownUntil"),
  ]).then(() => {
    keyInput.value = "";
    void renderKeyState();
  });
});

void renderKeyState();

const trainingButton = query<HTMLButtonElement>("#trainPlaylist");
const trainingInput = query<HTMLInputElement>("#playlistUrl");
const resetTrainingButton = query<HTMLButtonElement>("#resetTraining");
void chrome.storage.local.get("playlistTrainingUrl").then(({ playlistTrainingUrl }) => {
  if (!trainingInput.value && typeof playlistTrainingUrl === "string") trainingInput.value = playlistTrainingUrl;
});
trainingInput.addEventListener("input", () => {
  void chrome.storage.local.set({ playlistTrainingUrl: trainingInput.value });
});
resetTrainingButton.addEventListener("click", () => {
  void chrome.runtime.sendMessage({ action: "playlist-train-reset" }).then(() => renderTrainingState());
});
async function renderTrainingState(): Promise<void> {
  const stored = await chrome.storage.local.get("playlistTraining");
  const training = stored.playlistTraining as { running?: boolean; message?: string } | undefined;
  query("#trainingState").textContent = training?.message ?? "Chưa chạy";
  trainingButton.disabled = training?.running === true;
  resetTrainingButton.disabled = training?.running !== true;
  resetTrainingButton.hidden = training?.running !== true;
}
query<HTMLFormElement>("#trainingForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const url = trainingInput.value.trim();
  if (!url) return;
  void chrome.storage.local.set({ playlistTrainingUrl: url });
  trainingButton.disabled = true;
  query("#trainingState").textContent = "Đang khởi tạo…";
  void chrome.runtime.sendMessage({ action: "playlist-train", body: url }).then((response: { ok?: boolean; message?: string }) => {
    if (!response?.ok) query("#trainingState").textContent = response?.message ?? "Train thất bại";
  }).finally(() => { void renderTrainingState(); });
});
void renderTrainingState();
window.setInterval(() => { void renderTrainingState(); }, 1_000);

query<HTMLButtonElement>("#dubbingToggle").addEventListener("click", () => {
  if (toggling || !tab?.id) return;
  toggling = true; render(currentState);
  void (async () => {
    if (currentState?.enabled) {
      return chrome.tabs.sendMessage(tab!.id!, { action: "stop" }) as Promise<ExtensionState>;
    }
    // Start any browser-managed language-pack download during the user's click.
    // This is best-effort and never blocks the normal Groq/cache path.
    void prepareBrowserTranslation().catch(() => undefined);
    const capture = await chrome.runtime.sendMessage({ action: "capture-start", tabId: tab!.id, sourceVolume: 0.08 }) as { ok?: boolean; message?: string };
    const result = await chrome.tabs.sendMessage(tab!.id!, { action: "start", delaySeconds: 5, sourceVolume: 0.08 }) as ExtensionState;
    if (result.source.startsWith("Whisper") && !capture?.ok) {
      await chrome.tabs.sendMessage(tab!.id!, { action: "stop" }).catch(() => undefined);
      throw new Error(capture?.message ?? "Không thể cấp quyền thu âm tab");
    }
    if (!result.enabled && result.status === "error") void chrome.runtime.sendMessage({ action: "capture-stop" });
    return result;
  })().then((state) => render(state), (error: unknown) => render({
    enabled: false, status: "error", message: error instanceof Error ? error.message : "Không thể điều khiển dubbing", processedSegments: 0, source: "—",
  })).finally(() => { toggling = false; render(currentState); });
});

void activeTab().then(async (active) => {
  tab = active;
  if (!tab?.id || !tab.url?.startsWith("https://www.youtube.com/watch")) { render(); return; }
  render(await chrome.tabs.sendMessage(tab.id, { action: "status" }).catch(() => undefined) as ExtensionState | undefined);
});
