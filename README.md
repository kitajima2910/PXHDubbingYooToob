# PXHDubbingYooToob

Chrome Extension Manifest V3 lồng tiếng Việt thông minh cho video YouTube với độ trễ thấp.

## Trạng thái

Bản hiện tại ưu tiên transcript DOM → cache Neon → kho dịch global → Groq dịch cache miss → Chrome TTS theo timestamp. Transcript vẫn lưu theo video; bản dịch dùng chung giữa mọi video theo ngôn ngữ, hash câu và phiên bản dịch. Video không có transcript dùng Groq Whisper theo chunk 5 giây. Xem [STATUS.md](./STATUS.md).

## Kiến trúc

- `src/extension`: popup, tích hợp YouTube, API client và bộ lập lịch audio.
- `src/api`: handler Vercel, kiểm tra đầu vào, rate limit, retry và provider Groq/Edge TTS.
- `src/shared`: kiểu và tiện ích dùng chung.
- `api`: entrypoint cho Vercel.
- `migrations`: schema SQL cho cache transcript/bản dịch trên Neon.
- `tests`: kiểm thử đơn vị.

API key chỉ tồn tại trong biến môi trường backend. Extension không kết nối Groq hoặc cơ sở dữ liệu trực tiếp và không lưu MP3 trên server.

## Chạy local

Yêu cầu Node.js 20 trở lên.

1. Chạy `npm install`.
2. Sao chép `.env.example` thành `.env.local`, điền `GROQ_API_KEY`, `DATABASE_URL` cho transcript và `DUBBING_DATABASE_URL` cho kho dịch global; giữ file này ngoài Git.
3. Chạy `npm run dev:api` để chạy API local tại `http://localhost:3000`; lệnh này không yêu cầu đăng nhập Vercel.
4. Ở terminal khác, chạy `npm run dev` khi phát triển hoặc `npm run build` để tạo extension trong `dist`.
5. Mở `chrome://extensions`, bật **Chế độ dành cho nhà phát triển**, chọn **Tải tiện ích đã giải nén** và chọn thư mục `dist`.
6. Mở hoặc tải lại trang xem YouTube, sau đó bấm biểu tượng **PXHDubbingYooToob** và chọn **Bắt đầu lồng tiếng**.

## Triển khai Vercel

1. Import repository vào Vercel.
2. Thêm `GROQ_API_KEY`, `GROQ_TRANSLATION_MODEL`, `DATABASE_URL`, `DUBBING_DATABASE_URL`, `TRANSLATION_CACHE_VERSION` và `EXTENSION_ORIGIN` trong Project Settings → Environment Variables.
3. Deploy, rồi build extension với `VITE_API_BASE_URL=https://ten-du-an.vercel.app`.
4. Để cấp quyền tối thiểu khi phát hành, thay mẫu `https://*.vercel.app/*` trong `public/manifest.json` bằng đúng tên miền backend rồi build lại.
5. Sau khi Chrome cấp ID extension, đặt `EXTENSION_ORIGIN=chrome-extension://ID_EXTENSION` và deploy lại backend.

Endpoint cache tự tạo bảng bằng schema tương đương `migrations/001_neon_cache.sql` và `migrations/002_global_translation_memory.sql`. Dùng `npm run migrate:global-translations` để chuyển bản dịch từ cache theo video cũ sang project global mà không xóa dữ liệu nguồn.

## Kiểm tra

- `npm run check`: kiểm tra TypeScript strict cho extension và backend.
- `npm test`: kiểm thử retry, chia batch và ánh xạ bản dịch.
- `npm run build`: tạo gói extension và kiểm tra kiểu backend.
- `npm run dev:api`: chạy các endpoint backend local từ `.env.local`, không cần Vercel CLI.

Kiểm thử thủ công Bước 1 cần `GROQ_API_KEY`, backend đang chạy và một video YouTube có phụ đề. Khi API hoặc TTS lỗi, video gốc tiếp tục phát; extension hiện lỗi hoặc bỏ qua riêng câu TTS lỗi.

Nếu WEB timedtext của YouTube trả rỗng do yêu cầu PO token, extension tự gọi `/api/subtitles/youtube` bằng `videoId` và cửa sổ thời gian đang phát. Backend không nhận URL tùy ý.

## Giới hạn hiện tại

- Đọc phụ đề dựa trên `ytInitialPlayerResponse`; thay đổi nội bộ của YouTube có thể cần cập nhật parser.
- Bước 1 chỉ chuẩn bị cửa sổ đầu tiên tối đa 40 câu, chưa tự bổ sung liên tục cho video dài.
- Cache Neon là tùy chọn và tự bỏ qua khi chưa có `DATABASE_URL`; cache audio IndexedDB chưa được triển khai.
- Rate limit hiện lưu trong bộ nhớ từng Vercel instance; cần kho chia sẻ ở bước backend hoàn chỉnh.
- Edge TTS là dịch vụ không chính thức, nên có thể thay đổi hoặc gián đoạn.
