import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import translate from "../src/api/translate.js";
import tts from "../src/api/tts.js";
import youtubeSubtitles from "../src/api/subtitles/youtube.js";
import transcribe from "../src/api/transcribe.js";

function loadLocalEnvironment(): void {
  try {
    for (const line of readFileSync(resolve(".env.local"), "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (match?.[1] && process.env[match[1]] === undefined) process.env[match[1]] = match[2] ?? "";
    }
  } catch { /* Các endpoint sẽ trả lỗi cấu hình rõ ràng nếu thiếu biến môi trường. */ }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    size += value.length;
    if (size > 2_100_000) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(value);
  }
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function adaptResponse(response: ServerResponse): VercelResponse {
  const target = response as ServerResponse & Partial<VercelResponse>;
  target.status = (statusCode: number) => { response.statusCode = statusCode; return target as VercelResponse; };
  target.json = (value: unknown) => { response.setHeader("content-type", "application/json; charset=utf-8"); response.end(JSON.stringify(value)); return target as VercelResponse; };
  target.send = (value: unknown) => { response.end(Buffer.isBuffer(value) || typeof value === "string" ? value : JSON.stringify(value)); return target as VercelResponse; };
  return target as VercelResponse;
}

loadLocalEnvironment();
const port = Number(process.env.PORT ?? 3000);
const handlers = new Map([["/api/translate", translate], ["/api/tts", tts], ["/api/subtitles/youtube", youtubeSubtitles], ["/api/transcribe", transcribe]]);

createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const startedAt = Date.now();
  response.once("finish", () => console.log(`${request.method ?? "UNKNOWN"} ${path} → ${response.statusCode} (${Date.now() - startedAt} ms)`));
  const handler = handlers.get(path);
  if (!handler) { response.statusCode = 404; response.end("Không tìm thấy endpoint"); return; }
  try {
    (request as VercelRequest).body = await readBody(request);
    await handler(request as VercelRequest, adaptResponse(response));
  } catch (error) {
    response.statusCode = error instanceof Error && error.message === "PAYLOAD_TOO_LARGE" ? 413 : 400;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ error: { code: "INVALID_REQUEST", message: "Yêu cầu không hợp lệ" } }));
  }
}).listen(port, "127.0.0.1", () => console.log(`API local PXHDubbingYooToob đang chạy tại http://localhost:${port}`));
