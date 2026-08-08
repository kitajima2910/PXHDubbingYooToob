import type { VercelRequest, VercelResponse } from "@vercel/node";
import Groq from "groq-sdk";
import { z } from "zod";
import { jsonError, prepare, retry } from "./lib/http.js";
import { formatSegmentsForSummary } from "./lib/summary-helpers.js";

const schema = z.object({
  segments: z.array(z.object({
    sourceText: z.string().min(1),
    translatedText: z.string().optional(),
  })).min(1).max(200),
  maxWords: z.number().min(50).max(500).optional().default(150),
});

const SYSTEM_PROMPT = (maxWords: number) =>
  `Bạn là trợ lý tóm tắt nội dung video YouTube. Tóm tắt bằng tiếng Việt, ngắn gọn, đầy đủ ý chính, không quá ${maxWords} từ. Nếu có cả bản gốc và bản dịch, ưu tiên nội dung bản dịch.`;

const MAX_CHARS = 6_000;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!prepare(req, res)) return;
  const input = schema.safeParse(req.body);
  if (!input.success) return jsonError(res, 400, "INVALID_INPUT", "Dữ liệu tóm tắt không hợp lệ");
  try {
    const { segments, maxWords } = input.data;
    const { text } = formatSegmentsForSummary(segments, MAX_CHARS);
    const summary = await retry(async (signal) => {
      const key = process.env.GROQ_API_KEY;
      if (!key) throw new Error("Backend chưa cấu hình GROQ_API_KEY");
      const client = new Groq({ apiKey: key });
      const response = await client.chat.completions.create({
        model: process.env.GROQ_TRANSLATION_MODEL ?? "llama-3.3-70b-versatile",
        temperature: 0.3,
        messages: [
          { role: "system", content: SYSTEM_PROMPT(maxWords) },
          { role: "user", content: text },
        ],
      }, { signal });
      return response.choices[0]?.message.content ?? "";
    });
    res.status(200).json({ summary: summary.trim() });
  } catch (error) {
    console.error("Tóm tắt thất bại", error instanceof Error ? error.message : "Lỗi không xác định");
    jsonError(res, 502, "SUMMARY_FAILED", "Không thể tóm tắt lúc này, vui lòng thử lại");
  }
}
