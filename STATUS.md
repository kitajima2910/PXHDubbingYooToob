# Trạng thái PXHDubbingYooToob — 2026-08-08

## P0 Hoàn thiện (2026-08-08)

### P0-1: README.md ✅
Viết lại toàn bộ — phản ánh đúng pipeline, tính năng, giới hạn.

### P0-3: TTS Free ✅
- Edge TTS (msedge-tts) giữ làm primary — free, không giới hạn, ổn định từ 2022.
- Azure Cognitive Services TTS là optional upgrade — chỉ load khi có `AZURE_SPEECH_KEY`.
- Voice IDs giữ nguyên (NamMinhNeural, HoaiMyNeural).

### P0-4: npm audit ✅
- Upgrade `@vercel/node` v3→v4.0.0, giảm 10→8 advisory.
- Các advisory còn lại đều là transitive build-time dependency của `@vercel/nft`, không ảnh hưởng runtime.

### P0-2: E2E Test ✅
- Cài Playwright, tạo `tests/e2e/dubbing.spec.ts` (5 API tests).
- `api/health.ts` — health check endpoint mới.
- Production test: 4/5 pass (health endpoint cần deploy Vercel).
- `npm run test:e2e` — tự động test local hoặc production.

### Files thay đổi
- `README.md`, `STATUS.md`: cập nhật
- `package.json`: thêm `test:e2e`, Playwright, Azure SDK
- `.env.example`: thêm `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`
- `src/api/tts.ts`: Edge default + Azure optional (dynamic import)
- `src/api/providers/azure-tts.ts`: **MỚI** — Azure TTS provider
- `src/api/providers/tts-edge.ts`: **MỚI** — Edge TTS provider
- `src/api/providers/tts.ts`: re-export
- `src/shared/voices.ts`: `kind: "azure"`
- `api/health.ts`: **MỚI** — health check endpoint
- `playwright.config.ts`: **MỚI**
- `tests/e2e/dubbing.spec.ts`: **MỚI** — 5 API E2E tests

## Verify cuối phiên

| Check | Kết quả |
|-------|---------|
| `npm run check` | ✅ Pass |
| `npm run build` | ✅ Pass (7 output files, content.js standalone) |
| `npm test` (unit) | ✅ 53/53 project tests pass |
| `npm run test:e2e` (production) | ✅ 4/5 pass (health endpoint cần deploy) |

## Status hiện tại

Pipeline hoàn chỉnh: `Transcript DOM → cache Neon → Translation Memory → Groq dịch → Edge TTS / Chrome TTS / Web Speech → phát đồng bộ`.

Tất cả tính năng cốt lõi hoạt động. Free, không cần API key trả phí cho TTS.

## Fix dubbing video không có transcript DOM — 2026-08-08

### Đã thay đổi
- Không còn loại toàn bộ chunk Whisper khi mô hình nhận diện tiếng Việt; chỉ bỏ segment thực sự trùng nội dung TTS đã phát.
- Bảo đảm câu đầu trong mỗi chunk được đưa vào scheduler trước, tránh câu sau hoàn thành TTS sớm và làm câu trước hết thời gian phát.
- Giữ cửa sổ thu Whisper 5 giây để hạn chế độ trễ realtime; chuẩn hóa timestamp tương đối theo câu đầu của chunk để không cộng thêm độ trễ cho từng câu.
- Cho phép mọi giọng Chrome TTS tiếng Việt trong Whisper mode, vẫn ưu tiên Nam Minh/giọng nam, nhằm tránh MP3 dubbing bị thu ngược vào tab khi máy có giọng Việt khác.

### File đã sửa
- `src/extension/content.ts`
- `src/extension/background.ts`
- `src/extension/offscreen.ts`
- `STATUS.md`

### Kết quả kiểm tra
- `npm.cmd run check`: pass.
- `npm.cmd test`: 53/53 test pass.
- `npx.cmd vite build` và API TypeScript check: pass; build không chạy script tự tăng version.

### Vấn đề còn lại
- Chưa thể chạy thử trực tiếp trên một video YouTube không có transcript DOM trong phiên terminal; cần reload extension và kiểm tra thực tế trên trình duyệt để đánh giá chất lượng nhận dạng của Whisper theo nội dung/âm thanh video.
