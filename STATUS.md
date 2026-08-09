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

## Khôi phục release v0.1.99 và chặn video không subtitle — 2026-08-09

### Đã thay đổi gì
- Khôi phục toàn bộ tracked source từ tag `v0.1.99` (`3083303e`).
- Popup kiểm tra transcript/subtitle YouTube ngay khi mở và giữ nút `Bắt đầu lồng tiếng` ở trạng thái disabled trong lúc kiểm tra.
- Nếu video không có transcript/subtitle, popup hiển thị rõ `Video không có transcript hoặc subtitle` và tiếp tục khóa nút.
- Hàm bắt đầu dubbing cũng kiểm tra lại và từ chối chạy nếu bị gọi trực tiếp, không chuyển sang backend/Whisper/tabCapture.
- Video có subtitle giữ nguyên pipeline transcript DOM ổn định của v0.1.99.

### File đã sửa sau khi khôi phục
- `src/extension/content.ts`
- `src/extension/popup.ts`
- `STATUS.md`

### Kết quả kiểm tra
- `npm.cmd run check`: pass.
- `npm.cmd test`: 53/53 test pass, 10/10 file.
- `npx.cmd vite build`: pass; `dist` đã được tạo lại từ source v0.1.99.
- `git diff --check`: pass.

### Vấn đề còn lại
- Cần reload extension từ `dist` và xác nhận trực tiếp trên một video có subtitle và một video không subtitle trong Chrome/Brave.

## Fix có subtitle nhưng không phát dubbing — 2026-08-09

### Đã thay đổi gì
- Nguyên nhân gốc: popup vẫn bắt đầu `tabCapture` trước `start()` theo cơ chế Whisper cũ; capture lỗi sẽ chặn luôn pipeline transcript DOM dù video có subtitle.
- Bỏ hoàn toàn `capture-start` khỏi nút lồng tiếng vì bản này chỉ hỗ trợ video có transcript/subtitle.
- Lưu transcript đã tìm thấy khi popup kiểm tra và tái sử dụng lúc bấm bắt đầu, tránh gọi bridge YouTube lần hai và tránh kết quả không đồng nhất.
- Giữ nút disabled và thông báo rõ đối với video không có transcript/subtitle.

### File đã sửa
- `src/extension/content.ts`
- `src/extension/popup.ts`
- `package.json`
- `public/manifest.json`
- `STATUS.md`

### Kết quả kiểm tra
- `npm.cmd run check`: pass.
- `npm.cmd test`: 53/53 test pass, 10/10 file.
- `npx.cmd vite build`: pass.
- `git diff --check`: pass.

### Vấn đề còn lại
- Cần reload extension từ `dist` để trình duyệt dùng bundle mới; tab đã mở cũng cần refresh.
