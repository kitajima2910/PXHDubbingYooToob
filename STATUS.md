# Trạng thái PXHDubbingYooToob

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
- Dịch theo batch qua backend Groq và giữ ánh xạ ID.
- Tạo MP3 theo từng câu qua provider Edge TTS, giọng mặc định `vi-VN-HoaiMyNeural`.
- TTS chạy tối đa 3 request đồng thời; scheduler bật trước và popup chuyển sang “Sẵn sàng” ngay khi audio đầu tiên vào bộ đệm, phần còn lại tiếp tục tạo nền.
- Bộ đệm liên tục ưu tiên batch 8 câu gần `video.currentTime`, chuẩn bị cửa sổ 45 giây, lấy transcript backend theo vùng 60 giây và nạp batch kế tiếp sau 250 ms; khi đủ bộ đệm mới chờ 4 giây kiểm tra lại.
- Scheduler không cắt câu Việt ngay khi timestamp câu sau tới; tốc độ được tính từ thời lượng MP3 thật và chỉ resync khi câu vượt khung quá 3 giây.
- Chính sách đồng bộ mượt: TTS tạo ở tốc độ tự nhiên (không tăng tốc kép), scheduler chỉ chỉnh nhẹ 0.95–1.15 ở tốc độ video 1x, bỏ qua câu đến trễ quá 800 ms thay vì đọc đuổi và resync khi vượt khung quá 3 giây.
- Khi tab YouTube bị ẩn, video được pause ngay và dubbing pause theo; khi quay lại không tự phát tiếp để tránh âm thanh chạy nền hoặc sai đồng bộ.
- Lập lịch theo `video.currentTime`; xử lý pause/resume, seek, playback rate và chuyển video.
- Giảm âm lượng video gốc trong khi audio Việt phát và khôi phục khi dừng.
- Backend có Zod validation, giới hạn payload, rate limit cơ bản, timeout, retry/backoff và lỗi JSON có cấu trúc.
- Có server `npm run dev:api` để kiểm thử local mà không cần đăng nhập Vercel.
- Server local ghi phương thức, endpoint, mã trạng thái và thời gian xử lý; không ghi payload hay API key.
- Không chứa API key hay chuỗi kết nối trong extension/repository.

## Xác minh

- `npm run check`: đạt.
- `npm test`: đạt, 7 test.
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
- Bước 5: tabCapture, Groq Whisper và fallback video không có phụ đề.
- Bước 6: khóa job dùng chung và chống xử lý trùng giữa nhiều người dùng.
- Fallback Web Speech khi Edge TTS lỗi.

## Giới hạn/rủi ro

- Parser phụ thuộc cấu trúc trang YouTube hiện tại.
- Cửa sổ Bước 1 tối đa 40 câu và chưa tự nạp tiếp.
- Rate limit in-memory không dùng chung giữa các Vercel instance.
- `msedge-tts` là client không chính thức; cần provider dự phòng trước production.
- `.env.example` đã được xác minh không chứa khóa; khóa Groq nằm trong `.env.local` đã bị Git bỏ qua.
