import type { ExtensionState } from "../shared/types";
import type { SubtitleSegment } from "../shared/types";
import { DEFAULT_VOICE_ID, EDGE_VOICES, VOICE_STORAGE_KEY, isKnownVoice, voiceOption } from "../shared/voices";
import { parseVideoIdFromUrl, selectChangedSegments } from "./subtitle-editor";
import "./popup.css";
import "./popup-model.css";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Không tìm thấy vùng giao diện");

app.innerHTML = `
  <header><img class="brand-mark" src="/PXH.jpg" alt="PXH logo"><div><h1>PXH Dubbing YooToob</h1><p>Realtime Vietnamese AI dubbing</p></div></header>
  <section class="status-card"><span id="statusDot" class="status-dot"></span><div><small>TRẠNG THÁI</small><strong id="status">Đang kiểm tra…</strong></div></section>
  <section class="model-card"><div><span>WHISPER LOCAL</span><strong id="modelStatus">Đang kiểm tra model…</strong></div><div class="model-progress"><i id="modelProgress"></i></div><button id="modelRetry" type="button" hidden>Thử tải lại</button></section>
  <button id="dubbingToggle" class="dubbing-toggle" type="button" disabled>Bắt đầu lồng tiếng</button>
  <section class="info-grid">
    <div><span>Giọng đọc</span><strong id="voiceLabel">Nam Minh (nam)</strong></div>
    <div class="source-info"><span>Chế độ</span><strong id="source" style="overflow:visible;white-space:normal;line-height:1.25">—</strong></div>
    <div><span>Đã xử lý</span><strong id="count">0 đoạn</strong></div>
  </section>
  <section class="config-card"><div><span>Nhận dạng</span><strong>DOM → Whisper local</strong></div><div><span>Âm thanh gốc</span><strong>8%</strong></div></section>
  <section class="voice-card"><div><span>Giọng đọc</span><select id="voiceSelect" aria-label="Chọn giọng đọc"></select></div></section>
  <section class="api-card">
    <div class="api-heading"><div><span>GROQ API KEY</span><strong id="keyState">Đang kiểm tra…</strong></div><small>Lưu cục bộ trên Chrome</small></div>
    <form id="keyForm"><input id="groqKey" type="password" autocomplete="off" spellcheck="false" placeholder="gsk_••••••••••••"><button type="submit">Lưu</button></form>
    <button id="useDefault" class="default-key" type="button">Dùng API key mặc định</button>
  </section>
  <details id="subtitleEditor" class="editor-card" style="display:none">
    <summary class="editor-summary"><span>Subtitle Editor</span><small>Sửa bản dịch 1 lần — mọi video sau dùng bản đã sửa</small></summary>
    <p id="editorStatus" class="editor-status">Mở để xem transcript của video này</p>
    <div id="editorList" class="editor-list"></div>
    <button id="editorSave" class="editor-save" type="button" disabled>Lưu bản sửa</button>
  </details>
  <footer>Transcript và bản dịch tự lưu khi bạn xem và lồng tiếng.</footer>`;

const query = <T extends HTMLElement>(selector: string) => app.querySelector<T>(selector)!;

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  return (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
}

let tab: chrome.tabs.Tab | undefined;
let currentState: ExtensionState | undefined;
let toggling = false;
let modelState: "loading" | "ready" | "error" = "loading";
let modelProgress = 0;

async function ensureDubbingContent(tabId: number): Promise<ExtensionState> {
  try {
    return await chrome.tabs.sendMessage(tabId, { action: "status" }) as ExtensionState;
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["page-bridge.js"], world: "MAIN" });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"], world: "ISOLATED" });
    try {
      return await chrome.tabs.sendMessage(tabId, { action: "status" }) as ExtensionState;
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      throw new Error(`Không thể khởi tạo PXH Dubbing trên tab YouTube${detail}`);
    }
  }
}

function render(state?: ExtensionState): void {
  const value = state ?? { enabled: false, status: "idle", message: "Mở một video YouTube", processedSegments: 0, source: "—" };
  currentState = value;
  query("#status").textContent = value.message;
  query("#source").textContent = value.source;
  query("#count").textContent = `${value.processedSegments} đoạn`;
  query("#statusDot").className = `status-dot ${value.status}`;
  const toggle = query<HTMLButtonElement>("#dubbingToggle");
  toggle.disabled = toggling || modelState !== "ready" || !tab?.id || !tab.url?.startsWith("https://www.youtube.com/watch");
  toggle.dataset.active = String(value.enabled);
  toggle.textContent = toggling ? "Đang chuẩn bị…" : modelState === "loading" ? `Đang tải model ${modelProgress}%` : value.enabled ? "Dừng lồng tiếng" : "Bắt đầu lồng tiếng";
}

