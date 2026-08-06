# Trạng thái PXHDubbingYooToob

> UI 2026-08-06: chuyển Start/Stop sang nút Play nổi 44 px ở giữa cạnh trái YouTube (Shadow DOM, trạng thái play/stop/loading/error); popup `PXH Dubbing YooToob` chỉ hiển thị trạng thái/thông tin, không còn nút hay settings. Dùng cấu hình cố định độ trễ Whisper 6 giây và âm gốc 18%. Thêm `activeTab` cho quyền capture sau khi người dùng gọi extension.
> Realtime 2026-08-06: khi nhấn Play, video đang chạy sẽ pause trong lúc chuẩn bị và tự play khi audio đầu tiên sẵn sàng. Transcript DOM được ưu tiên, dedupe theo timestamp+nội dung và panel vẫn nằm trong DOM nhưng bị thu về width/height 0. Whisper dùng hàng đợi latest-wins, bỏ chunk cũ khi backend chậm và reset chunk thu thử trước khi fallback để tránh lặp/ứ tải; spinner chỉ hiện đến audio đầu tiên.
> Verify realtime mới: `npm run check`, 8/8 test và `npm run build` đều đạt; production bundle có content/background/offscreen/page-bridge mới.
> Giảm cold-start Whisper: giữ chunk audio 5 giây gần nhất trong lúc dò caption và xử lý ngay khi fallback được xác nhận, thay vì bỏ chunk đầu rồi chờ thêm 5 giây.
> Dùng `public/PXH.jpg` làm logo popup và icon extension/action; asset được Vite sao chép nguyên vẹn vào production build.
> Chrome không render ổn định JPEG trong Manifest icon; xuất từ `PXH.jpg` thành PNG chuẩn 16/32/48/128 px trong `public/icons` và chuyển `icons/default_icon` sang bộ PNG.

> Upgrade Whisper 2026-08-06: thêm `tabCapture` + offscreen MediaRecorder tạo WebM/Opus 5 giây, `/api/transcribe` dùng `whisper-large-v3-turbo`, fallback tự động khi cả transcript trang và backend đều thất bại, hàng đợi nhận dạng → dịch → Hoài My TTS, dừng capture khi caption hoạt động hoặc người dùng dừng dubbing. Mở popup/chuyển focus không còn pause video. API key chỉ nằm backend. Smoke test Groq thật trả đúng text và timestamp; check, 8/8 test và production build đạt.
> Manifest yêu cầu Chrome 116+ vì stream ID tạo trong service worker chỉ được dùng ở offscreen document từ phiên bản này.

> Cập nhật 2026-08-06: Bổ sung fallback lấy transcript trong MAIN world qua YouTube `youtubei/v1/get_transcript`; nếu trang chưa có `params`, lấy qua `youtubei/v1/next`. Extension parse trực tiếp các `transcriptSegmentRenderer`, tránh trường hợp timedtext và fallback service worker trả mảng rỗng. Đã chạy `npm run check`, 8/8 test và production build thành công.
> Bổ sung parser cho cả định dạng `transcriptCueRenderer` của endpoint transcript, tăng timeout bridge lên 20 giây và giữ lại đồng thời lỗi bridge/backend để popup không còn che nguyên nhân thật. Verify lại check, 8/8 test và build thành công.
> Giữ riêng lỗi MAIN-world transcript và isolated-world timedtext để chẩn đoán chính xác; xác nhận lỗi lấy phụ đề này không phụ thuộc việc redeploy Vercel.
> Sửa HTTP 400 của `get_transcript`: luôn lấy transcript params mới từ `youtubei/v1/next` theo video ID hiện tại (tránh dữ liệu SPA cũ), gửi client/version/visitor headers của phiên YouTube và hiển thị response lỗi rút gọn nếu endpoint vẫn từ chối.
> Sửa `FAILED_PRECONDITION`: giữ `clickTrackingParams` đi cùng `getTranscriptEndpoint`, đưa vào `context.clickTracking` và thêm `x-goog-api-format-version: 2` giống request InnerTube của YouTube.
> Thay params phụ thuộc UI bằng protobuf transcript tự tạo từ video ID, language code và loại ASR của caption track; bỏ request `next` khỏi đường chính để giảm thời gian đứng ở “Đang tải phụ đề”.
> Do YouTube vẫn bắt buộc PO token và trả `FAILED_PRECONDITION`, thêm fallback dùng nút Transcript chính thức của trang và parse `ytd-transcript-segment-renderer`; YouTube tự gắn token hợp lệ cho request UI.
> Mở rộng nhận diện UI Transcript cho DOM YouTube mới và nhãn tiếng Việt/Anh; hỗ trợ `button`, `tp-yt-paper-button`, `yt-button-shape`, đồng thời báo rõ khi UI không tải được transcript.
> Hỗ trợ DOM YouTube cập nhật tháng 3/2026: parse cả `transcript-segment-view-model` và `.yt-core-attributed-string`, bên cạnh renderer cũ; tăng thời gian chờ panel lên 7 giây.
> Loại timestamp dạng `m:ss`/`h:mm:ss` ở đầu text của renderer mới trước khi dịch và TTS, tránh giọng đọc đọc luôn số giây trong Bản chép lời.
> Hỗ trợ thêm timestamp dùng dấu chấm hoặc dấu hai chấm Unicode (`0.51`, `0：51`) trong cả parser thời gian và bước loại timestamp khỏi nội dung.
> Lọc mọi token timestamp nằm ở bất kỳ vị trí nào trong transcript (không chỉ đầu câu), lọc lại lần hai trước dịch/TTS, và tự đóng/ẩn panel Bản chép lời ngay sau khi đã đọc dữ liệu DOM.
> Video `36CVX2eefuI` được YouTube xác nhận transcript bị tắt; chuẩn hóa lỗi fallback thành thông báo tiếng Việt nêu rõ cần Whisper. Đây không phải lỗi Vercel và không thể lấy bằng các API caption hiện tại.

