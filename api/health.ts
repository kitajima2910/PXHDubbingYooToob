import type { VercelRequest, VercelResponse } from "@vercel/node";
import { transcriptCacheConfigured, translationCacheConfigured } from "../src/api/cache/store.js";

export default function handler(_req: VercelRequest, res: VercelResponse): void {
  res.status(200).json({
    ok: true,
    version: "0.1.0",
    groq: Boolean(process.env.GROQ_API_KEY),
    azure_tts: Boolean(process.env.AZURE_SPEECH_KEY?.trim() && process.env.AZURE_SPEECH_REGION?.trim()),
    transcript_cache: transcriptCacheConfigured(),
    translation_cache: translationCacheConfigured(),
    node: process.version,
  });
}
