# Báo cáo Đánh giá Khả thi Native và Browser Gates (G2-B & G2-C)

Ngày kiểm tra: 14/10/2026  
Môi trường hệ thống: Windows 11 x64, Node v24.18.0, Python 3.13.6, Google Chrome 124+

---

## 1. Tổng kết Trạng thái Các Tiêu chí (Gate Criteria Summary)

| Mã | Tiêu chí đánh giá | Trạng thái | Căn cứ thực nghiệm |
|---|---|---|---|
| **G2-B.1** | Xác định đúng Antigravity surface trên máy | **PASS** | `D:\Antigravity IDE\Antigravity IDE.exe` (v1.107.0, CL 933924006) |
| **G2-B.2** | Tìm cơ chế cấu hình model/provider native | **UNRESOLVED** | Chưa tìm được provider UI/config hỗ trợ mục tiêu trên surface đã khảo sát; outbound flags tĩnh có nhưng semantics chưa kiểm chứng |
| **G2-B.3a** | Probe điều hướng Language Server qua `externalLanguageServerAddress` | **FAILED** | Cài đặt `codeiumDev.externalLanguageServerAddress` có lỗi minification upstream (`parseInt(e.slice(0,-1)[1], 10)`); không thể đổi route mà không patch extension bundle |
| **G2-B.3b** | Prototype Transparent Shim qua `machineLanguageServerBinaryPath` | **PASS (Launch Hook Only)** | Đã kiểm chứng thực nghiệm trên Antigravity IDE v1.107.0 (profile cô lập): IDE (PID 10168) → `antigravity_shim.exe` (PID 4716) → `language_server_windows_x64.exe` (PID 19824). Khởi tạo cổng thành công, Job Object dọn dẹp sạch tiến trình khi IDE tắt, log redaction hoạt động. Xem [g2-shim-feasibility.md](g2-shim-feasibility.md) |
| **G2-B.4** | Khảo sát Outbound Inference / Provider Hook trên Language Server | **UNRESOLVED / NOT_TESTED** | Cả 4 scenario probe standalone đều gặp blocker startup/readiness (`TIMEOUT_OR_NO_PORT`, không mở port HTTP/HTTPS/extension, `rpc_attempted=false`). Chưa kiểm chứng được inference thực tế. Xem [g2-inference-provider-probes.md](g2-inference-provider-probes.md) |
| **G2-B.5** | Trả response fixture vào chat native IDE | **UNRESOLVED / NOT_TESTED** | Chưa thể thực hiện do inference hook và baseline readiness chưa được kiểm chứng |
| **G2-B.6** | Round-trip gọi tool read-only qua IDE executor | **UNRESOLVED / NOT_TESTED** | Chưa thể thực hiện do inference hook chưa sẵn sàng |
| **G2-C.1** | Profile browser riêng biệt không lấy cookie | **PASS** | Sử dụng thư mục độc lập `C:\Users\vhc\.gemini\gemini_web_probe_profile` |
| **G2-C.2** | Khởi chạy browser và truy cập Gemini Web | **PASS** | Mở thành công `https://gemini.google.com/app`, nhận diện title `"Google Gemini"` |
| **G2-C.3** | Xác minh trạng thái tài khoản trên profile riêng | **NEEDS_USER_ACTION** | Trạng thái ghi nhận từ probe trước: `SIGN_IN_REQUIRED`. Cần người dùng đăng nhập tài khoản Google 1 lần |
| **G2-C.4** | Kiểm chứng 3 lượt chat + 1 cancel thực tế | **PASS (Fixture) / NOT_TESTED (Live)** | Đã kiểm chứng 3 lượt chat (Text, Markdown, Code) và Cancel trên DOM fixture (`browser-driver.test.ts`, PASS). Live Gemini Web chờ đăng nhập tài khoản. Xem [g2-browser-live-validation.md](g2-browser-live-validation.md) |
| **G2-C.5** | Xác minh tính năng Custom Apps / MCP trên web | **NOT_TESTED** | Yêu cầu tài khoản cá nhân đã đăng nhập để kiểm tra menu cài đặt |
| **G2-C.6** | Hoàn thiện Adapter Contract & CDP Driver thực tế | **PASS** | Đã hoàn thiện zero-dependency CDP client, selector positive evidence, checkStatus không tác dụng phụ, dọn dẹp taskkill, khắc phục triệt để V2–V6 trong `@antigravity-gemini-web/gemini-browser`. Xem [g2-browser-live-validation.md](g2-browser-live-validation.md) |

---

## 2. Khảo sát Kỹ thuật G2-B (Native Antigravity IDE)

### 2.1. Nhận diện Surface và Kiến trúc Thực tế
- **Đường dẫn cài đặt:** `D:\Antigravity IDE\Antigravity IDE.exe`
- **Nền tảng:** Fork chuyên biệt của VS Code (phiên bản lõi `1.107.0`, Electron 30, build date `2026-06-17T22:39:43.962Z`, Commit `e0b7a2bcf575cfba10528c4e7c10bd3ce2d7769a`).
- **Thành phần AI Extension:** `D:\Antigravity IDE\resources\app\extensions\antigravity` (ID: `google.antigravity`, version `0.2.0`).
- **Giao diện Chat Native:** Nằm trực tiếp trong Workbench core (`resources/app/out/vs/workbench/workbench.desktop.main.js` và `resources/app/out/jetskiAgent/main.js`).

