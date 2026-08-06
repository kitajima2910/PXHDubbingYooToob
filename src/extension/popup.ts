import type { ExtensionState } from "../shared/types";
import "./popup.css";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Không tìm thấy vùng giao diện");

app.innerHTML = `
  <header><img class="brand-mark" src="/PXH.jpg" alt="PXH logo"><div><h1>PXH Dubbing YooToob</h1><p>Realtime Vietnamese AI dubbing</p></div></header>
  <section class="status-card"><span id="statusDot" class="status-dot"></span><div><small>TRẠNG THÁI</small><strong id="status">Đang kiểm tra…</strong></div></section>
  <section class="info-grid">
    <div><span>Giọng đọc</span><strong>Hoài My</strong></div>
    <div><span>Nguồn</span><strong id="source">—</strong></div>
    <div><span>Đã xử lý</span><strong id="count">0 đoạn</strong></div>
  </section>
  <section class="config-card"><div><span>Độ trễ tự động</span><strong>6 giây</strong></div><div><span>Âm thanh gốc</span><strong>8%</strong></div></section>
  <section class="api-card">
    <div class="api-heading"><div><span>GROQ API KEY</span><strong id="keyState">Đang kiểm tra…</strong></div><small>Lưu cục bộ trên Chrome</small></div>
    <form id="keyForm"><input id="groqKey" type="password" autocomplete="off" spellcheck="false" placeholder="gsk_••••••••••••"><button type="submit">Lưu</button></form>
    <button id="useDefault" class="default-key" type="button">Dùng API key mặc định</button>
  </section>
  <footer>Đóng popup và nhấn Play nổi bên trái video.</footer>`;

const query = <T extends HTMLElement>(selector: string) => app.querySelector<T>(selector)!;

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  return (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
}

function render(state?: ExtensionState): void {
  const value = state ?? { enabled: false, status: "idle", message: "Mở một video YouTube", processedSegments: 0, source: "—" };
  query("#status").textContent = value.message;
  query("#source").textContent = value.source;
  query("#count").textContent = `${value.processedSegments} đoạn`;
  query("#statusDot").className = `status-dot ${value.status}`;
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

void activeTab().then(async (tab) => {
  if (!tab?.id || !tab.url?.startsWith("https://www.youtube.com/watch")) { render(); return; }
  let state = await chrome.tabs.sendMessage(tab.id, { action: "status" }).catch(() => undefined) as ExtensionState | undefined;
  if (!state?.enabled) {
    const prepared = await chrome.runtime.sendMessage({ action: "capture-prepare", tabId: tab.id }) as { ok?: boolean; message?: string };
    if (prepared?.ok) {
      state = await chrome.tabs.sendMessage(tab.id, { action: "capture-ready" }).catch(() => state) as ExtensionState | undefined;
    } else {
      state = { enabled: false, status: "error", message: prepared?.message ?? "Không thể cấp quyền thu âm tab", processedSegments: 0, source: "—" };
    }
  }
  render(state);
});
