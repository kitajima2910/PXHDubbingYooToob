import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import { jsonError, prepare, retry } from "../lib/http.js";
import { YouTubeTranscriptProvider } from "../providers/youtube-transcript.js";

const schema = z.object({
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  fromMs: z.number().int().min(0),
  toMs: z.number().int().positive(),
}).refine((value) => value.toMs > value.fromMs && value.toMs - value.fromMs <= 120_000);

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!prepare(req, res, 2_000)) return;
  const input = schema.safeParse(req.body);
  if (!input.success) return jsonError(res, 400, "INVALID_INPUT", "Khoảng phụ đề yêu cầu không hợp lệ");
  try {
    const provider = new YouTubeTranscriptProvider();
    const segments = await retry((signal) => provider.fetch(input.data.videoId, input.data.fromMs, input.data.toMs, signal), 2);
    if (!segments.length) return jsonError(res, 404, "SUBTITLES_NOT_FOUND", "Không tìm thấy phụ đề trong khoảng đang phát");
    res.status(200).json({ segments, source: "YouTube" });
  } catch (error) {
    console.error("Lấy phụ đề YouTube thất bại", error instanceof Error ? error.message : "Lỗi không xác định");
    jsonError(res, 502, "YOUTUBE_SUBTITLES_FAILED", "Không thể lấy phụ đề YouTube lúc này");
  }
}