### 2.2. Kiến trúc Giao thức Nội bộ
Qua dịch ngược và phân tích protobuf descriptor tại vị trí `12668655` trong `workbench.desktop.main.js`:
- Toàn bộ backend AI được đóng gói trong file nhị phân `bin/language_server_windows_x64.exe` (124 MB).
- Giao thức giao tiếp: **Google ConnectRPC qua HTTP/2 + TLS** (sử dụng self-signed certificate, port ngẫu nhiên và CSRF token).
- Tên dịch vụ chính thức: `exa.language_server_pb.LanguageServerService`.
- Danh mục phương thức RPC cốt lõi:
  - `GetServerConfiguration`: cấu hình runtime và dev mode.
  - `GetAvailableModels`: lấy danh sách models từ Google Cloud Code (`FetchAvailableModelsResponse`).
  - `GetLoadCodeAssist`: xác thực hạn ngạch Cloud Code Assist.
  - `RetrieveUserQuotaSummary`: kiểm tra quota người dùng.
  - `GetCascadeTrajectory` / `GetCascadeTrajectorySteps`: truy vấn các bước thực thi của task.
  - `RunCommand` / `CreateTerminal`: executor chạy shell và lệnh IDE.

### 2.3. Khảo sát Khả năng Định tuyến Lại (Rerouting Feasibility)
1. **Model Picker UI:**
   - Trong IDE không tồn tại trường nhập API Key của bên thứ ba, Custom Base URL hay OpenAI/Anthropic/Gemini Web provider.
   - Danh sách model được hardcode tải từ server Google nội bộ.
2. **Cấu hình `codeiumDev.externalLanguageServerAddress`:**
   - Trong file `extensions/antigravity/dist/extension.js` (pos 1620000):
     ```javascript
     L = function(e, t) {
       if (e && null !== t) {
         const n = parseInt(e.slice(0, -1)[1], 10);
         return { address: e, csrfToken: "", httpsPort: n, httpPort: 0, lspPort: t, ... };
       }
     }(e.externalAddress, e.externalLspPort);
     ```
   - Đoạn mã trên có lỗi phân tích cú pháp minification: nếu truyền `externalAddress = "127.0.0.1:5555"`, biểu thức `e.slice(0, -1)[1]` sẽ trả về ký tự `'2'` (vị trí thứ 1 của chuỗi `"127.0.0.1:555"`), dẫn đến `httpsPort = 2`.
   - Kết quả: Không thể kết nối Language Server ngoài thông qua thiết lập `externalLanguageServerAddress` mà không sửa trực tiếp file `extension.js`.
3. **Cấu hình `codeiumDev.languageServerBinaryPath`:**
   - Cho phép chỉ định một binary thay thế `language_server_windows_x64.exe`.
   - Tuy nhiên, binary thay thế này bắt buộc phải triển khai toàn bộ dịch vụ nhị phân `exa.language_server_pb.LanguageServerService` (hơn 60 RPC methods với schema protobuf nội bộ). Việc xây dựng một bridge ConnectRPC giả lập toàn bộ LanguageServer nằm ngoài phạm vi an toàn và vi phạm nguyên tắc giữ executor của IDE gốc.

**Kết luận G2-B:** Gate Native **UNRESOLVED / NOT_TESTED**. Standalone baseline chưa ready; chưa có prompt/response/tool acceptance. Không suy ra unsupported toàn bộ từ startup timeout hoặc một helper lỗi.

---

## 3. Khảo sát Kỹ thuật G2-C (Gemini Web)

### 3.1. Kết quả Chạy Probe Thực tế
Đã chạy probe thực nghiệm `tools/probes/g0/test_gemini_web.py` với cấu hình:
- Trình duyệt: Google Chrome x64
- Thư mục dữ liệu người dùng: `C:\Users\vhc\.gemini\gemini_web_probe_profile`
- Kết quả thu được từ Selenium driver:
```json
{
  "test": "test_gemini_web",
  "status": "PASSED",
  "browser_launched": true,
  "navigated_to_gemini": true,
  "page_title": "Google Gemini",
  "current_url": "https://gemini.google.com/app",
  "auth_state": "SIGN_IN_REQUIRED",
  "mcp_custom_apps_capability": "NOT_TESTED (Requires signed-in personal Google account)",
  "screenshot_saved": true,
  "cleanup_successful": true
}
```

### 3.2. Đánh giá Trạng thái Xác thực & Yêu cầu Thao tác
- Browser đã mở thành công trang `https://gemini.google.com/app`.
- Profile probe là profile hoàn toàn mới, chưa lưu phiên đăng nhập Google.
- Do tuân thủ tuyệt đối nguyên tắc:
  - *Không tự ý sao chép cookie từ profile Chrome cá nhân đang dùng*.
  - *Không tự động vượt qua CAPTCHA/MFA/Google Login challenge*.
