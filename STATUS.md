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

## Whisper local miễn phí — 2026-08-09

### Đã thay đổi
- Model `onnx-community/whisper-tiny` multilingual tự tải khi content script khởi tạo, dùng Cache API của Transformers.js và chỉ tải lại khi cache/model thay đổi.
- Overlay trên trang YouTube hiển thị tiến trình model, trạng thái sẵn sàng, thử lại và nút bắt đầu lồng tiếng.
- Thay MediaRecorder/WebM trong nhánh dubbing trực tiếp bằng AudioWorklet xuất PCM mono 16 kHz theo frame 100 ms.
- Thêm VAD: pre-roll 300 ms, kết câu sau 600 ms im lặng, giới hạn câu 8 giây để giữ độ trễ.
- Whisper chạy trong Worker, ưu tiên WebGPU và fallback WASM một thread tương thích Manifest V3.
- Video không transcript dùng Chrome Translator và Chrome/Web Speech TTS local; không gọi Groq STT, Google Translate hay TTS cloud trong nhánh local.
- Thêm backpressure: máy không theo kịp sẽ tạm dừng video khi có từ hai đoạn nhận dạng tồn đọng và tự phát lại khi hàng đợi giảm.
- Transcript DOM/timedtext/cache và pipeline đang hoạt động được giữ nguyên.
- Manifest yêu cầu Chrome 138, bật CSP WebAssembly, đóng gói WASM/Worker và chỉ cho tải model data từ Hugging Face.

### File đã sửa/thêm
- `package.json`, `package-lock.json`
- `public/manifest.json`
- `src/extension/local-stt/pcm-worklet.ts`
- `src/extension/local-stt/whisper-worker.ts`
- `src/extension/local-stt/vad.ts`
- `src/extension/offscreen.ts`
- `src/extension/background.ts`
- `src/extension/content.ts`
- `src/extension/popup.ts`
- `tests/vad.test.ts`
- `README.md`, `STATUS.md`

### Kết quả kiểm tra
- `npm.cmd run check`: pass.
- `npm.cmd test`: 56/56 test pass, 11/11 file.
- Vite production build + API TypeScript check: pass.
- Bundle tạo Worker Whisper, AudioWorklet và WASM local; content script vẫn standalone.
- `git diff --check`: pass.

### Vấn đề còn lại
- Không có Chrome/Edge kết nối trong môi trường browser test, nên chưa verify được model download, CSP/WebGPU/WASM và tabCapture end-to-end trên extension đã nạp.
- `npm audit` báo advisory ở dependency Node-only của Transformers.js (`sharp`, `onnxruntime-node`) và các advisory build-time Vercel cũ. Các module Node-only không có trong bundle extension; upstream chưa có fix cho nhánh Transformers.js này.
- Dubbing local là near-realtime, không thể tức thời tuyệt đối; chất lượng và việc backpressure có kích hoạt hay không phụ thuộc CPU/GPU của máy.

## Fix quyền tabCapture từ overlay — 2026-08-09

### Đã thay đổi
- Sửa nguyên nhân `Error starting tab capture`: nút trên overlay không còn yêu cầu thu âm trực tiếp từ content script.
- Nút overlay giờ mở popup PXH; thao tác thu âm chỉ bắt đầu từ nút `Bắt đầu lồng tiếng` trong popup, đúng ngữ cảnh extension invocation mà Chrome yêu cầu.

### File đã sửa
- `src/extension/content.ts`
- `src/extension/background.ts`
- `STATUS.md`

### Kết quả kiểm tra
- `npm.cmd run check`: pass.
- `npm.cmd test`: 56/56 test pass, 11/11 file.
- `npx.cmd vite build`: pass; `dist` đã được tạo lại.
- `git diff --check`: pass.

### Vấn đề còn lại
- Cần reload extension đã build và xác nhận tabCapture trực tiếp trên Chrome.

## Chuyển tải model vào popup — 2026-08-09

### Đã thay đổi
- Gỡ hoàn toàn overlay Whisper khỏi trang YouTube.
- Popup hiển thị phần trăm tải model, thanh tiến trình, trạng thái đã lưu trên máy và lỗi tải.
- Khóa nút bắt đầu trong lúc model đang tải; nếu lỗi, popup cung cấp nút `Thử tải lại`.
- Popup đọc trạng thái trực tiếp từ offscreen process nên đóng/mở lại vẫn thấy đúng tiến trình hiện tại.

### File đã sửa
- `src/extension/content.ts`
- `src/extension/background.ts`
- `src/extension/offscreen.ts`
- `src/extension/popup.ts`
- `src/extension/popup-model.css`
- `STATUS.md`

### Kết quả kiểm tra
- `npm.cmd run check`: pass.
- `npm.cmd test`: 56/56 test pass, 11/11 file.
- `npx.cmd vite build`: pass; `dist` đã được tạo lại.
- `git diff --check`: pass.

### Vấn đề còn lại
- Cần reload extension và xác nhận trực tiếp phần trăm tải model trong popup Chrome.

## Fix tabCapture trên Chromium/Brave — 2026-08-09

### Đã thay đổi
- Chuyển `chrome.tabCapture.getMediaStreamId()` từ service worker sang gọi đồng bộ ngay trong sự kiện click của popup.
- Popup chuyển stream ID đã được người dùng cấp sang background/offscreen; tránh mất `user gesture` sau các thao tác bất đồng bộ.
- Background vẫn giữ đường fallback cũ cho các caller khác.

### File đã sửa
- `src/extension/popup.ts`
- `src/extension/background.ts`
- `STATUS.md`

### Kết quả kiểm tra
- `npm.cmd run check`: pass.
- `npm.cmd test`: 56/56 test pass, 11/11 file.
- `npx.cmd vite build`: pass; `dist` đã được tạo lại.
- `git diff --check`: pass.

### Vấn đề còn lại
- Cần reload extension và xác nhận capture thực tế trên Brave.

## Fix AudioWorklet module — 2026-08-09

### Đã thay đổi
- Xác định Vite đã inline `pcm-worklet.ts` thành URL `data:video/mp2t`, bị AudioWorklet của extension từ chối.
- Chuyển worklet sang entry `?worker&url` để build thành file JavaScript độc lập có URL extension hợp lệ.

### File đã sửa
- `src/extension/offscreen.ts`
- `STATUS.md`

### Kết quả kiểm tra
- `npm.cmd run check`: pass.
- `npm.cmd test`: 56/56 test pass, 11/11 file.
- `npx.cmd vite build`: pass.
- Xác nhận `dist/assets/pcm-worklet-NBJZvJNM.js` được phát hành riêng và offscreen gọi URL `/assets/pcm-worklet-NBJZvJNM.js`; không còn data URL sai MIME.
- `git diff --check`: pass.

### Vấn đề còn lại
- Cần reload extension và xác nhận AudioWorklet trực tiếp trên Brave.
