import type { VercelRequest, VercelResponse } from "@vercel/node";
import { jsonError, prepare } from "../lib/http.js";

interface AssemblyTokenResponse {
  token?: string;
  expires_in_seconds?: number;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (!prepare(req, res, 1_000)) return;
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) return jsonError(res, 503, "MISSING_ASSEMBLYAI_KEY", "Backend chưa cấu hình ASSEMBLYAI_API_KEY");
  try {
    const url = new URL("https://streaming.assemblyai.com/v3/token");
    url.searchParams.set("expires_in_seconds", "60");
    url.searchParams.set("max_session_duration_seconds", "10800");
    const response = await fetch(url, { headers: { authorization: key }, signal: AbortSignal.timeout(10_000) });
    const payload = await response.json().catch(() => undefined) as AssemblyTokenResponse | undefined;
    if (!response.ok || !payload?.token) throw new Error(`AssemblyAI trả HTTP ${response.status}`);
    res.status(200).json({ token: payload.token, expiresInSeconds: payload.expires_in_seconds ?? 60 });
  } catch (error) {
    console.error("Cấp token AssemblyAI thất bại", error instanceof Error ? error.message : "Lỗi không xác định");
    jsonError(res, 502, "ASSEMBLYAI_TOKEN_FAILED", "Không thể khởi tạo nhận dạng AssemblyAI lúc này");
  }
}