- Hệ thống ghi nhận trạng thái: **`SIGN_IN_REQUIRED` (needs_user_action)**.
- Khi người dùng đăng nhập tài khoản cá nhân vào profile này, các lượt kiểm tra gửi prompt 3 lượt và cancel mới có thể thực thi.

### 3.3. Hoàn thiện Adapter Contract
Package `@antigravity-gemini-web/gemini-browser` đã được nâng cấp:
- Bổ sung các interface giao kết:
  - `PromptSubmissionReceipt`: `{ turnId, submittedAt, status: "accepted" | "rejected", deadlineMs }`
  - `PromptTurnResponse`: `{ turnId, status: "completed" | "cancelled" | "failed", text, modelDetected, completedAt, error }`
  - `TurnCancelResult`: `{ turnId, cancelled, reason }`
- Phương thức `submitPrompt`, `pollResponse`, `cancelPrompt`, `cleanup` đã được cài đặt và kiểm thử, bảo đảm không nuốt lỗi, không giả lập thành công khi chưa đăng nhập.

---

## 4. Tổng kết Blockers và Sự Thật Chẩn Đoán (Diagnostic Truth)

1. **Native Inference Route Gate (G2-B): UNRESOLVED / NOT_TESTED**
   - **Blocker quan sát được hiện tại:** Standalone Language Server chưa ready. Cả 4 probe đều `TIMEOUT_OR_NO_PORT` (ports null, `rpc_attempted=false`, không outbound). Thiếu handshake/init contract là giả thuyết; chưa có controlled comparison xác nhận nguyên nhân.
   - **Phát hiện cấu hình tĩnh:** Khảo sát `--help` và descriptor xác nhận các cờ cấu hình `model_api_client_type` (`ccpa` hoặc `gemini`), `generative_service_addr` (Blade address mặc định), `cloud_code_endpoint`, và `inference_api_server_url`. Đây là cấu hình tĩnh, chưa phải bằng chứng thực nghiệm rằng custom compatibility bridge không thể hoạt động.
   - **Không kết luận vượt quá bằng chứng:** Không kết luận TLS interception / MITM giữa IDE và Language Server là phương án duy nhất bắt buộc chỉ từ các timeout startup này. Chi tiết xem [g2-inference-provider-probes.md](g2-inference-provider-probes.md).

2. **Browser Driver & Gemini Web Gate (G2-C): PASS trên Fixture / NEEDS_USER_ACTION trên Live**
   - **Khắc phục triệt để V2–V6 ([`packages/gemini-browser`](file:///d:/Antigravity-gemini-web/packages/gemini-browser)):**
     - V2: Lưu vết ownership (`isOwnedProcess` vs `isAttachedTarget`). Khi driver chỉ attach vào browser/target bên ngoài, `close()` chỉ ngắt kết nối CDP, tuyệt đối không gửi `Browser.close` và không gọi taskkill.
     - V3: Xác minh nguồn gốc bề mặt (origin allowlist). Live chỉ chấp nhận `https://gemini.google.com`. Bề mặt không hợp lệ (như `https://example.invalid/support`) bị từ chối `ready`, không nhận diện `signed_in`, không tự điền model `"Gemini 1.5 Pro"`.
     - V4: Khi timeout xảy ra nhưng có partial text, status trả về là `"failed"` kèm mã lỗi `TIMEOUT`, tuyệt đối không đánh tráo thành `"completed"`.
     - V5: Phân định `cancel_requested` và `cancel_confirmed`. Stop button thất bại hoặc ném lỗi được báo chính xác `cancelled: false`. Từ chối hủy lượt đã terminal; kết quả terminal là bất biến.
     - V6: Đặt chỗ lượt (`reserved`) trước khi tác động DOM. Gửi lặp cùng `turnId` và nội dung là idempotent (không click Send lần hai); gửi cùng ID khác nội dung trả về `CONFIG_CONFLICT`; gửi đè khi lượt trước đang chạy trả về `BUSY`.
   - **Trạng thái Live:** Hồ sơ riêng `C:\Users\vhc\.gemini\gemini_web_probe_profile` chưa được kiểm chứng phiên live mới; trạng thái ghi nhận trước đó là `SIGN_IN_REQUIRED`. Cần người dùng đăng nhập tài khoản Google thủ công 1 lần để mở khóa live chat. Chi tiết xem [g2-browser-live-validation.md](g2-browser-live-validation.md).

3. **Nguyên Tắc Bàn Giao:**
   - Dừng đúng phạm vi G2; không tự ý chuyển sang G3–G5.
   - Giữ nguyên cấu hình và cài đặt gốc của Antigravity IDE (`D:\Antigravity IDE`).
   - Không giả lập thành công hay thay đổi kiến trúc sang Gemini API / CLI độc lập.

