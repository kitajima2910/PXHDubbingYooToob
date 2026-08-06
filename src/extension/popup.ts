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
  <section class="config-card"><div><span>Độ trễ tự động</span><strong>6 giây</strong></div><div><span>Âm thanh gốc</span><strong>18%</strong></div></section>
  <footer>Đóng popup và nhấn Play nổi bên trái video.</footer>`;

const query = <T extends HTMLElement>(selector: string) => app.querySelector<T>(selector)!;

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

void activeTab().then(async (tabId) => {
  const state = tabId ? await chrome.tabs.sendMessage(tabId, { action: "status" }).catch(() => undefined) as ExtensionState | undefined : undefined;
  render(state);
});
