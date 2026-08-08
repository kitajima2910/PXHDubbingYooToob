# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: dubbing.spec.ts >> PXHDubbingYooToob API E2E >> GET /api/health returns ok
- Location: tests\e2e\dubbing.spec.ts:17:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 200
Received: 404
```

# Test source

```ts
  1  | ﻿import { test, expect } from "@playwright/test";
  2  | 
  3  | const API_URL = process.env.VITE_API_BASE_URL ?? "http://localhost:3000";
  4  | 
  5  | // Chạy `npm run dev:api` ở terminal khác trước khi chạy test này.
  6  | // Hoặc set VITE_API_BASE_URL=https://pxh-dubbing-yoo-toob.vercel.app để test production.
  7  | 
  8  | async function ensureServer( request: ReturnType<typeof test["info"]> extends never ? never : Parameters<Parameters<typeof test>[1]>[0]["request"] ): Promise<boolean> {
  9  |   try {
  10 |     const r = await (request as any).get(`${API_URL}/api/health`, { timeout: 2000 });
  11 |     return r.ok();
  12 |   } catch { return false; }
  13 | }
  14 | 
  15 | test.describe("PXHDubbingYooToob API E2E", () => {
  16 | 
  17 |   test("GET /api/health returns ok", async ({ request }) => {
  18 |     const response = await request.get(`${API_URL}/api/health`);
> 19 |     expect(response.status()).toBe(200);
     |                               ^ Error: expect(received).toBe(expected) // Object.is equality
  20 |     const body = await response.json();
  21 |     expect(body.ok).toBe(true);
  22 |     expect(body.version).toBe("0.1.0");
  23 |     console.log("Health:", JSON.stringify(body));
  24 |   });
  25 | 
  26 |   test("POST /api/subtitles/youtube returns segments", async ({ request }) => {
  27 |     const response = await request.post(`${API_URL}/api/subtitles/youtube`, {
  28 |       data: { videoId: "dQw4w9WgXcQ", fromMs: 0, toMs: 60_000 },
  29 |     });
  30 |     expect([200, 404, 502]).toContain(response.status());
  31 |     if (response.status() === 200) {
  32 |       const body = await response.json();
  33 |       expect(Array.isArray(body.segments)).toBe(true);
  34 |       console.log("Segments:", body.segments.length);
  35 |     }
  36 |   });
  37 | 
  38 |   test("POST /api/translate returns Vietnamese translation", async ({ request }) => {
  39 |     const response = await request.post(`${API_URL}/api/translate`, {
  40 |       data: {
  41 |         sourceLanguage: "en", targetLanguage: "vi",
  42 |         segments: [{ id: "t1", sourceText: "Hello world." }],
  43 |       },
  44 |     });
  45 |     if (response.status() === 503) {
  46 |       test.skip(true, "GROQ_API_KEY not configured");
  47 |       return;
  48 |     }
  49 |     expect(response.status()).toBe(200);
  50 |     const body = await response.json();
  51 |     expect(body.segments[0].translatedText).toBeTruthy();
  52 |     console.log("Dịch:", body.segments[0].translatedText);
  53 |   });
  54 | 
  55 |   test("POST /api/tts returns MP3 audio", async ({ request }) => {
  56 |     const response = await request.post(`${API_URL}/api/tts`, {
  57 |       data: { text: "Xin chào", voice: "vi-VN-NamMinhNeural", rate: 1 },
  58 |     });
  59 |     expect(response.status()).toBe(200);
  60 |     const contentType = response.headers()["content-type"];
  61 |     expect(contentType).toContain("audio/mpeg");
  62 |     const buffer = await response.body();
  63 |     expect(buffer.length).toBeGreaterThan(500);
  64 |     console.log("TTS:", buffer.length, "bytes");
  65 |   });
  66 | 
  67 |   test("POST /api/cache returns status", async ({ request }) => {
  68 |     const response = await request.post(`${API_URL}/api/cache`, {
  69 |       data: { action: "transcript:get", videoId: "dQw4w9WgXcQ", sourceLanguage: "en" },
  70 |     });
  71 |     expect(response.status()).toBe(200);
  72 |     const body = await response.json();
  73 |     expect(typeof body.enabled).toBe("boolean");
  74 |     console.log("Cache:", body.enabled ? "enabled" : "disabled");
  75 |   });
  76 | });
  77 | 
```