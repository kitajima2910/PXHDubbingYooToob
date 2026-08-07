import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import { jsonError, prepare, retry } from "./lib/http.js";
import { GroqTranslationProvider } from "./providers/translation.js";

const schema = z.object({
  sourceLanguage: z.string().min(2).max(16),
  targetLanguage: z.literal("vi"),
  segments: z.array(z.object({ id: z.string().min(1).max(100), sourceText: z.string().min(1).max(1_000) })).min(1).max(20),
});

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!prepare(req, res)) return;
  const input = schema.safeParse(req.body);
  if (!input.success) return jsonError(res, 400, "INVALID_INPUT", "Dữ liệu dịch không hợp lệ");
  try {
    const provider = new GroqTranslationProvider();
    const segments = await retry((signal) => provider.translate(input.data.segments, signal));
    const expected = new Set(input.data.segments.map((item) => item.id));
    const returned = new Set(segments.map((item) => item.id));
    if (segments.length !== input.data.segments.length || returned.size !== segments.length
      || segments.some((item) => !expected.has(item.id) || !item.translatedText)) {
      throw new Error("Ánh xạ bản dịch không đầy đủ");
    }
    res.status(200).json({ segments });
  } catch (error) {
    console.error("Dịch thất bại", error instanceof Error ? error.message : "Lỗi không xác định");
    jsonError(res, 502, "TRANSLATION_FAILED", "Không thể dịch lúc này, vui lòng thử lại");
  }
}
