import type { ExtensionState } from "../shared/types";
import "./popup.css";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Không tìm thấy vùng giao diện");

app.innerHTML = `
  <h1>PXHDubbingYooToob</h1>
  <p id="status">Đang kiểm tra…</p>
  <dl><div><dt>Giọng đọc</dt><dd>Hoài My</dd></div><div><dt>Nguồn phụ đề</dt><dd id="source">—</dd></div><div><dt>Đã xử lý</dt><dd id="count">0 đoạn</dd></div></dl>
  <label>Độ trễ <input id="delay" type="range" min="2" max="15" value="5"><span id="delayValue">5 giây</span></label>
  <label>Âm lượng giọng gốc <input id="volume" type="range" min="0" max="100" value="25"><span id="volumeValue">25%</span></label>
  <button id="toggle">Bắt đầu lồng tiếng</button>
  <button id="retry" class="secondary" hidden>Thử lại</button>`;

const query = <T extends HTMLElement>(selector: string) => app.querySelector<T>(selector)!;
const toggle = query<HTMLButtonElement>("#toggle");
const retry = query<HTMLButtonElement>("#retry");
let currentState: ExtensionState = { enabled: false, status: "idle", message: "Sẵn sàng", processedSegments: 0, source: "—" };
let busy = false;
let interactionVersion = 0;

async function activeTab(): Promise<number | undefined> {
  return (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
}

function render(state?: ExtensionState): void {
  const value = state ?? { enabled: false, status: "idle", message: "Sẵn sàng", processedSegments: 0, source: "—" };
  currentState = value;
  query("#status").textContent = value.message;
  query("#source").textContent = value.source;
  query("#count").textContent = `${value.processedSegments} đoạn`;
  toggle.textContent = value.enabled ? "Dừng lồng tiếng" : "Bắt đầu lồng tiếng";
  retry.hidden = value.status !== "error";
}

async function send(action: "start" | "stop"): Promise<void> {
  if (busy) return;
  busy = true;
  const version = ++interactionVersion;
  toggle.disabled = true;
  render({ ...currentState, enabled: action === "start", status: action === "start" ? "loading" : "idle", message: action === "start" ? "Đang tải phụ đề" : "Đang dừng lồng tiếng" });
  const tabId = await activeTab();
  if (!tabId) {
    render({ enabled: false, status: "error", message: "Hãy mở một video YouTube", processedSegments: 0, source: "—" });
    busy = false; toggle.disabled = false; return;
  }
  const delaySeconds = Number(query<HTMLInputElement>("#delay").value);
  const sourceVolume = Number(query<HTMLInputElement>("#volume").value) / 100;
  try {
    if (action === "start") {
      const capture = await chrome.runtime.sendMessage({ action: "capture-start", tabId, sourceVolume }) as { ok?: boolean; message?: string };
      if (!capture?.ok) throw new Error(capture?.message ?? "Không thể thu âm tab");
    }
    if (version === interactionVersion) render(await chrome.tabs.sendMessage(tabId, { action, delaySeconds, sourceVolume }) as ExtensionState);
    if (action === "stop") await chrome.runtime.sendMessage({ action: "capture-stop" });
  }
  catch {
    if (action === "start") void chrome.runtime.sendMessage({ action: "capture-stop" });
    if (version === interactionVersion) render({ enabled: false, status: "error", message: "Không thể kết nối hoặc thu âm tab YouTube. Hãy tải lại trang.", processedSegments: 0, source: "—" });
  }
  finally { if (version === interactionVersion) { busy = false; toggle.disabled = false; } }
}

toggle.addEventListener("click", async () => send(currentState.enabled ? "stop" : "start"));
retry.addEventListener("click", async () => send("start"));
for (const id of ["delay", "volume"] as const) query<HTMLInputElement>(`#${id}`).addEventListener("input", (event) => {
  const input = event.currentTarget as HTMLInputElement;
  query(`#${id}Value`).textContent = id === "delay" ? `${input.value} giây` : `${input.value}%`;
});
const initialVersion = interactionVersion;
void activeTab().then(async (tabId) => {
  const result = tabId ? await chrome.tabs.sendMessage(tabId, { action: "status" }).catch(() => undefined) as ExtensionState | undefined : undefined;
  if (initialVersion === interactionVersion) render(result);
});
