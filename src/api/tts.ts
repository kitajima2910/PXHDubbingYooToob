import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import { jsonError, prepare, retry } from "./lib/http.js";
import { edgeVoiceIds } from "../shared/voices.js";
import { EdgeTtsProvider } from "./providers/tts-edge.js";

const voice = z.enum(edgeVoiceIds() as [string, ...string[]]);

const schema = z.object({
  text: z.string().min(1).max(1_000),
  voice,
  rate: z.number().min(0.85).max(1.3),
});

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!prepare(req, res, 8_000)) return;
  const input = schema.safeParse(req.body);
  if (!input.success) return jsonError(res, 400, "INVALID_INPUT", "Dữ liệu giọng nói không hợp lệ");
  try {
    const audio = await retry((signal) => new EdgeTtsProvider().synthesize(input.data.text, input.data.voice, input.data.rate, signal));
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.status(200).send(audio);
  } catch (error) {
    console.error("TTS thất bại", error instanceof Error ? error.message : "Lỗi không xác định");
    jsonError(res, 502, "TTS_FAILED", "Không thể tạo giọng nói lúc này");
  }
}