Cập nhật: 2026-08-06

## TARGET hiện tại

Bước 1 — `Phụ đề YouTube → dịch tiếng Việt → Hoài My TTS → phát đồng bộ`.

## Đã hoàn thành

- Tạo project Vite + TypeScript strict và Chrome Extension Manifest V3.
- Tạo popup tiếng Việt với bật/tắt, trạng thái, nguồn phụ đề, số đoạn, độ trễ và âm lượng gốc.
- Nút bắt đầu cập nhật ngay ở lần nhấn đầu, bị khóa trong lúc khởi động và không còn bị phản hồi trạng thái cũ ghi đè.
- Phát hiện track phụ đề YouTube, ưu tiên phụ đề tiếng Việt hoặc phụ đề thủ công.
- Parse caption JSON3 thành các đoạn có timestamp.
- Parser phụ đề đọc an toàn và fallback XML khi YouTube trả JSON3 rỗng/không hợp lệ.
- Thêm content script `MAIN` làm cầu nối giới hạn với YouTube player API; không nhận URL tùy ý và không truy cập khóa backend.
- Thêm fallback `/api/subtitles/youtube` dùng Android player context khi WEB timedtext yêu cầu PO token; endpoint chỉ nhận `videoId` 11 ký tự và cửa sổ tối đa 120 giây.
- Chuẩn hóa phụ đề tự động bị chồng timestamp: ghép đủ mọi fragment thành cụm 6–10 giây, ưu tiên ranh giới dấu câu và tạo timestamp không chồng lấn trước khi dịch/TTS.
- Dịch theo batch qua backend Groq và giữ ánh xạ ID.
- Tạo MP3 theo từng câu qua provider Edge TTS, giọng mặc định `vi-VN-HoaiMyNeural`.
- TTS chạy tối đa 3 request đồng thời; scheduler bật trước và popup chuyển sang “Sẵn sàng” ngay khi audio đầu tiên vào bộ đệm, phần còn lại tiếp tục tạo nền.
- Bộ đệm liên tục ưu tiên batch 8 câu gần `video.currentTime`, chuẩn bị cửa sổ 45 giây, lấy transcript backend theo vùng 60 giây và nạp batch kế tiếp sau 250 ms; khi đủ bộ đệm mới chờ 4 giây kiểm tra lại.
- Scheduler không cắt câu Việt ngay khi timestamp câu sau tới; tốc độ được tính từ thời lượng MP3 thật và chỉ resync khi câu vượt khung quá 3 giây.
- Chính sách đồng bộ mượt: TTS tạo ở tốc độ tự nhiên (không tăng tốc kép), scheduler chỉ chỉnh nhẹ 0.95–1.15 ở tốc độ video 1x. Câu kế tiếp không bị đánh dấu bỏ qua khi câu trước còn nói và được phép bắt đầu muộn tối đa 5 giây; chỉ bỏ qua khi scheduler đang rảnh mà timestamp đã trôi quá xa.
- Khi tab YouTube bị ẩn, video được pause ngay và dubbing pause theo; service worker còn theo dõi focus cấp cửa sổ để pause mọi tab YouTube đang dubbing khi người dùng chuyển từ Chrome sang ứng dụng khác như VS Code. Khi quay lại không tự phát tiếp.
- Lập lịch theo `video.currentTime`; xử lý pause/resume, seek, playback rate và chuyển video.
- Âm lượng gốc được giữ ổn định ở mức đã chọn trong toàn bộ phiên dubbing, không tăng lại giữa các câu; chỉ khôi phục khi dừng phiên hoặc chuyển video.
- Backend có Zod validation, giới hạn payload, rate limit cơ bản, timeout, retry/backoff và lỗi JSON có cấu trúc.
- Có server `npm run dev:api` để kiểm thử local mà không cần đăng nhập Vercel.
- Server local ghi phương thức, endpoint, mã trạng thái và thời gian xử lý; không ghi payload hay API key.
- Không chứa API key hay chuỗi kết nối trong extension/repository.

