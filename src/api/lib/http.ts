import type { VercelRequest, VercelResponse } from "@vercel/node";

const buckets = new Map<string, { count: number; resetAt: number }>();

export function prepare(req: VercelRequest, res: VercelResponse, maxBytes = 64_000): boolean {
  const allowedOrigin = process.env.EXTENSION_ORIGIN;
  const origin = req.headers.origin;
  if (allowedOrigin && origin && origin !== allowedOrigin) { jsonError(res, 403, "ORIGIN_DENIED", "Nguồn yêu cầu không được phép"); return false; }
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin ?? "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") { res.status(204).end(); return false; }
  if (req.method !== "POST") { jsonError(res, 405, "METHOD_NOT_ALLOWED", "Phương thức không được hỗ trợ"); return false; }
  const length = Number(req.headers["content-length"] ?? 0);
  if (length > maxBytes) { jsonError(res, 413, "PAYLOAD_TOO_LARGE", "Dữ liệu gửi lên quá lớn"); return false; }
  const key = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "unknown").split(",")[0]!.trim();
  const now = Date.now(); const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) buckets.set(key, { count: 1, resetAt: now + 60_000 });
  else if (++bucket.count > 60) { jsonError(res, 429, "RATE_LIMITED", "Quá nhiều yêu cầu, vui lòng thử lại sau"); return false; }
  return true;
}

export function jsonError(res: VercelResponse, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export async function retry<T>(operation: (signal: AbortSignal) => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20_000);
    try { return await operation(controller.signal); }
    catch (error) { lastError = error; if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt)); }
    finally { clearTimeout(timer); }
  }
  throw lastError;
}
