# Báo cáo Nghiệm thu End-to-End G2 (G2-D & G2-E Validation)

Ngày: 14/10/2026  
Mục tiêu bắt buộc: Luồng hoàn chỉnh từ Chat Native IDE → Model Bridge → Gemini Web → Read File → Patch File → Run Test PASS/FAIL → Final Reply, giữ executor và approvals của IDE.

---

## 1. Trạng thái Nghiệm thu (Validation Status)

**TỔNG THỂ: NOT TESTED (BỊ CHẶN BỞI ĐIỀU KIỆN TIÊN QUYẾT G2-B VÀ G2-C)**

Tuân thủ chặt chẽ chỉ thị:
> *"Nếu chưa chạy được, ghi NOT TESTED cùng blocker, không làm artifact giả. Không giả lập thành công native, không tự đổi mục tiêu."*

| Bước trong quy trình E2E | Trạng thái | Nguyên nhân / Blocker |
|---|---|---|
| **1. Prompt từ Chat Native IDE** | **BLOCKED** | Không có extension point hoặc route mở trong Antigravity IDE v1.107.0 để định tuyến chat native sang bridge ngoài (Xem [G2-B](g2-native-browser-gates.md)) |
| **2. Bridge chuyển prompt sang Gemini Web** | **BLOCKED** | Profile Chrome thử nghiệm đang ở trạng thái `SIGN_IN_REQUIRED`; chưa có phiên đăng nhập của người dùng |
| **3. Gemini Web trả tool call read-only** | **NOT TESTED** | Chưa thể gửi prompt đến Gemini Web |
| **4. Executor IDE thực hiện `read_file`** | **NOT TESTED** | Executor gắn liền với Language Server nhị phân nội bộ của IDE |
| **5. Gemini Web yêu cầu sửa file (`patch_file`)** | **NOT TESTED** | Bị chặn bởi các bước trước |
| **6. Executor IDE chạy test PASS/FAIL** | **NOT TESTED** | Bị chặn bởi các bước trước |
| **7. Final reply hiển thị trong Chat Native** | **NOT TESTED** | Bị chặn bởi các bước trước |
| **8. Kiểm tra Cancel và Chống thực thi lặp** | **PASS (Scaffold & In-Process Tests)** | Đã kiểm chứng ở mức hợp đồng và runtime fake (`Behavior 10` và `Behavior 12` pass 100%) |

---

## 2. Chi tiết các Rào cản Kỹ thuật (Technical Blockers)

### Blocker 1: Đóng gói khép kín của Antigravity IDE (Gate G2-B)
- **Hiện trạng:** Ứng dụng `D:\Antigravity IDE\Antigravity IDE.exe` sử dụng kiến trúc ConnectRPC khép kín:
  - Chat Native UI gọi trực tiếp dịch vụ nhị phân `exa.language_server_pb.LanguageServerService` qua cổng HTTPS nội bộ kèm CSRF token.
  - Cài đặt `codeiumDev.externalLanguageServerAddress` gặp lỗi cú pháp minification nội tại trong file `extension.js`, không thể trỏ cổng HTTPS chính xác.
  - IDE không cung cấp API hoặc UI cấu hình để người dùng thêm Custom AI Provider.
- **Ràng buộc:** Các phương án như patch binary `language_server_windows_x64.exe`, can thiệp file mã nguồn đóng gói `extension.js`, hoặc chặn bắt giải mã TLS trên localhost đều bị nghiêm cấm theo nguyên tắc an toàn của dự án.

### Blocker 2: Yêu cầu Đăng nhập Tài khoản Người dùng (Gate G2-C)
- **Hiện trạng:** Profile trình duyệt độc lập `C:\Users\vhc\.gemini\gemini_web_probe_profile` chưa có phiên đăng nhập Google.
- **Ràng buộc:** Agent không được phép tự động lấy cookie từ profile cá nhân mặc định của người dùng, không được tự động xử lý MFA/CAPTCHA hoặc lưu mật khẩu. Cần sự can thiệp thủ công của người dùng đăng nhập 1 lần vào trình duyệt này để tiếp tục.

---

## 3. Các Phần đã Sẵn sàng cho G2 End-to-End
Mặc dù luồng live bị chặn bởi các điều kiện bên ngoài, toàn bộ nền tảng logic đã được chuẩn bị đầy đủ và sẵn sàng ghép nối ngay khi hai gate trên được giải quyết:
1. **Schema & Argument Validation:**
   - Đã định nghĩa chặt chẽ schemas cho `read_file`, `list_dir`, `patch_file`, `run_test` trong `@antigravity-gemini-web/model-bridge`.
2. **Authority Binding & Nonce Lifecycle:**
   - `EnvelopeParser.parseForExecution` bắt buộc kiểm tra `sessionId`, `turnId`, `requestNonce`, `allowedTools` và dedupe `callId` thông qua call ledger.
3. **Turn Immutability & Reentrancy Protection:**
   - Runtime engine đảm bảo không thể hủy lượt đã terminal (`outcome_unknown`, `completed`, `cancelled`).
   - In-flight promise reservation ngăn chặn hoàn toàn việc thực thi lặp hoặc reentrant duplication.
4. **Adapter Contract:**
   - `GeminiBrowserAdapter` đã có đầy đủ `submitPrompt`, `pollResponse`, `cancelPrompt`, `cleanup` với typing hoàn chỉnh.

---

## 4. Hành động Tiếp theo Cần Người dùng Quyết định
Để có thể tiến hành G2-D và G2-E trên môi trường thực tế, cần:
1. **Đối với Gemini Web:** Người dùng mở Chrome với profile `C:\Users\vhc\.gemini\gemini_web_probe_profile` và đăng nhập tài khoản Google cá nhân.
2. **Đối với Antigravity IDE:** Người dùng xem xét và xác nhận có cho phép áp dụng bản vá cấu hình (hoặc wrapper script shimming thông qua `codeiumDev.languageServerBinaryPath`) để IDE chuyển tiếp các request RPC sang Bridge cục bộ hay không.