function renderModel(message = ""): void {
  query("#modelStatus").textContent = modelState === "ready" ? "Sẵn sàng — đã lưu trên máy" : modelState === "error" ? (message || "Không tải được model") : `Đang tải dữ liệu nhận dạng: ${modelProgress}%`;
  query<HTMLElement>("#modelProgress").style.width = `${modelProgress}%`;
  query<HTMLElement>("#modelProgress").parentElement?.classList.toggle("error", modelState === "error");
  query<HTMLButtonElement>("#modelRetry").hidden = modelState !== "error";
  render(currentState);
}

async function refreshModelStatus(): Promise<void> {
  const result = await chrome.runtime.sendMessage({ action: "local-model-status" }) as { ok?: boolean; ready?: boolean; progress?: number; message?: string };
  modelProgress = Math.max(0, Math.min(100, result.progress ?? 0));
  modelState = result.ready ? "ready" : result.ok === false || result.message ? "error" : "loading";
  renderModel(result.message);
}

query<HTMLButtonElement>("#modelRetry").addEventListener("click", () => {
  modelState = "loading"; modelProgress = 0; renderModel();
  void chrome.runtime.sendMessage({ action: "local-model-init", tabId: tab?.id }).then(() => refreshModelStatus());
});

const modelPoll = window.setInterval(() => {
  if (modelState === "loading") void refreshModelStatus().catch(() => undefined);
  else if (modelState === "ready") window.clearInterval(modelPoll);
}, 500);
void refreshModelStatus().catch((error: unknown) => {
  modelState = "error"; renderModel(error instanceof Error ? error.message : "Không đọc được trạng thái model");
});

const keyInput = query<HTMLInputElement>("#groqKey");
const defaultKeyButton = query<HTMLButtonElement>("#useDefault");

const voiceSelect = query<HTMLSelectElement>("#voiceSelect");
const voiceLabel = query<HTMLElement>("#voiceLabel");
for (const voice of EDGE_VOICES) {
  const option = document.createElement("option");
  option.value = voice.id;
  option.textContent = voice.label;
  voiceSelect.appendChild(option);
}
function applyVoiceLabel(id: string): void {
  voiceLabel.textContent = voiceOption(id)?.label ?? DEFAULT_VOICE_ID;
}
async function initVoiceSelect(): Promise<void> {
  const stored = await chrome.storage.local.get(VOICE_STORAGE_KEY);
  const raw = stored[VOICE_STORAGE_KEY];
  const selected = typeof raw === "string" && isKnownVoice(raw) ? raw : DEFAULT_VOICE_ID;
  voiceSelect.value = selected;
  applyVoiceLabel(selected);
}
voiceSelect.addEventListener("change", () => {
  const id = voiceSelect.value;
  void chrome.storage.local.set({ [VOICE_STORAGE_KEY]: id });
  applyVoiceLabel(id);
});
void initVoiceSelect();

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

