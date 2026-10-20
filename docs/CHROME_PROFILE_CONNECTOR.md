# Ghép tài khoản Chrome

Mỗi tài khoản bridge dùng một hồ sơ Chrome có sẵn. Không có Chrome riêng tự mở hoặc Default Account tự tạo.

## 1. Cài extension

Thực hiện trong **từng hồ sơ Chrome** muốn dùng:

1. Mở `chrome://extensions`.
2. Bật **Chế độ dành cho nhà phát triển / Developer mode** ở góc trên bên phải.
3. Bấm **Tải tiện ích đã giải nén / Load unpacked**.
4. Chọn thư mục extension: trong bản tải về, dùng **Tệp → Mở thư mục extension** rồi chọn đúng thư mục đó ở hộp thoại Chrome (`resources/app/extensions/chrome-profile-connector`). Nếu chạy mã nguồn, chọn `extensions/chrome-profile-connector` trong thư mục dự án.
5. Mở Gemini và đăng nhập tài khoản muốn dùng trong hồ sơ đó.

## 2. Ghép với launcher

1. Trong **Tài khoản**, nhập tên dễ nhận biết và bấm **Thêm tài khoản**.
2. Bấm **Khởi động connector**, rồi **Sao chép mã ghép nối**.
3. Trong Chrome đúng hồ sơ, mở extension **Gemini Profile Connector**.
4. Dán mã, bấm **Lưu mã ghép nối**, rồi **Kết nối**. Mỗi hồ sơ dùng mã riêng.
5. Trở lại launcher, bấm **Kiểm tra danh tính**, rồi **Chọn cho lượt sau**.
6. Trong IDE chọn **Gemini Web (Local)** và gửi yêu cầu.

Badge **ON** chỉ xác nhận connector đã nối; vẫn cần kiểm tra danh tính trong launcher. Mã ghép nối là thông tin riêng, chỉ dán vào extension của đúng hồ sơ.

## Đổi hoặc xóa tài khoản

- **Thủ công:** lượt IDE mới dùng tài khoản đang chọn.
- **Ghim theo chat:** hội thoại tiếp tục dùng tài khoản đã ghim. Bỏ ghim tại **Đoạn chat** nếu cần đổi.
- **Xóa tài khoản:** xóa dữ liệu do bridge quản lý; xác nhận xóa trạng thái tiếp tục nếu có. Có thể xóa tài khoản đang chọn hoặc cuối cùng. Google account, lịch sử Gemini và hồ sơ Chrome cá nhân được giữ nguyên.

Sau khi đóng Chrome hoặc restart worker, mở đúng hồ sơ và bấm **Kết nối** lại trong extension. [Xem cách xử lý lỗi](NATIVE_RECOVERY_RUNBOOK.md).
