# Thiết lập native Gemini Web

Hướng dẫn này dùng native revision 45 và browser worker 27. Cần Node.js 22.13+ (22.x) hoặc 24+, Chrome và Antigravity IDE trên Windows.

1. Chạy `npm install` và `npm run build` tại thư mục dự án.
2. Chạy `npm run native:launch` để mở IDE dùng native proxy; chạy `npm run launcher` để quản lý tài khoản.
3. Tại **Tài khoản**, thêm hồ sơ, khởi động connector và sao chép mã. Cài extension vào Chrome của tài khoản đó rồi ghép theo [hướng dẫn connector](../../CHROME_PROFILE_CONNECTOR.md).
4. Kiểm tra danh tính, chọn tài khoản. Trong IDE chọn **Gemini Web (Local)** và gửi yêu cầu mới.
5. Theo dõi trạng thái tại **Đoạn chat** và **Kết nối**.

Không có Chrome riêng tự mở hoặc Default Account tự tạo. Tài khoản CDP legacy vẫn được giữ trong registry để xóa/phục hồi thủ công; thêm tài khoản extension mới để dùng tiếp. Không tự đổi transport của hồ sơ cũ.

Hai MCP entry độc lập do dự án từng đăng ký đã được vô hiệu hóa; native owner tự quản browser worker nội bộ. Không cần đăng ký gateway hoặc custom MCP app Google.

Nếu source và runtime khác revision, chờ lượt xử lý kết thúc rồi chạy `npm run native:stop` và `npm run native:launch`. Không khởi động lại giữa một lượt gửi đang chưa rõ kết quả.

**Nối chat:** chọn đúng tài khoản ở Tài khoản; vào Đoạn chat, chọn/dán URL Web, đánh dấu nối và gửi một yêu cầu mới trong đúng chat IDE. Trạng thái đã lưu không bảo đảm Web vẫn giữ tab hoặc session; lỗi và dấu chống gửi trùng vẫn được tôn trọng.

Cấu hình context 3.8 ban đầu, model chính, receipt và quyền tool của IDE vẫn thuộc proxy hiện hành. Xem [runbook phục hồi](../../NATIVE_RECOVERY_RUNBOOK.md). Màn hình nguồn dự án/ZIP và các cờ thử nghiệm tương ứng đã rời bản sản phẩm.
