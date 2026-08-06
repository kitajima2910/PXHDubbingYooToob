import type { VercelRequest, VercelResponse } from "@vercel/node";
import Groq, { toFile } from "groq-sdk";
import { z } from "zod";
import { jsonError, prepare, retry } from "./lib/http.js";

const schema = z.object({
  audioBase64: z.string().min(100).max(2_000_000),
  mimeType: z.enum(["audio/webm", "audio/webm;codecs=opus"]),
});

interface WhisperSegment { start?: number; end?: number; text?: string }

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!prepare(req, res, 2_100_000)) return;
  const input = schema.safeParse(req.body);
  if (!input.success) return jsonError(res, 400, "INVALID_INPUT", "Dữ liệu audio không hợp lệ");
  const key = process.env.GROQ_API_KEY;
  if (!key) return jsonError(res, 503, "MISSING_GROQ_KEY", "Backend chưa cấu hình GROQ_API_KEY");
  try {
    const audio = Buffer.from(input.data.audioBase64, "base64");
    if (audio.length < 100 || audio.length > 1_500_000) return jsonError(res, 413, "AUDIO_TOO_LARGE", "Đoạn audio quá lớn");
    const client = new Groq({ apiKey: key });
    const file = await toFile(audio, "chunk.webm", { type: input.data.mimeType });
    const result = await retry((signal) => client.audio.transcriptions.create({
      file,
      model: process.env.GROQ_WHISPER_MODEL ?? "whisper-large-v3-turbo",
      response_format: "verbose_json",
      timestamp_granularities: ["segment"],
      temperature: 0,
    }, { signal }), 2) as { text?: string; segments?: WhisperSegment[] };
    const segments = (result.segments ?? []).flatMap((segment, index) => {
      const text = segment.text?.replace(/\s+/g, " ").trim();
      if (!text) return [];
      return [{ id: `whisper-${index}`, startMs: Math.max(0, Math.round((segment.start ?? 0) * 1000)), endMs: Math.max(500, Math.round((segment.end ?? 0) * 1000)), sourceText: text }];
    });
    if (!segments.length && result.text?.trim()) segments.push({ id: "whisper-0", startMs: 0, endMs: 5_000, sourceText: result.text.trim() });
    res.status(200).json({ segments, source: "Groq Whisper" });
  } catch (error) {
    console.error("Whisper thất bại", error instanceof Error ? error.message : "Lỗi không xác định");
    jsonError(res, 502, "TRANSCRIPTION_FAILED", "Không thể nhận dạng âm thanh lúc này");
  }
}
