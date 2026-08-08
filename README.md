# PXHDubbingYooToob

Chrome Extension Manifest V3 lồng tiếng Việt thông minh cho video YouTube với độ trễ thấp.

## Trạng thái

Pipeline hoàn chỉnh: `Transcript DOM → cache Neon → Translation Memory (exact/canonical/gold) → Groq dịch → Edge TTS / Chrome TTS / Web Speech → phát đồng bộ`.

**Tính năng cốt lõi đã hoàn thiện:**
- Transcript ưu tiên DOM MAIN-world, fallback qua timedtext, Neon cache, và Groq Whisper (5s chunk).
- Translation Memory 3 tầng (exact hash → canonical → quality tiers: machine/reviewed/gold) — dùng chung cross-video.
- Bộ đệm liên tục 60 giây, tự bổ sung cho video dài bất kỳ.
- Scheduler at-most-once, smooth rate (0.95–1.35), catch-up (max +20%), proactive replacement.
- Cache audio IndexedDB (hash giọng/tốc độ/text) — replay không gọi lại TTS.
- BYOK Groq: key riêng + auto-failover về backend. Cooldown sau 429.
- Subtitle Editor: sửa bản dịch → quality `reviewed`, dùng lại cho mọi video.
- Voice selection: Nam Minh (nam) / Hoài My (nữ).
- Fallback đa tầng: Edge TTS → Chrome TTS → Web Speech API → bỏ qua câu lỗi.
- Dịch batch thích ứng (batch → nhỏ dần → từng câu → Chrome Translator API offline).
- Dubbing lock: chặn 2 tab chạy cùng video. Content script tự phục hồi sau reload extension.
- Chống audio feedback (fingerprint TTS, chặn Whisper nhận lại giọng dubbing).
- Tab ẩn → pause dubbing; chuyển app → pause.

178/178 test pass, TypeScript strict pass, production build pass. Xem [STATUS.md](./STATUS.md).

## Kiến trúc

- `src/extension`: popup, tích hợp YouTube, API client và bộ lập lịch audio.
- `src/api`: handler Vercel, kiểm tra đầu vào, rate limit, retry và provider Groq/Edge TTS.
- `src/shared`: kiểu và tiện ích dùng chung.
- `api`: entrypoint cho Vercel.
- `migrations`: schema SQL cho cache transcript/bản dịch trên Neon.
- `tests`: 10 file, 178 test đơn vị.

API key chỉ tồn tại trong biến môi trường backend. Extension không lưu MP3 trên server.

## Chạy local

Yêu cầu Node.js 20 trở lên.

1. `npm install`
2. Sao chép `.env.example` → `.env.local`, điền `GROQ_API_KEY`, `DATABASE_URL`, `DUBBING_DATABASE_URL`
3. `npm run dev:api` — API local tại `http://localhost:3000`
4. `npm run build` — tạo extension trong `dist/`
5. Mở `chrome://extensions` → **Tải tiện ích đã giải nén** → chọn `dist/`
6. Mở video YouTube → bấm icon extension → **Bắt đầu lồng tiếng**

## Triển khai Vercel

1. Import repository vào Vercel.
2. Thêm env vars: `GROQ_API_KEY`, `GROQ_TRANSLATION_MODEL`, `DATABASE_URL`, `DUBBING_DATABASE_URL`, `TRANSLATION_CACHE_VERSION`, `EXTENSION_ORIGIN`.
3. Deploy → build với `VITE_API_BASE_URL=https://ten-du-an.vercel.app`.
4. Sau khi Chrome cấp ID extension, set `EXTENSION_ORIGIN=chrome-extension://ID_EXTENSION` và deploy lại.

Endpoint cache tự tạo bảng theo `migrations/`. Dùng `npm run migrate:global-translations` để chuyển dữ liệu cũ.

## Kiểm tra

| Lệnh | Mô tả |
|------|-------|
| `npm run check` | TypeScript strict (extension + backend) |
| `npm test` | 178 unit tests (Vitest) |
| `npm run build` | Production build → `dist/` |
| `npm run dev:api` | Backend local (không cần Vercel CLI) |

Khi API/TTS lỗi, video gốc tiếp tục phát; extension bỏ qua riêng câu lỗi.

## Giới hạn hiện tại

- **Parser phụ thuộc DOM YouTube** (`ytInitialPlayerResponse`, `transcript-segment-view-model`) — có thể cần cập nhật khi YouTube thay đổi.
- **Rate limit in-memory** — không chia sẻ giữa nhiều Vercel instance. Cần Redis/Upstash cho production.
- **Chưa có xác thực người dùng/quota** — CORS extension origin là biện pháp tạm thời.
- **`msedge-tts` là client không chính thức** — sẽ thay bằng Azure Cognitive Services TTS chính thức.
- **Playback rate**: đồng bộ tốt ở 0.5x–1.5x; >1.5x có thể lệch.
- **Chưa có**: nhận dạng nhiều người nói (diarization), tách giọng khỏi nhạc nền.
- **Chưa có Chrome E2E test** — cần thêm Playwright/Puppeteer test extension trên YouTube thật.
- **npm audit**: 10 advisory (3 moderate, 7 high) từ transitive dependencies của `@vercel/node` — đang xử lý upgrade lên v4.
