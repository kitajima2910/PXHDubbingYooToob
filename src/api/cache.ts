import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import { readTranscript, readTranslations, reviewTranslations, transcriptCacheConfigured, translationCacheConfigured, writeTranscript, writeTranslations } from "./cache/store.js";
import { jsonError, prepare } from "./lib/http.js";

const languageContext = z.object({ sourceLanguage: z.string().min(2).max(16) });
const transcriptContext = languageContext.extend({
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
});
const segment = z.object({
  id: z.string().min(1).max(160),
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
  sourceText: z.string().min(1).max(1_000),
});
const schema = z.discriminatedUnion("action", [
  transcriptContext.extend({ action: z.literal("transcript:get"), fromMs: z.number().int().min(0).optional(), toMs: z.number().int().positive().optional() }),
  transcriptContext.extend({
    action: z.literal("transcript:put"), source: z.string().min(1).max(80), complete: z.boolean(),
    segments: z.array(segment).max(2_000),
    window: z.object({ fromMs: z.number().int().min(0), toMs: z.number().int().positive() }).refine((value) => value.toMs > value.fromMs).optional(),
  }).refine((value) => value.segments.length > 0 || value.window !== undefined),
  languageContext.extend({
    action: z.literal("translations:get"), targetLanguage: z.literal("vi"),
    segments: z.array(segment.pick({ id: true, sourceText: true })).min(1).max(20),
  }),
  languageContext.extend({
    action: z.literal("translations:put"), targetLanguage: z.literal("vi"),
    segments: z.array(segment.pick({ sourceText: true }).extend({ translatedText: z.string().min(1).max(2_000) })).min(1).max(20),
  }),
  languageContext.extend({
    action: z.literal("translations:review"), targetLanguage: z.literal("vi"),
    segments: z.array(segment.pick({ sourceText: true }).extend({ translatedText: z.string().min(1).max(2_000) })).min(1).max(20),
  }),
]);

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!prepare(req, res, 1_500_000)) return;
  const input = schema.safeParse(req.body);
  if (!input.success) return jsonError(res, 400, "INVALID_CACHE_INPUT", "Dữ liệu cache không hợp lệ");
  try {
    const data = input.data;
    if (data.action === "transcript:get") {
      if (!transcriptCacheConfigured()) { res.status(200).json({ enabled: false }); return; }
      res.status(200).json({ enabled: true, ...(await readTranscript(data, data.fromMs, data.toMs)) });
      return;
    }
    if (data.action === "transcript:put") {
      if (!transcriptCacheConfigured()) { res.status(200).json({ enabled: false }); return; }
      await writeTranscript(data, data.source, data.segments, data.complete, data.window);
      res.status(200).json({ enabled: true });
      return;
    }
    if (data.action === "translations:get") {
      if (!translationCacheConfigured()) { res.status(200).json({ enabled: false }); return; }
      res.status(200).json({ enabled: true, segments: await readTranslations(data, data.segments) });
      return;
    }
    if (!translationCacheConfigured()) { res.status(200).json({ enabled: false }); return; }
    if (data.action === "translations:review") {
      await reviewTranslations(data, data.segments);
    } else {
      await writeTranslations(data, data.segments);
    }
    res.status(200).json({ enabled: true });
  } catch (error) {
    console.error("Cache Neon thất bại", error instanceof Error ? error.message : "Lỗi không xác định");
    jsonError(res, 502, "CACHE_FAILED", "Không thể truy cập cache lúc này");
  }
}