## Xác minh

- `npm run check`: đạt.
- `npm test`: đạt, 8 test.
- `npm run build`: đạt; tạo `dist/manifest.json`, popup và content script.
- `.env.local` có `GROQ_API_KEY` và được xác minh bị Git bỏ qua.
- Smoke test dịch vụ thật: Groq kết nối thành công; Edge TTS `vi-VN-HoaiMyNeural` tạo MP3 thành công (14.688 byte).
- Smoke test server local: endpoint OPTIONS hoạt động và `/api/translate` trả đúng một đoạn dịch thật.
- Smoke test fallback phụ đề thật: `/api/subtitles/youtube` trả 13 đoạn trong 60 giây đầu của video công khai, HTTP 200.
- Chưa kiểm thử thao tác popup → phát audio trực tiếp trong Chrome vì chưa có phiên Chrome tương tác nạp extension.

## Chưa làm

- Bước 2: cache transcript/bản dịch bằng Neon và migration.
- Bước 3: cache audio bằng IndexedDB.
- Bước 4 mở rộng: bộ đệm liên tục 30–60 giây và hủy/tải lại chính xác sau seek.
- Bước 5 mở rộng: tối ưu overlap/chống trùng ở ranh giới audio chunk và đồng bộ Whisper chính xác hơn cho video tốc độ cao.
- Bước 6: khóa job dùng chung và chống xử lý trùng giữa nhiều người dùng.
- Fallback Web Speech khi Edge TTS lỗi.

## Giới hạn/rủi ro

- Parser phụ thuộc cấu trúc trang YouTube hiện tại.
- Cửa sổ Bước 1 tối đa 40 câu và chưa tự nạp tiếp.
- Rate limit in-memory không dùng chung giữa các Vercel instance.
- `msedge-tts` là client không chính thức; cần provider dự phòng trước production.
- `.env.example` đã được xác minh không chứa khóa; khóa Groq nằm trong `.env.local` đã bị Git bỏ qua.
- Kiểm tra playback rate: đồng bộ hiện tại theo kịp khoảng 0.5x–1.25x; từ 1.5x trở lên audio bị giới hạn 1.3x nên có thể trễ và phải resync/bỏ cụm. Ở 0.5x–0.75x giọng bị giới hạn tối thiểu 0.85x nên sẽ có khoảng nghỉ giữa các cụm.
- Backend có thể deploy thành Vercel Functions và extension có thể build trỏ thẳng tới production URL, nhưng chưa production-ready cho phát hành công khai: rate limit còn in-memory, chưa có quota/xác thực người dùng và CORS/extension origin không ngăn client giả mạo gọi API trực tiếp.
- Production API calls được chuyển từ content script sang extension service worker theo hướng dẫn Chrome, với allowlist ba endpoint và hủy request; `.env.production` cố định public Vercel URL và Manifest chỉ cấp quyền cho đúng domain production.
- Kiểm tra production với extension ID phát triển: CORS đạt, translate/TTS trả 200; transcript trên Vercel trả 502 do phía YouTube/datacenter. Fallback transcript vì vậy chạy trong service worker bằng IP người xem, vẫn chỉ nhận `videoId` hợp lệ; Vercel giữ dịch và TTS.
- Service worker tự phát hiện transcript timestamp theo giây hay milliseconds bằng median duration, chuẩn hóa trước khi lọc cửa sổ và thử đơn vị còn lại nếu vùng kết quả rỗng.
> Xác minh UI/đồng bộ mới nhất: rút ngắn timeout bridge 20 → 12 giây, thời gian chờ player response 5 → 2 giây và chờ transcript UI 7 → 3,5 giây; `npm run check`, 8/8 test và production build đều đạt.
