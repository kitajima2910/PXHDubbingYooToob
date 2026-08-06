import { YoutubeTranscript } from "youtube-transcript";
import type { SubtitleSegment } from "../../shared/types.js";

export interface TranscriptProvider {
  fetch(videoId: string, fromMs: number, toMs: number, signal: AbortSignal): Promise<SubtitleSegment[]>;
}

export class YouTubeTranscriptProvider implements TranscriptProvider {
  async fetch(videoId: string, fromMs: number, toMs: number, signal: AbortSignal): Promise<SubtitleSegment[]> {
    const fetchWithSignal: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, { ...init, signal });
    const transcript = await YoutubeTranscript.fetchTranscript(videoId, { fetch: fetchWithSignal });
    return transcript.flatMap((item, index) => {
      const startMs = Math.round(item.offset);
      const endMs = startMs + Math.max(200, Math.round(item.duration));
      const sourceText = item.text.replace(/\s+/g, " ").trim();
      if (!sourceText || endMs < fromMs || startMs > toMs) return [];
      return [{ id: `${startMs}-${index}`, startMs, endMs, sourceText }];
    });
  }
}
