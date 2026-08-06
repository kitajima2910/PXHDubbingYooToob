interface PageCaptionTrack { baseUrl: string; languageCode: string; kind?: string }
interface PagePlayerResponse { captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: PageCaptionTrack[] } } }
interface YouTubePlayerElement extends Element { getPlayerResponse?: () => PagePlayerResponse }
interface YouTubeConfig { get?: (key: string) => unknown; data_?: Record<string, unknown> }
interface TranscriptSegment { id: string; startMs: number; endMs: number; sourceText: string }
type CaptionPayload = { text: string; format: "json3" | "xml" | "segments"; source: string };

declare global {
  interface Window {
    ytInitialPlayerResponse?: PagePlayerResponse;
    ytInitialData?: unknown;
    ytplayer?: { config?: { args?: { player_response?: string } } };
    ytcfg?: YouTubeConfig;
  }
}

function playerResponse(): PagePlayerResponse | undefined {
  const player = document.querySelector<YouTubePlayerElement>("#movie_player, ytd-player");
  try {
    const response = player?.getPlayerResponse?.();
    if (response) return response;
  } catch { /* Thử nguồn tiếp theo. */ }
  if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;
  const serialized = window.ytplayer?.config?.args?.player_response;
  if (serialized) {
    try { return JSON.parse(serialized) as PagePlayerResponse; }
    catch { return undefined; }
  }
  return undefined;
}

function configValue(key: string): unknown {
  try { return window.ytcfg?.get?.(key) ?? window.ytcfg?.data_?.[key]; }
  catch { return window.ytcfg?.data_?.[key]; }
}

function findTranscriptParams(value: unknown, seen = new Set<object>()): string | undefined {
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  const object = value as Record<string, unknown>;
  const endpoint = object.getTranscriptEndpoint as { params?: unknown } | undefined;
  if (typeof endpoint?.params === "string") return endpoint.params;
  for (const child of Object.values(object)) {
    const result = findTranscriptParams(child, seen);
    if (result) return result;
  }
  return undefined;
}

function collectTranscriptSegments(value: unknown, output: TranscriptSegment[], seen = new Set<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const object = value as Record<string, unknown>;
  const renderer = object.transcriptSegmentRenderer as Record<string, unknown> | undefined;
  if (renderer) {
    const snippet = renderer.snippet as { runs?: Array<{ text?: string }>; simpleText?: string } | undefined;
    const startMs = Number(renderer.startMs);
    const endMs = Number(renderer.endMs);
    const sourceText = (snippet?.runs?.map((run) => run.text ?? "").join("") ?? snippet?.simpleText ?? "").replace(/\s+/g, " ").trim();
    if (Number.isFinite(startMs) && sourceText) {
      output.push({ id: String(renderer.cueGroupId ?? `${startMs}-${output.length}`), startMs, endMs: Number.isFinite(endMs) && endMs > startMs ? endMs : startMs + 2000, sourceText });
    }
  }
  for (const child of Object.values(object)) collectTranscriptSegments(child, output, seen);
}

async function transcriptPayload(): Promise<CaptionPayload> {
  const apiKey = configValue("INNERTUBE_API_KEY");
  const context = configValue("INNERTUBE_CONTEXT");
  if (typeof apiKey !== "string" || !context || typeof context !== "object") throw new Error("YouTube chưa cung cấp cấu hình transcript");

  const watchData = (document.querySelector("ytd-watch-flexy") as (Element & { data?: unknown }) | null)?.data;
  let params = findTranscriptParams(window.ytInitialData) ?? findTranscriptParams(watchData);
  if (!params) {
    const videoId = new URL(location.href).searchParams.get("v");
    if (!videoId) throw new Error("Không xác định được video YouTube");
    const nextResponse = await fetch(`/youtubei/v1/next?key=${encodeURIComponent(apiKey)}&prettyPrint=false`, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ context, videoId }),
    });
    if (nextResponse.ok) params = findTranscriptParams(await nextResponse.json());
  }
  if (!params) throw new Error("Video không cung cấp transcript");

  const transcriptResponse = await fetch(`/youtubei/v1/get_transcript?key=${encodeURIComponent(apiKey)}&prettyPrint=false`, {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ context, params }),
  });
  if (!transcriptResponse.ok) throw new Error(`YouTube transcript trả HTTP ${transcriptResponse.status}`);
  const segments: TranscriptSegment[] = [];
  collectTranscriptSegments(await transcriptResponse.json(), segments);
  if (!segments.length) throw new Error("Transcript YouTube không có nội dung");
  return { text: JSON.stringify({ segments }), format: "segments", source: "YouTube transcript" };
}

async function captionPayload(): Promise<CaptionPayload> {
  let response: PagePlayerResponse | undefined;
  for (let attempt = 0; attempt < 20 && !response; attempt += 1) {
    response = playerResponse();
    if (!response) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const track = tracks.find((item) => item.languageCode === "vi") ?? tracks.find((item) => item.kind !== "asr") ?? tracks[0];
  if (!track?.baseUrl.startsWith("https://www.youtube.com/api/timedtext")) return transcriptPayload();
  const source = track.kind === "asr" ? "YouTube (tự động)" : "YouTube";

  const jsonUrl = new URL(track.baseUrl);
  jsonUrl.searchParams.set("fmt", "json3");
  const jsonResponse = await fetch(jsonUrl, { credentials: "include" });
  const jsonText = jsonResponse.ok ? await jsonResponse.text() : "";
  if (jsonText.trim().startsWith("{")) return { text: jsonText, format: "json3", source };

  const xmlUrl = new URL(track.baseUrl);
  xmlUrl.searchParams.delete("fmt");
  const xmlResponse = await fetch(xmlUrl, { credentials: "include" });
  const xmlText = xmlResponse.ok ? await xmlResponse.text() : "";
  if (xmlText.trim().startsWith("<")) return { text: xmlText, format: "xml", source };
  return transcriptPayload();
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window || location.hostname !== "www.youtube.com") return;
  const request = event.data as { type?: string; requestId?: string } | null;
  if (request?.type !== "PXH_CAPTIONS_REQUEST" || typeof request.requestId !== "string") return;
  void captionPayload().then(
    (payload) => window.postMessage({ type: "PXH_CAPTIONS_RESPONSE", requestId: request.requestId, payload }, location.origin),
    (error: unknown) => window.postMessage({ type: "PXH_CAPTIONS_RESPONSE", requestId: request.requestId, error: error instanceof Error ? error.message : "Không thể tải phụ đề" }, location.origin),
  );
});

export {};
