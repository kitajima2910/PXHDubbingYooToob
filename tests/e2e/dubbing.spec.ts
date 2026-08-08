import { test, expect } from "@playwright/test";

const API_URL = process.env.VITE_API_BASE_URL ?? "http://localhost:3000";

// Chạy `npm run dev:api` ở terminal khác trước khi chạy test này.
// Hoặc set VITE_API_BASE_URL=https://pxh-dubbing-yoo-toob.vercel.app để test production.

async function ensureServer( request: ReturnType<typeof test["info"]> extends never ? never : Parameters<Parameters<typeof test>[1]>[0]["request"] ): Promise<boolean> {
  try {
    const r = await (request as any).get(`${API_URL}/api/health`, { timeout: 2000 });
    return r.ok();
  } catch { return false; }
}

test.describe("PXHDubbingYooToob API E2E", () => {

  test("GET /api/health returns ok", async ({ request }) => {
    const response = await request.get(`${API_URL}/api/health`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.version).toBe("0.1.0");
    console.log("Health:", JSON.stringify(body));
  });

  test("POST /api/subtitles/youtube returns segments", async ({ request }) => {
    const response = await request.post(`${API_URL}/api/subtitles/youtube`, {
      data: { videoId: "dQw4w9WgXcQ", fromMs: 0, toMs: 60_000 },
    });
    expect([200, 404, 502]).toContain(response.status());
    if (response.status() === 200) {
      const body = await response.json();
      expect(Array.isArray(body.segments)).toBe(true);
      console.log("Segments:", body.segments.length);
    }
  });

  test("POST /api/translate returns Vietnamese translation", async ({ request }) => {
    const response = await request.post(`${API_URL}/api/translate`, {
      data: {
        sourceLanguage: "en", targetLanguage: "vi",
        segments: [{ id: "t1", sourceText: "Hello world." }],
      },
    });
    if (response.status() === 503) {
      test.skip(true, "GROQ_API_KEY not configured");
      return;
    }
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.segments[0].translatedText).toBeTruthy();
    console.log("Dịch:", body.segments[0].translatedText);
  });

  test("POST /api/tts returns MP3 audio", async ({ request }) => {
    const response = await request.post(`${API_URL}/api/tts`, {
      data: { text: "Xin chào", voice: "vi-VN-NamMinhNeural", rate: 1 },
    });
    expect(response.status()).toBe(200);
    const contentType = response.headers()["content-type"];
    expect(contentType).toContain("audio/mpeg");
    const buffer = await response.body();
    expect(buffer.length).toBeGreaterThan(500);
    console.log("TTS:", buffer.length, "bytes");
  });

  test("POST /api/cache returns status", async ({ request }) => {
    const response = await request.post(`${API_URL}/api/cache`, {
      data: { action: "transcript:get", videoId: "dQw4w9WgXcQ", sourceLanguage: "en" },
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(typeof body.enabled).toBe("boolean");
    console.log("Cache:", body.enabled ? "enabled" : "disabled");
  });
});
