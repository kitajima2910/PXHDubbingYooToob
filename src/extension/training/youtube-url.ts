const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export type YouTubeTrainingTarget =
  | { kind: "video"; videoIds: [string] }
  | { kind: "playlist"; url: string };

export function parseYouTubeTrainingTarget(value: string): YouTubeTrainingTarget {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("URL video hoặc playlist YouTube không hợp lệ");
  }

  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  const playlistId = url.searchParams.get("list");
  if ((hostname === "youtube.com" || hostname === "m.youtube.com") && playlistId) {
    return { kind: "playlist", url: url.toString() };
  }

  const videoId = hostname === "youtu.be"
    ? url.pathname.split("/").filter(Boolean)[0]
    : hostname === "youtube.com" || hostname === "m.youtube.com"
      ? url.searchParams.get("v")
      : undefined;
  if (videoId && VIDEO_ID_PATTERN.test(videoId)) return { kind: "video", videoIds: [videoId] };
  throw new Error("URL video hoặc playlist YouTube không hợp lệ");
}
