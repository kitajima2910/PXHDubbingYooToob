# PXHDubbingYooToob

Chrome Extension Manifest V3 lồng tiếng Việt thông minh cho video YouTube với độ trễ thấp.

## Trạng thái

Pipeline transcript: `Transcript DOM → cache Neon → Translation Memory → Groq/Chrome Translator → Edge TTS / Chrome TTS → phát đồng bộ`.

Pipeline không transcript: `tabCapture → AudioWorklet PCM 16 kHz → VAD → Whisper tiny local (WebGPU/WASM) → Chrome Translator → Chrome TTS`.

**Tính năng cốt lõi đã hoàn thiện:**
- Transcript ưu tiên DOM MAIN-world, fallback qua timedtext và Neon cache.
- Video không transcript dùng Whisper local; model tải một lần, cache trong trình duyệt và không cần API key STT.
- Translation Memory 3 tầng (exact hash → canonical → quality tiers) — dùng chung cross-video.
- Bộ đệm liên tục 60 giây, tự bổ sung cho video dài bất kỳ.
- Scheduler at-most-once, smooth rate (0.95–1.35), catch-up (max +20%), proactive replacement.
- Cache audio IndexedDB (hash giọng/tốc độ/text) — replay không gọi lại TTS.
- BYOK Groq vẫn khả dụng cho pipeline transcript/cloud; nhánh Whisper local không gọi Groq.
- Subtitle Editor: sửa bản dịch → quality `reviewed`, dùng lại cho mọi video.
- Voice selection: Nam Minh (nam) / Hoài My (nữ).
- TTS: Edge TTS (primary, free) → Chrome TTS → Web Speech → bỏ qua câu lỗi.
- Nhánh không transcript dịch bằng Chrome Translator API offline; yêu cầu Chrome có Translator API.
- Dubbing lock: chặn 2 tab chạy cùng video. Content script tự phục hồi sau reload.
- Chống audio feedback. Tab ẩn → pause. Chuyển app → pause.

53/53 test pass, TypeScript strict pass, production build pass. Xem [STATUS.md](./STATUS.md).

## Kiến trúc

- `src/extension`: popup, tích hợp YouTube, API client và bộ lập lịch audio.
- `src/api`: handler Vercel, Zod validation, rate limit, retry, provider Groq/TTS.
- `src/shared`: kiểu và tiện ích dùng chung.
- `api`: entrypoint cho Vercel.
- `migrations`: schema SQL cho cache transcript/bản dịch trên Neon.
- `tests`: 10 file, 178 test đơn vị.

API key chỉ tồn tại trong biến môi trường backend.

## Chạy local

Yêu cầu Node.js 20 trở lên.

1. `npm install`
2. Sao chép `.env.example` → `.env.local`, điền `GROQ_API_KEY`, `DATABASE_URL`, `DUBBING_DATABASE_URL`
3. `npm run dev:api` — API local tại `http://localhost:3000`
4. `npm run build` — tạo extension trong `dist/`
5. Mở `chrome://extensions` → **Tải tiện ích đã giải nén** → chọn `dist/`
6. Mở video YouTube → bấm icon extension → **Bắt đầu lồng tiếng**

## TTS: Edge TTS (free & stable)

Mặc định dùng Edge TTS qua `msedge-tts` — cùng endpoint Microsoft Read Aloud của Edge browser, đã ổn định từ 2022, không giới hạn quota, không cần cấu hình gì thêm. Giọng Việt: Nam Minh (nam) và Hoài My (nữ).

**Optional upgrade**: Cấu hình `AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION` để dùng Azure Cognitive Services TTS (SLA chính thức, F0 free tier: 0.5M ký tự/tháng, reset hàng tháng). Khi Azure được cấu hình, hệ thống tự động dùng Azure thay Edge.

## Triển khai Vercel

1. Import repository vào Vercel.
2. Thêm env vars: `GROQ_API_KEY`, `GROQ_TRANSLATION_MODEL`, `DATABASE_URL`, `DUBBING_DATABASE_URL`, `TRANSLATION_CACHE_VERSION`, `EXTENSION_ORIGIN`.
3. Deploy → build với `VITE_API_BASE_URL=https://ten-du-an.vercel.app`.
4. Sau khi Chrome cấp ID extension, set `EXTENSION_ORIGIN=chrome-extension://ID_EXTENSION` và deploy lại.

Endpoint cache tự tạo bảng theo `migrations/`.

## Kiểm tra

| Lệnh | Mô tả |
|------|-------|
| `npm run check` | TypeScript strict (extension + backend) |
| `npm test` | 53 unit tests (Vitest) |
| `npm run build` | Production build → `dist/` |
| `npm run dev:api` | Backend local (không cần Vercel CLI) |

Khi API/TTS lỗi, video gốc tiếp tục phát; extension bỏ qua riêng câu lỗi.

## Giới hạn hiện tại

- **Parser phụ thuộc DOM YouTube** — có thể cần cập nhật khi YouTube thay đổi giao diện.
- **Rate limit in-memory** — không chia sẻ giữa nhiều Vercel instance.
- **Chưa có xác thực người dùng/quota** — CORS extension origin là biện pháp tạm thời.
- **Playback rate**: đồng bộ tốt ở 0.5x–1.5x; >1.5x có thể lệch.
- **Chưa có**: nhận dạng nhiều người nói (diarization), tách giọng khỏi nhạc nền.
- **Chưa có Chrome E2E test** — test thủ công trên Chrome/Brave với extension đã nạp.
