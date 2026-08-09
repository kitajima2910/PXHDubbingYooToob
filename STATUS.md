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

## Fix Brave không có Translator API — 2026-08-09

### Đã thay đổi
- Nhánh Whisper vẫn ưu tiên Chrome Translator API chạy local khi trình duyệt hỗ trợ.
- Nếu Brave không có Translator API/model ngôn ngữ, tự chuyển sang pipeline dịch fallback hiện có (`cache → Groq/default → Google Translate`) thay vì dừng dubbing.
- Không thêm model hoặc dependency mới; Chrome có Translator API giữ nguyên hành vi local.

### File đã sửa
- `src/extension/content.ts`
- `STATUS.md`

### Kết quả kiểm tra
- `npm.cmd run check`: pass.
- `npm.cmd test`: 56/56 test pass, 11/11 file.
- `npx.cmd vite build`: pass; `dist` đã được tạo lại.
- `git diff --check`: pass.

### Vấn đề còn lại
- Trên Brave, dịch fallback cần kết nối mạng; Translator API offline chỉ khả dụng trên trình duyệt triển khai API này.

## Fix Whisper đọc nguyên văn ngoại ngữ — 2026-08-09

### Đã thay đổi
- Loại bản dịch cache trùng nguyên văn nguồn đối với câu Whisper không phải tiếng Việt và buộc dịch lại.
- Xem kết quả Groq trùng nguồn là không hợp lệ để pipeline chuyển sang provider fallback.
- Nhánh Whisper không còn đưa `sourceText` ngoại ngữ trực tiếp vào TTS khi thiếu bản dịch.

### File đã sửa
- `src/extension/api/client.ts`
- `src/extension/content.ts`
- `STATUS.md`

### Kết quả kiểm tra
- `npm.cmd run check`: pass.
- `npm.cmd test`: 56/56 test pass, 11/11 file.
- `npx.cmd vite build`: pass; `dist` đã được tạo lại.
- `git diff --check`: pass.

### Vấn đề còn lại
- Whisper tiny tự nhận diện ngôn ngữ từ từng đoạn audio ngắn; video đa ngôn ngữ hoặc âm thanh khó vẫn có thể nhận dạng sai câu nguồn.

## Fix đã xử lý nhưng không phát dubbing — 2026-08-09

### Đã thay đổi
- Xác định timestamp được neo trước bước dịch; fallback trên Brave hoàn thành muộn khiến scheduler coi câu đã hết hạn dù bộ đếm vẫn tăng.
- Sau khi dịch xong, dời toàn bộ cụm câu tới trước thời điểm video hiện tại 500 ms và giữ nguyên khoảng cách tương đối giữa các câu.
- Bộ đếm xử lý và cửa sổ phát giờ dùng cùng các segment đã được neo lại.

### File đã sửa
- `src/extension/content.ts`
- `STATUS.md`

### Kết quả kiểm tra
- `npm.cmd run check`: pass.
- `npm.cmd test`: 56/56 test pass, 11/11 file.
- `npx.cmd vite build`: pass; `dist` đã được tạo lại.
- `git diff --check`: pass.

### Vấn đề còn lại
- Cần reload extension và xác nhận âm thanh TTS thực tế trên Brave.

## Fix Brave chỉ nghe tiếng Anh và lệch thời gian — 2026-08-09

### Đã thay đổi
- Xác định tiếng Anh người dùng nghe là âm thanh gốc; Chrome TTS/Web Speech không có giọng Việt và Edge TTS đang bị cấm trong Whisper mode.
- Cho phép Edge TTS miễn phí làm fallback khi máy không có `chrome.tts` tiếng Việt.
- Sau khi Edge TTS tạo xong audio, neo lại segment lần cuối về trước thời điểm video hiện tại 350 ms để không bị scheduler bỏ vì hết hạn.
- Máy có Chrome TTS tiếng Việt vẫn ưu tiên TTS local như trước.

### File đã sửa
- `src/extension/content.ts`
- `STATUS.md`

### Kết quả kiểm tra
- `npm.cmd run check`: pass.
- `npm.cmd test`: 56/56 test pass, 11/11 file.
- `npx.cmd vite build`: pass; `dist` đã được tạo lại.
- `git diff --check`: pass.

### Vấn đề còn lại
- Edge TTS cần mạng và có thêm độ trễ tạo audio; đây là fallback cho Brave không cài giọng Việt local.

## Giảm latency Whisper realtime — 2026-08-09

### Đã thay đổi
- Giảm thời gian chờ kết câu VAD từ 600 ms xuống 350 ms.
- Giảm chunk tối đa từ 8 giây xuống 5 giây, tối thiểu từ 500 ms xuống 400 ms và pre-roll từ 300 ms xuống 200 ms.
- Giảm delay Whisper cấu hình từ 5 giây xuống 1 giây.
- Sau lần đầu xác định Brave không có Translator API, không thử lại API lỗi ở mọi chunk; chuyển thẳng sang dịch fallback.

### File đã sửa
- `src/extension/offscreen.ts`
- `src/extension/content.ts`
- `src/extension/popup.ts`
- `STATUS.md`

### Kết quả kiểm tra
- `npm.cmd run check`: pass.
- `npm.cmd test`: 56/56 test pass, 11/11 file.
- `npx.cmd vite build`: pass; `dist` đã được tạo lại.
- `git diff --check`: pass.