query<HTMLButtonElement>("#dubbingToggle").addEventListener("click", () => {
  if (toggling || !tab?.id) return;
  toggling = true; render(currentState);
  void (async () => {
    const liveState = await ensureDubbingContent(tab!.id!);
    if (liveState.enabled) {
      return chrome.tabs.sendMessage(tab!.id!, { action: "stop" }) as Promise<ExtensionState>;
    }
    // Chuẩn bị language pack local; pipeline transcript vẫn có cloud fallback.
    void chrome.tabs.sendMessage(tab!.id!, { action: "prepare-offline-translation" }).catch(() => undefined);
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
  try { render(await ensureDubbingContent(tab.id)); }
  catch (error) {
    render({ enabled: false, status: "error", message: error instanceof Error ? error.message : "Không thể khởi tạo extension", processedSegments: 0, source: "—" });
  }
});

// Subtitle Editor — sửa bản dịch 1 lần, lưu vào Translation Memory global.
interface EditorSegment { id: string; startMs: number; sourceText: string; translatedText: string }
const editorDetails = query<HTMLDetailsElement>("#subtitleEditor");
const editorStatus = query<HTMLElement>("#editorStatus");
const editorList = query<HTMLElement>("#editorList");
const editorSave = query<HTMLButtonElement>("#editorSave");
let editorSegments: EditorSegment[] = [];
let editorVideoId: string | undefined;
let editorLoaded = false;
let editorLoading = false;

function setEditorStatus(message: string): void { editorStatus.textContent = message; }

async function cacheRequest<T>(body: unknown): Promise<T | undefined> {
  const response = await chrome.runtime.sendMessage({
    action: "api-request", requestId: crypto.randomUUID(), path: "/api/cache", body, responseType: "json",
  }) as { ok?: boolean; data?: T; message?: string };
  if (!response?.ok || response.data === undefined) throw new Error(response?.message ?? "Dịch vụ không phản hồi");
  return response.data;
}

function renderEditorList(): void {
  editorList.innerHTML = "";
  for (const segment of editorSegments) {
    const row = document.createElement("div");
    row.className = "editor-row";
    const source = document.createElement("div");
    source.className = "editor-source";
    source.textContent = segment.sourceText;
    const textarea = document.createElement("textarea");
    textarea.className = "editor-translation";
    textarea.value = segment.translatedText;
    textarea.dataset.id = segment.id;
    textarea.rows = 2;
    textarea.setAttribute("aria-label", "Bản dịch tiếng Việt");
    row.append(source, textarea);
    editorList.appendChild(row);
  }
}

async function loadEditor(): Promise<void> {
  const videoId = parseVideoIdFromUrl(tab?.url);
  if (!videoId) { setEditorStatus("Chưa mở video YouTube hợp lệ"); return; }
  editorLoading = true;
  editorSave.disabled = true;
  editorList.innerHTML = "";
  setEditorStatus("Đang tải transcript…");
  try {
    const transcript = await cacheRequest<{ enabled: boolean; segments?: SubtitleSegment[] }>({
      action: "transcript:get", videoId, sourceLanguage: "auto",
    });
    if (!transcript?.enabled || !transcript.segments?.length) {
      setEditorStatus("Video này chưa có transcript trong cache");
      return;
    }
    const ordered = [...transcript.segments].sort((left, right) => left.startMs - right.startMs).slice(0, 60);
    const translatedById = new Map<string, string>();
    for (let index = 0; index < ordered.length; index += 20) {
      const batch = ordered.slice(index, index + 20);
      const translated = await cacheRequest<{ enabled?: boolean; segments?: Array<{ id: string; translatedText: string }> }>({
        action: "translations:get", sourceLanguage: "auto", targetLanguage: "vi",
        segments: batch.map(({ id, sourceText }) => ({ id, sourceText })),
      });
      for (const item of translated?.segments ?? []) translatedById.set(item.id, item.translatedText);
    }
    editorSegments = ordered.map((segment) => ({
      id: segment.id, startMs: segment.startMs, sourceText: segment.sourceText, translatedText: translatedById.get(segment.id) ?? "",
    }));
    renderEditorList();
    editorVideoId = videoId;
    editorLoaded = true;
    setEditorStatus(`${editorSegments.length} câu — sửa bản dịch rồi lưu`);
    editorSave.disabled = false;
  } catch (error) {
    setEditorStatus("Lỗi API — không tải được transcript");
  } finally {
    editorLoading = false;
  }
}

async function saveEditor(): Promise<void> {
  if (!editorSegments.length) return;
  const edits = [...editorList.querySelectorAll<HTMLTextAreaElement>("textarea")].flatMap((textarea) => {
    const id = textarea.dataset.id;
    return id ? [{ id, translatedText: textarea.value }] : [];
  });
  const changed = selectChangedSegments(editorSegments, edits);
  if (!changed.length) { setEditorStatus("Chưa có câu nào thay đổi"); return; }
  editorSave.disabled = true;
  try {
    let saved = 0;
    for (let index = 0; index < changed.length; index += 20) {
      const batch = changed.slice(index, index + 20);
      const result = await cacheRequest<{ enabled: boolean }>({
        action: "translations:review", sourceLanguage: "auto", targetLanguage: "vi", segments: batch,
      });
      if (!result?.enabled) throw new Error("Cache dịch chưa bật");
      saved += batch.length;
    }
    for (const textarea of editorList.querySelectorAll<HTMLTextAreaElement>("textarea")) {
      const segment = editorSegments.find((item) => item.id === textarea.dataset.id);
      if (segment) segment.translatedText = textarea.value.trim();
    }
    setEditorStatus(`Đã lưu ${saved} câu`);
  } catch {
    setEditorStatus("Lỗi API — không lưu được");
  } finally {
    editorSave.disabled = false;
  }
}

editorDetails.addEventListener("toggle", () => {
  const videoId = parseVideoIdFromUrl(tab?.url);
  if (!editorDetails.open || editorLoading) return;
  if (!videoId) { setEditorStatus("Chưa mở video YouTube hợp lệ"); return; }
  if (editorLoaded && editorVideoId === videoId) return;
  void loadEditor();
});
editorSave.addEventListener("click", () => { void saveEditor(); });


