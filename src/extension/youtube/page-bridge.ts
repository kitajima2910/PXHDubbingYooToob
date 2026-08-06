interface PageCaptionTrack { baseUrl: string; languageCode: string; kind?: string }
interface PagePlayerResponse { captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: PageCaptionTrack[] } } }
interface YouTubePlayerElement extends Element { getPlayerResponse?: () => PagePlayerResponse }

declare global {
  interface Window {
    ytInitialPlayerResponse?: PagePlayerResponse;
    ytplayer?: { config?: { args?: { player_response?: string } } };
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

async function captionPayload(): Promise<{ text: string; format: "json3" | "xml"; source: string }> {
  let response: PagePlayerResponse | undefined;
  for (let attempt = 0; attempt < 20 && !response; attempt += 1) {
    response = playerResponse();
    if (!response) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const track = tracks.find((item) => item.languageCode === "vi") ?? tracks.find((item) => item.kind !== "asr") ?? tracks[0];
  if (!track?.baseUrl.startsWith("https://www.youtube.com/api/timedtext")) throw new Error("Không tìm thấy phụ đề");
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
  throw new Error("YouTube không trả dữ liệu phụ đề hợp lệ");
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