### Vấn đề còn lại
- Video không transcript không thể đạt độ trễ bằng pipeline DOM: vẫn phải chờ kết câu, Whisper, dịch và TTS. Máy yếu hoặc Edge TTS mạng chậm sẽ kích hoạt cơ chế tạm dừng để bắt kịp.

## Live Caption floating miễn phí — 2026-08-09

### Đã thay đổi
- Thêm Live Caption lời gốc nhỏ ở góc trên-phải, chỉ xuất hiện trong chế độ Whisper.
- Caption cập nhật ngay khi Whisper local trả segment, trước bước dịch và Edge TTS.
- Nút `−` thu gọn caption thành huy hiệu `CC`; bấm `CC` để mở lại.
- Ghi nhớ trạng thái thu gọn bằng `chrome.storage.local`; tự ẩn khi dừng dubbing hoặc dùng transcript DOM.
- Toàn bộ caption dùng kết quả Whisper local hiện có, không gọi thêm API trả phí.

### File đã sửa
- `src/extension/content.ts`
- `STATUS.md`

### Kết quả kiểm tra
- `npm.cmd run check`: pass.
- `npm.cmd test`: 56/56 test pass, 11/11 file.
- `npx.cmd vite build`: pass; `dist` đã được tạo lại và chứa Live Caption trong `content.js`.
- `git diff --check`: pass.

### Vấn đề còn lại
- Caption hiện theo segment final của VAD/Whisper (thường sau khoảng lặng 350 ms), chưa phải token partial streaming từng từ.

## Live Caption chỉ hiển thị tiếng Việt — 2026-08-09

### Đã thay đổi
- Không còn đưa transcript nguyên ngữ từ Whisper lên floating caption.
- Caption chỉ cập nhật sau khi có `translatedText` tiếng Việt hợp lệ và dùng cùng nội dung với TTS.
- Trong lúc chưa có bản dịch, caption giữ trạng thái `Đang nghe…` thay vì hiển thị tiếng Anh/Trung.

### File đã sửa
- `src/extension/content.ts`
- `STATUS.md`

### Kết quả kiểm tra
- `npm.cmd run check`: pass.
- `npm.cmd test`: 56/56 test pass, 11/11 file.
- `npx.cmd vite build`: pass; `dist` đã được tạo lại.
- `git diff --check`: pass.

### Vấn đề còn lại
- Sherpa WASM streaming cần tự build bằng Emscripten; model bilingual Trung–Anh int8 gần 190 MB chưa tính runtime, nên chưa thay Whisper production khi chưa có benchmark tải/RAM/MV3.

## Hỗ trợ video HTML5 ngoài YouTube — 2026-08-09

### Đã thay đổi
- Content script chạy trên trang HTTP/HTTPS; popup cho phép bắt đầu khi tab web hợp lệ.
- Trang YouTube `/watch` vẫn ưu tiên transcript DOM như cũ.
- Các nền tảng khác có `<video>` đi thẳng vào tabCapture, Whisper local, dịch Việt, Live Caption Việt và TTS Việt.
- Tạo media ID ổn định từ URL trang và `currentSrc` để cache transcript/dịch cho video web.
- Background chỉ cho content từ tab HTTP/HTTPS gọi API, thay cho giới hạn riêng YouTube.

### File đã sửa
- `public/manifest.json`
- `src/extension/content.ts`
- `src/extension/popup.ts`
- `src/extension/background.ts`
- `STATUS.md`

### Kết quả kiểm tra
- `npm.cmd run check`: pass.
- `npm.cmd test`: 56/56 test pass, 11/11 file.
- `npx.cmd vite build`: pass; manifest build parse hợp lệ.
- `git diff --check`: pass.

### Vấn đề còn lại
- DRM, player không dùng HTML5 video, iframe khác miền và trang chặn capture có thể không hoạt động; đây là giới hạn nền tảng/trình duyệt.

## Fix Live Caption/video giật lag — 2026-08-09

### Đã thay đổi
- Tuần tự hóa toàn bộ inference Whisper trong Worker; không còn nhiều lệnh chạy đồng thời tranh WebGPU với video.
- Giới hạn hàng đợi còn hai câu mới nhất; đoạn tồn đọng quá cũ được bỏ và giải phóng khỏi pending để tránh tăng RAM/latency vô hạn.
- Bỏ cơ chế backpressure tự gọi `video.pause()`/`video.play()` gây hình ảnh giật; giờ chỉ cập nhật trạng thái trong popup.
- Live Caption vẫn cập nhật theo bản dịch tiếng Việt final.

### File đã sửa
- `src/extension/local-stt/whisper-worker.ts`
- `src/extension/content.ts`
- `STATUS.md`

### Kết quả kiểm tra
- `npm.cmd run check`: pass.
- `npm.cmd test`: 56/56 test pass, 11/11 file.
- `npx.cmd vite build`: pass; Worker Whisper mới đã được phát hành trong `dist`.
- `git diff --check`: pass.

### Vấn đề còn lại
- Nếu một inference WebGPU duy nhất vẫn tranh GPU với giải mã video trên máy yếu, cần thêm lựa chọn CPU q8 trong popup; CPU sẽ mượt hình hơn nhưng STT chậm hơn.
