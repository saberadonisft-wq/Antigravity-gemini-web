# Bản beta cho Windows x64

Tải ZIP, giải nén toàn bộ rồi mở **Antigravity Gemini Web.exe**. Node.js đã đi kèm.

- Ba màn hình: Tài khoản, Đoạn chat, Kết nối; giao diện sáng tiếng Việt/Anh.
- Nhiều tài khoản qua extension trong từng hồ sơ Chrome có sẵn.
- Menu **Tệp**: mở extension, mở dự án trong IDE, khởi động/dừng kết nối.
- Giữ trạng thái hội thoại và dấu chống gửi trùng khi mất kết nối.

**Yêu cầu:** Windows 10/11 x64, Chrome, Antigravity IDE **2.5.5** cài ở vị trí mặc định. Bạn tự đăng nhập và xác minh Google khi cần.

**Giới hạn:** beta chưa ký số; chưa chứng nhận tương thích các bản IDE khác. CI kiểm tra build, typecheck, unit/integration test, Electron và ZIP đã giải nén bằng fixture; không thay cho nghiệm thu chat/tool loop trên Gemini thật.

`SHA256SUMS.txt` chứa SHA-256 của ZIP. Extension nằm trong `resources/app/extensions/chrome-profile-connector`; có thể mở bằng menu **Tệp → Mở thư mục extension**.

Xem README và hướng dẫn ghép tài khoản trong gói tải về. Khi nâng cấp, đợi hết tác vụ rồi chọn **Tệp → Dừng kết nối** ở bản cũ trước khi mở bản mới. Dữ liệu tài khoản nằm riêng trong thư mục người dùng.
