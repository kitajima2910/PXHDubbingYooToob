import type { SubtitleSegment } from "../../shared/types";
import { mergeOverlappingSegments, stripTranscriptTimestamps } from "../../shared/segments";

interface CaptionTrack { baseUrl: string; languageCode: string; kind?: string }
interface BridgePayload { text: string; format: "json3" | "xml" | "segments"; source: string }

function loadFromPageWorld(): Promise<BridgePayload> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { cleanup(); reject(new Error("Quá thời gian chờ phụ đề YouTube")); }, 12_000);
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== window) return;
      const message = event.data as { type?: string; requestId?: string; payload?: BridgePayload; error?: string } | null;
      if (message?.type !== "PXH_CAPTIONS_RESPONSE" || message.requestId !== requestId) return;
      cleanup();
      if (message.payload) resolve(message.payload);
      else reject(new Error(message.error ?? "Không thể tải phụ đề YouTube"));
    };
    const cleanup = (): void => { window.clearTimeout(timer); window.removeEventListener("message", onMessage); };
    window.addEventListener("message", onMessage);
    window.postMessage({ type: "PXH_CAPTIONS_REQUEST", requestId }, location.origin);
  });
}

function findPlayerResponse(): unknown {
  for (const script of document.scripts) {
    const text = script.textContent ?? "";
    const marker = "ytInitialPlayerResponse";
    const markerIndex = text.indexOf(marker);
    if (markerIndex < 0) continue;
    const start = text.indexOf("{", markerIndex);
    if (start < 0) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (escaped) { escaped = false; continue; }
      if (character === "\\" && inString) { escaped = true; continue; }
      if (character === '"') inString = !inString;
      if (inString) continue;
      if (character === "{") depth += 1;
      if (character === "}" && --depth === 0) {
        try { return JSON.parse(text.slice(start, index + 1)); }
        catch { break; }
      }
    }
  }
  return undefined;
}

interface Json3CaptionData { events?: Array<{ tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> }> }

function parseJson3(text: string): Json3CaptionData | undefined {
  if (!text.trim()) return undefined;
  try {
    const value = JSON.parse(text) as Json3CaptionData;
    return Array.isArray(value.events) ? value : undefined;
  } catch { return undefined; }
}

function parseXml(text: string): Json3CaptionData | undefined {
  if (!text.trim()) return undefined;
  const document = new DOMParser().parseFromString(text, "text/xml");
  if (document.querySelector("parsererror")) return undefined;
  const events = [...document.querySelectorAll("text")].map((node) => {
    const startMs = Math.round(Number(node.getAttribute("start") ?? 0) * 1000);
    const durationMs = Math.round(Number(node.getAttribute("dur") ?? 2) * 1000);
    return { tStartMs: startMs, dDurationMs: durationMs, segs: [{ utf8: node.textContent ?? "" }] };
  });
  return events.length ? { events } : undefined;
}

async function fetchCaptionData(baseUrl: string): Promise<Json3CaptionData> {
  const jsonUrl = new URL(baseUrl);
  jsonUrl.searchParams.set("fmt", "json3");
  const jsonResponse = await fetch(jsonUrl.toString(), { credentials: "include" });
  if (jsonResponse.ok) {
    const parsed = parseJson3(await jsonResponse.text());
    if (parsed) return parsed;
  }

  const xmlUrl = new URL(baseUrl);
  xmlUrl.searchParams.delete("fmt");
  const xmlResponse = await fetch(xmlUrl.toString(), { credentials: "include" });
  if (xmlResponse.ok) {
    const parsed = parseXml(await xmlResponse.text());
    if (parsed) return parsed;
  }
  throw new Error("YouTube không trả dữ liệu phụ đề hợp lệ");
}

function tracksFrom(value: unknown): CaptionTrack[] {
  if (!value || typeof value !== "object") return [];
  const root = value as { captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } } };
  return root.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
}

function decodeEntities(text: string): string {
  const element = document.createElement("textarea");
  element.innerHTML = text;
  return element.value.replace(/\s+/g, " ").trim();
}

export async function loadYouTubeCaptions(): Promise<{ segments: SubtitleSegment[]; source: string }> {
  let data: Json3CaptionData;
  let source: string;
  try {
    const payload = await loadFromPageWorld();
    if (payload.format === "segments") {
      const parsed = JSON.parse(payload.text) as { segments?: SubtitleSegment[] };
      const segments = (parsed.segments ?? [])
        .map((segment) => ({ ...segment, sourceText: stripTranscriptTimestamps(segment.sourceText) }))
        .filter((segment) => Number.isFinite(segment.startMs) && Number.isFinite(segment.endMs) && typeof segment.sourceText === "string" && segment.sourceText.trim());
      if (!segments.length) throw new Error("Transcript YouTube không có nội dung");
      // DOM transcript rows already carry YouTube's timeline. Preserve each cue
      // boundary so playback starts at the cue's actual timestamp.
      const timedSegments = [...segments]
        .sort((left, right) => left.startMs - right.startMs)
        .map((segment, index, sorted) => ({
          ...segment,
          endMs: Math.max(segment.startMs + 500, sorted[index + 1]?.startMs ?? segment.endMs),
        }));
      return { segments: timedSegments, source: "Transcript — đồng bộ" };
    }
    data = payload.format === "json3" ? (parseJson3(payload.text) ?? {}) : (parseXml(payload.text) ?? {});
    source = payload.source;
  } catch (bridgeError) {
    const tracks = tracksFrom(findPlayerResponse());
    const track = tracks.find((item) => item.languageCode === "vi") ?? tracks.find((item) => item.kind !== "asr") ?? tracks[0];
    if (!track) throw bridgeError;
    try {
      data = await fetchCaptionData(track.baseUrl);
      source = track.kind === "asr" ? "YouTube (tự động)" : "YouTube";
    } catch (isolatedError) {
      const bridgeMessage = bridgeError instanceof Error ? bridgeError.message : "không rõ lỗi";
      const isolatedMessage = isolatedError instanceof Error ? isolatedError.message : "không rõ lỗi";
      throw new Error(`Bridge transcript: ${bridgeMessage}; timedtext: ${isolatedMessage}`);
    }
  }
  const segments = (data.events ?? []).flatMap((event, index) => {
    const sourceText = stripTranscriptTimestamps(decodeEntities((event.segs ?? []).map((part) => part.utf8 ?? "").join("")));
    const startMs = event.tStartMs ?? 0;
    if (!sourceText) return [];
    return [{ id: `${startMs}-${index}`, startMs, endMs: startMs + (event.dDurationMs ?? 2000), sourceText }];
  });
  if (!segments.length) throw new Error("Phụ đề YouTube không có nội dung");
  return { segments: mergeOverlappingSegments(segments), source };
}
