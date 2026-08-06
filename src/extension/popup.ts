import type { ExtensionState } from "../shared/types";
import "./popup.css";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Không tìm thấy vùng giao diện");

app.innerHTML = `
  <header><img class="brand-mark" src="/PXH.jpg" alt="PXH logo"><div><h1>PXH Dubbing YooToob</h1><p>AI Vietnamese voice settings</p></div></header>
  <section class="status-card"><span id="statusDot" class="status-dot"></span><div><small>TRẠNG THÁI</small><strong id="status">Đang kiểm tra…</strong></div></section>
  <section class="info-grid">
    <div><span>Giọng đọc</span><strong>Hoài My</strong></div>
    <div><span>Nguồn</span><strong id="source">—</strong></div>
    <div><span>Đã xử lý</span><strong id="count">0 đoạn</strong></div>
  </section>
  <section class="settings">
    <div class="section-title">CÀI ĐẶT PHÁT</div>
    <label><div><span>Độ trễ</span><output id="delayValue">5 giây</output></div><input id="delay" type="range" min="2" max="15" value="5"></label>
    <label><div><span>Âm lượng giọng gốc</span><output id="volumeValue">25%</output></div><input id="volume" type="range" min="0" max="100" value="25"></label>
  </section>
  <footer>Cài đặt tự lưu. Đóng popup và nhấn Play nổi bên trái video.</footer>`;

const query = <T extends HTMLElement>(selector: string) => app.querySelector<T>(selector)!;
const delay = query<HTMLInputElement>("#delay");
const volume = query<HTMLInputElement>("#volume");

async function activeTab(): Promise<number | undefined> {
  return (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
}

function render(state?: ExtensionState): void {
  const value = state ?? { enabled: false, status: "idle", message: "Mở một video YouTube", processedSegments: 0, source: "—" };
  query("#status").textContent = value.message;
  query("#source").textContent = value.source;
  query("#count").textContent = `${value.processedSegments} đoạn`;
  query("#statusDot").className = `status-dot ${value.status}`;
}

function showSettings(delaySeconds: number, sourceVolume: number): void {
  delay.value = String(delaySeconds);
  volume.value = String(Math.round(sourceVolume * 100));
  query("#delayValue").textContent = `${delay.value} giây`;
  query("#volumeValue").textContent = `${volume.value}%`;
}

void chrome.storage.local.get({ delaySeconds: 5, sourceVolume: 0.25 }).then((stored) => {
  showSettings(Number(stored.delaySeconds), Number(stored.sourceVolume));
});

delay.addEventListener("input", () => {
  query("#delayValue").textContent = `${delay.value} giây`;
  void chrome.storage.local.set({ delaySeconds: Number(delay.value) });
});
volume.addEventListener("input", () => {
  query("#volumeValue").textContent = `${volume.value}%`;
  void chrome.storage.local.set({ sourceVolume: Number(volume.value) / 100 });
});

void activeTab().then(async (tabId) => {
  const state = tabId ? await chrome.tabs.sendMessage(tabId, { action: "status" }).catch(() => undefined) as ExtensionState | undefined : undefined;
  render(state);
});
