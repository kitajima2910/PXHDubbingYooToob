import type { VercelRequest, VercelResponse } from "@vercel/node";
import { transcriptCacheConfigured, translationCacheConfigured } from "../src/api/cache/store.js";

export default function handler(_req: VercelRequest, res: VercelResponse): void {
  res.status(200).json({
    ok: true,
    version: "0.1.0",
    groq: Boolean(process.env.GROQ_API_KEY),
    transcript_cache: transcriptCacheConfigured(),
    translation_cache: translationCacheConfigured(),
    node: process.version,
  });
}
