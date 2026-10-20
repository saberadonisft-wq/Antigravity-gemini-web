# ADR 0002: Đánh giá Giao thức Native Antigravity IDE và Cơ chế Điều khiển Gemini Web (G2)

- **Trạng thái:** Proposed / Blocked by External Gates
- **Ngày:** 14/10/2026
- **Phạm vi:** Khảo sát Native Protocol, Browser Automation Host, và Tool Transport (G2-B, G2-C, G2-D)

---

## 1. Bối cảnh (Context)
Giai đoạn G2 hướng đến mục tiêu tích hợp thực tế:
1. Xác định giao thức định tuyến suy luận từ chat native của Antigravity IDE sang Bridge cục bộ.
2. Điều khiển phiên hội thoại trên Gemini Web thông qua trình duyệt Chrome tự động hóa.
3. Chuyển đổi phản hồi của Gemini Web thành lệnh gọi công cụ (tool call envelope) và thực thi qua executor của IDE.

---

## 2. Quyết định Kỹ thuật (Technical Decisions)

### 2.1. Nhận diện Giao thức Native của Antigravity IDE
- **Khảo sát:** Antigravity IDE v1.107.0 (CL 933924006) sử dụng backend nhị phân `language_server_windows_x64.exe` giao tiếp qua ConnectRPC trên nền HTTP/2 + TLS nội bộ (`https://127.0.0.1:<random-port>`).
- **Dịch vụ RPC:** Toàn bộ tương tác chat native và quản lý phiên nằm trong dịch vụ protobuf `exa.language_server_pb.LanguageServerService`.
- **Đánh giá Khả thi:**
  - Không tồn tại cấu hình native công khai nào trong giao diện IDE cho phép trỏ sang endpoint bên ngoài hoặc thêm custom model provider vào picker.
  - Cài đặt nội bộ `codeiumDev.externalLanguageServerAddress` gặp lỗi phân tích cổng minification (`parseInt(e.slice(0, -1)[1], 10)`), không thể kích hoạt nếu không sửa trực tiếp file đóng gói của IDE.
- **Quyết định:** Ghi nhận Gate G2-B là `UNSUPPORTED` trên phiên bản IDE hiện hành nếu không được người dùng phê duyệt giải pháp shim wrapper nhị phân. Không tự ý patch binary hay can thiệp TLS trái phép.

### 2.2. Cơ chế Điều khiển Trình duyệt (Browser Host Transport)
- **Phương thức:** Sử dụng Selenium WebDriver kết nối Chrome với thư mục profile tách biệt hoàn toàn (`C:\Users\vhc\.gemini\gemini_web_probe_profile`).
- **Quy tắc Bảo mật:**
  - Tuyệt đối không sao chép cookie hoặc session từ profile trình duyệt cá nhân đang dùng.
  - Trạng thái chưa đăng nhập được ghi nhận trung thực là `SIGN_IN_REQUIRED`.
  - Không tự động hóa vượt qua xác thực 2 bước (MFA) hoặc CAPTCHA của Google.
- **Quyết định:** Giao diện điều khiển trình duyệt (`GeminiBrowserAdapter`) được thiết kế theo hợp đồng bất đồng bộ chặt chẽ: `submitPrompt` trả về receipt, `pollResponse` đọc stream/hoàn thành, `cancelPrompt` xử lý hủy lượt, và `cleanup` đảm bảo đóng tiến trình sạch sẽ.

### 2.3. Vận chuyển Công cụ và Thẩm quyền Thực thi (Tool Transport & Authority Binding)
- **Phương án lựa chọn:** Envelope có cấu trúc dạng fenced block:
  ````markdown
  ```antigravity-tool
  {
    "schemaVersion": "0.1",
    "callId": "...",
    "sessionId": "...",
    "turnId": "...",
    "requestNonce": "...",
    "tool": "read_file" | "list_dir" | "patch_file" | "run_test",
    "args": { ... }
  }
  ```
  ````
- **Ràng buộc:**
  - Phân tách rõ ràng giữa kiểm tra cú pháp (`inspectSyntax`) và ủy quyền thực thi (`parseForExecution`).
  - Đường dẫn thực thi bắt buộc phải có đầy đủ `sessionId`, `turnId`, `requestNonce`.
  - Host executor kiểm tra danh mục công cụ cho phép (`allowedTools`) của từng lượt trước khi cấp quyền.
  - Call ledger (`executedCallIds`) ngăn chặn thực thi lặp lại các lệnh gọi công cụ trùng ID.

---

## 3. Hệ quả (Consequences)
- **Ưu điểm:** Kiến trúc phân định ranh giới rõ ràng, bảo vệ tuyệt đối an toàn dữ liệu và quyền kiểm soát của người dùng.
- **Thách thức:** Cần người dùng hỗ trợ thực hiện 2 thao tác trước khi luồng end-to-end có thể chạy trực tiếp:
  1. Đăng nhập tài khoản Google vào profile Chrome thử nghiệm.
  2. Phê duyệt cơ chế shim wrapper nhị phân hoặc phương án tích hợp cho Antigravity IDE.

