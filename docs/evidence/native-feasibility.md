# Báo cáo kiểm chứng khả thi native (G0) — Antigravity & Gemini Web

- **Thời điểm kiểm tra ban đầu:** 14/10/2026 11:36 – 12:00 (UTC+7).
- **Thời điểm cập nhật theo Review G0:** 14/10/2026 12:15 (UTC+7).
- **Môi trường thử nghiệm:**
  - Hệ điều hành: Windows 11 (win32 x64).
  - Trình biên tập/Host: Microsoft Visual Studio Code (x64, cài đặt tại `D:\Microsoft VS Code\Code.exe`).
  - Antigravity VS Code Extension: `google.google-antigravity` v1.7.0 (`C:\Users\vhc\.vscode\extensions\google.google-antigravity-1.7.0`).
  - Antigravity Language Server / CLI: `agy.exe` v1.3.5 (internal build `cli-2.23.0`, binary tại `C:\Users\vhc\.gemini\bin\agy.exe`).
  - Trình duyệt cài đặt: Google Chrome 135+ (`C:\Program Files\Google\Chrome\Application\chrome.exe`), Microsoft Edge (`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`).
  - Runtime probe: Python 3.13.6, Selenium 4.34.2.

---

## 1. Bảng đánh giá từng bước

| Hạng mục kiểm tra | Trạng thái | Ghi chú và căn cứ thực tế |
|---|---|---|
| **G0-A.1: Định danh ứng dụng Antigravity trên máy** | **PASS** | Tìm thấy extension `google.google-antigravity` v1.7.0 trong VS Code và binary `agy.exe` v1.3.5 tại `C:\Users\vhc\.gemini\bin\agy.exe`. Quá trình spawn được ghi rõ trong `C:\Users\vhc\.gemini\logs\install.log`. |
| **G0-A.2: Khảo sát kiến trúc UI native & đường tích hợp model** | **PASS** | Đọc source `extension.js`, `bridge.js`, cấu trúc binary `agy.exe`, và RPC Connect. Webview của IDE nhúng iframe trỏ về `agy.exe --hub`. Model inference nằm hoàn toàn trong `agy.exe` (Cortex engine), không nằm ở extension hay webview. |
| **G0-A.3a: Thêm model Gemini Web vào Model Picker native** | **UNSUPPORTED** | `GetAvailableModels` trả về danh mục model cố định (`gemini-3.8-flash-high`, `claude-sonnet-4-6`, `gpt-oss-120b-medium`,...). RPC `GetUserSettings` / `SetUserSettings` trả về `501 Not Implemented`. VS Code `settings.json` của extension không có schema đăng ký model mới trong bản v1.7.0. |
| **G0-A.3b: Chuyển hướng control-plane của `agy.exe` sang local probe** | **PASS** | Probe chứng minh biến môi trường `JETSKI_SERVICE_ENDPOINT_URL` thành công chuyển hướng request kiểm tra người dùng nội bộ của `agy.exe` về server probe local (`POST /v1internal:fetchUserInfo`). |
| **G0-A.3c: Xác minh inference route & tool loop của `agy.exe`** | **UNVERIFIED / NOT MET** | Chưa chứng minh được request suy luận nào đi tới server cục bộ. Lệnh gọi `StartCascade` trong probe bị lỗi validation nội bộ (`CortexTrajectorySource is unspecified`), chưa có token streaming hay vòng lặp tool nào diễn ra. |
| **G0-B.1: Mở Gemini Web qua browser profile riêng biệt** | **PASS** | Probe khởi chạy Chrome bằng Selenium với thư mục profile riêng biệt `C:\Users\vhc\.gemini\gemini_web_probe_profile`, truy cập thành công `https://gemini.google.com/app`. Chụp màn hình lưu tại profile. |
| **G0-B.2: Tự động hóa chat thật (3 lượt, markdown, cancel)** | **NOT TESTED** | Cần người dùng đăng nhập tài khoản Google thật trên profile thử nghiệm. Do tuân thủ nguyên tắc không tự ý vượt challenge/MFA và không lấy trộm cookie từ profile cá nhân đang dùng, bước này dừng lại ở màn hình chờ đăng nhập. |
| **G0-B.3: Khả năng Custom Apps / MCP trên tài khoản Gemini Web** | **NOT TESTED** | Tài liệu chính thức của Google mô tả tính năng kết nối custom apps qua URL MCP trên Gemini Web (có điều kiện tài khoản cá nhân, 18+, tiếng Anh, Keep Activity). Tuy nhiên, do phiên kiểm tra dừng trước khi đăng nhập, tính năng này **chưa được thử nghiệm trên tài khoản người dùng**. |
| **G0-B.4: Đánh giá đường gọi Tool: Đường A (Custom MCP)** | **UNVERIFIED** | Dù tài liệu mô tả kết nối MCP cloud qua URL, chưa có bằng chứng chứng minh một URL MCP từ web có thể vượt qua tường lửa để gọi về localhost hoặc executor của IDE của người dùng. |
| **G0-B.4: Đánh giá đường gọi Tool: Đường B (Structured Envelope)** | **CONDITIONAL** | Về lý thuyết văn bản, có thể yêu cầu Gemini Web sinh JSON envelope trong markdown (`{"tool":"read_file",...}`). Tuy nhiên, do chưa có luồng streaming tự động, bridge sẽ phải gửi kết quả tool vào ô nhập của web và chờ model phản hồi tiếp. |
| **G0-C: Ghép luồng tối thiểu end-to-end** | **UNRESOLVED / NOT MET** | Chưa có luồng native end-to-end nào chạy được từ chat native IDE qua Gemini Web thật, đọc file fixture và trả kết quả về IDE. Gate G0 chưa đạt. |

---

## 2. Đường tích hợp đã tìm thấy và Bằng chứng thực tế

### 2.1. Kiến trúc Antigravity IDE
1. **Host & Extension:**
   - Ứng dụng IDE thực tế trên máy là **VS Code** với extension chính thức **`google.google-antigravity` (v1.7.0)**.
   - Khi kích hoạt, extension chạy hàm `AntigravityServerManager.start()` (tại `extension.js:32440`), sinh một tiến trình con:
     ```sh
     C:\Users\vhc\.gemini\bin\agy.exe (v1.3.5) --hub --hub-port=<ephemeral_port> --app_data_dir=antigravity --csrf_token=<token> --add-dir=<workspace>
     ```
2. **Giao diện Chat Native:**
   - Khung chat native bên thanh bên (Sidebar) là một Webview nhúng `<iframe>` nạp từ URL:
     `http://127.0.0.1:<hub-port>/?extensionView=true&extensionVariant=vs-code`
   - Giao diện bên trong iframe là React app nạp từ `/main.js` (10.1 MB) phục vụ trực tiếp bởi `agy.exe`.
   - Giao thức liên lạc giữa React app và backend `agy.exe` là **ConnectRPC qua HTTP POST** tại:
     `http://127.0.0.1:<hub-port>/exa.language_server_pb.LanguageServerService/<Method>`
     kèm header `x-codeium-csrf-token`.

3. **Cơ chế quản lý Model:**
   - Khi nạp UI, React app gọi `GetAvailableModels` và `GetCascadeModelConfigData`.
   - Backend `agy.exe` trả về danh mục model cứng (Curated list):
     - `gemini-3.8-flash-high` (`MODEL_PLACEHOLDER_M318`, API Provider: `API_PROVIDER_GOOGLE_GEMINI`)
     - `claude-sonnet-4-6` (`MODEL_PLACEHOLDER_M35`, API Provider: `API_PROVIDER_ANTHROPIC_VERTEX`)
     - `gpt-oss-120b-medium` (`MODEL_OPENAI_GPT_OSS_120B_MEDIUM`, API Provider: `API_PROVIDER_OPENAI_VERTEX`)
   - Mặc dù bên trong protobuf nhị phân của `agy.exe` có các cấu trúc:
     - `antigravity.localharness.CustomEndpoint` (`backend_type`, `config_json`)
     - `jetbox_state_pb.CustomModelsConfig` (`custom_models` map)
     - `antigravity_state.pbtxt` (`last_selected_agent_model`, `custom_models_config`)
   - Nhưng gọi RPC `GetUserSettings` / `SetUserSettings` trên `agy.exe` trả về:
     `urllib.error.HTTPError: HTTP Error 501: Not Implemented`.
   - Trong `package.json` của extension v1.7.0, không có schema cấu hình cho phép người dùng đăng ký model mới tùy ý.

4. **Phân biệt Control-Plane Route và Inference Route:**
   - **Control-plane route (`fetchUserInfo`):** Đã quan sát thấy khi đặt biến môi trường `JETSKI_SERVICE_ENDPOINT_URL=http://127.0.0.1:<port>`, `agy.exe` gửi request `POST /v1internal:fetchUserInfo` tới mock server.
   - **Inference route (`StreamGenerateContent`):** **Chưa được xác minh**. Trong lần thử với `StartCascade`, request trả về lỗi validation schema (`CortexTrajectorySource is unspecified`). Chưa có suy luận nào diễn ra qua mock server.
   - Không được quy kết biến `AICODE_ENDPOINT_URL` hay `GOOGLE_VERTEX_BASE_URL` hoạt động khi chỉ mới bật đồng thời mà chưa kiểm tra đơn biến tách biệt.

---

## 3. Các Probe chẩn đoán, Kết quả và Tính tái hiện

Tất cả các probe đã được tái cấu trúc hoàn chỉnh tại thư mục [`tools/probes/g0/`](file:///d:/Antigravity-gemini-web/tools/probes/g0), bổ sung cơ chế kiểm soát metadata allowlist và đảm bảo cleanup:

### Probe 1: Model Catalog & AICODE_ENDPOINT_URL Probe
- **File:** `tools/probes/g0/test_aicode_endpoint.py`
- **Cách chạy:** `python tools/probes/g0/test_aicode_endpoint.py`
- **Kết quả:** `agy.exe` khởi chạy trên cổng động; `GetAvailableModels` trả về danh mục model cố định. Server mock không nhận được request model catalog vì catalog được embed sẵn trong binary. Tiến trình và server đóng sạch sẽ trong `finally`.

### Probe 2: StartCascade & Endpoint Variable Isolation Probe
- **File:** `tools/probes/g0/test_start_cascade_details.py`
- **Cách chạy:** `python tools/probes/g0/test_start_cascade_details.py [JETSKI_SERVICE_ENDPOINT_URL|AICODE_ENDPOINT_URL|BASELINE]`
- **Kết quả:**
  - Khi thử riêng biến `JETSKI_SERVICE_ENDPOINT_URL`: Mock server nhận request `POST /v1internal:fetchUserInfo` (30 bytes, body: `{"project":"aicode-consumers"}`).
  - Khi gọi `StartCascade`: Trả về `HTTP_400_ValidationFailed` do thiếu cấu trúc ngữ cảnh nội bộ của trajectory.
  - Kết luận: Route control-plane được ghi nhận, route inference chưa được chứng minh.

### Probe 3: Baseline StartCascade Control Test
- **File:** `tools/probes/g0/test_start_cascade.py`
- **Cách chạy:** `python tools/probes/g0/test_start_cascade.py`
- **Kết quả:** Chạy kiểm tra baseline không có biến override, bảo đảm không rò rỉ credential.

### Probe 4: Gemini Web Browser Probe
- **File:** `tools/probes/g0/test_gemini_web.py`
- **Cách chạy:** `python tools/probes/g0/test_gemini_web.py [--headless]`
- **Kết quả:** Khởi chạy Chrome với profile riêng biệt `C:\Users\vhc\.gemini\gemini_web_probe_profile`, truy cập `https://gemini.google.com/app`. Nhận diện trạng thái yêu cầu đăng nhập (`SIGN_IN_REQUIRED`), tài khoản chưa đăng nhập nên khả năng MCP được đánh dấu `NOT_TESTED`. Trình duyệt được dọn dẹp chắc chắn trong `finally`.

### Probe 5: Unit Tests với Doubles / Mocks
- **File:** `tools/probes/g0/test_probes_unit.py`
- **Cách chạy:** `python tools/probes/g0/test_probes_unit.py`
- **Kết quả:** 4/4 bài test pass kiểm chứng:
  1. Header redaction lọc sạch Bearer token, Cookie và query token.
  2. Spawn failure vẫn gọi server shutdown và socket close.
  3. Screenshot failure vẫn gọi `driver.quit()`.
  4. Readiness failure ném ngoại lệ và không bao giờ đánh dấu PASS giả.

---

## 4. Đánh giá Phương án Trình duyệt & Tool Transport

### 4.1. Phương án Trình duyệt (Browser Host)
- Trình duyệt Chrome với profile riêng biệt hoạt động tốt qua Selenium / CDP.
- **Rào cản:** Đăng nhập tài khoản Google có cơ chế BotGuard/MFA, yêu cầu người dùng phải tự đăng nhập thủ công trên profile probe.

### 4.2. Phương án Vận chuyển Công cụ (Tool Transport)
1. **Đường A — Custom MCP trên Gemini Web:**
   - **Tài liệu Google:** Google có tài liệu chính thức về custom apps hỗ trợ kết nối MCP qua URL trên Gemini Web:
     - [Hướng dẫn Custom Apps trên Desktop](https://support.google.com/gemini/answer/17209137?co=GENIE.Platform%3DDesktop&hl=en-TZ)
     - [Hướng dẫn Custom Apps trên Android](https://support.google.com/gemini/answer/17209137?co=GENIE.Platform%3DAndroid&hl=en-GB)
     - [Điều kiện hoạt động Gemini Extensions](https://support.google.com/gemini/answer/13695044?hl=en-GB)
   - **Điều kiện ràng buộc (Eligibility):** Tài khoản cá nhân (Personal Google account), từ 18 tuổi trở lên, ngôn ngữ tiếng Anh, bật tùy chọn *Keep Activity*, nằm trong danh sách quốc gia được hỗ trợ, và một số tính năng có thể gắn với Gemini Spark.
   - **Trạng thái thực tế:** **NOT TESTED** trên tài khoản của người dùng (do phiên thử nghiệm dừng trước đăng nhập).
   - **Thách thức kỹ thuật:** Ngay cả khi tài khoản hỗ trợ nhập URL MCP trên web, khả năng URL đó gọi ngược về server MCP cục bộ trên máy dev (`localhost`) hoặc nối vào đúng executor của IDE vẫn là một câu hỏi mở cần kiểm chứng riêng.
2. **Đường B — Structured Envelope:**
   - Có thể chỉ thị Gemini Web trả về JSON envelope qua markdown, sau đó bridge phân tích cú pháp để gọi tool.
   - Khó khăn chính là đồng bộ luồng: Gemini Web không có API webhook trả lời tự động nên bridge phải dùng trình duyệt để gõ kết quả tool vào ô chat và gửi lại.

---

## 5. Cấu hình đã thay đổi và Trạng thái hoàn nguyên

- **Hệ thống:** Không sửa file `hosts`, không chặn TLS, không can thiệp binary.
- **Cấu hình cá nhân:** Cấu hình IDE đang sử dụng tại `C:\Users\vhc\.gemini\antigravity` và `C:\Users\vhc\.gemini\config` **nguyên vẹn 100%**.
- **Tài nguyên thử nghiệm:** Cô lập tại `C:\Users\vhc\.gemini\test_probe` và `C:\Users\vhc\.gemini\gemini_web_probe_profile`.
- **Tiến trình còn chạy:** Không có tiến trình thử nghiệm nào còn hoạt động ngầm.

---

## 6. KẾT LUẬN GATE G0: UNRESOLVED / NOT MET (CHƯA ĐẠT GATE NATIVE)

Theo tiêu chí nghiêm ngặt của dự án:
> *"Chỉ kết luận GO khi luồng native IDE → Gemini Web thật → đọc file bằng tool của IDE → trả lời trong IDE đã chạy được."*

Hiện tại:
- **Chưa có luồng native nào đạt.**
- **Route suy luận (inference route) chưa được chứng minh.**
- **Gemini Web chưa được đăng nhập thật để xác minh khả năng MCP trên tài khoản này.**
- **Antigravity IDE v1.7.0 chưa mở extension point công khai cho custom model trong chat native.**

Vì vậy, **G0 CHƯA ĐẠT GATE ĐỂ TRIỂN KHAI NATIVE INTEGRATION**.

---

## 7. Phụ lục xử lý Review (Review Addendum — 14/10/2026)

Đối chiếu với các findings trong [`docs/evidence/G0_CODE_REVIEW.md`](file:///d:/Antigravity-gemini-web/docs/evidence/G0_CODE_REVIEW.md):

1. **Xử lý R1 [P1] (MCP trên Gemini Web):** Đã sửa đổi kết luận từ "UNSUPPORTED" sang "NOT TESTED" trên tài khoản cụ thể; đã bổ sung tài liệu chính thức từ Google Help Center kèm các điều kiện ràng buộc (Account 18+, English, Keep Activity).
2. **Xử lý R2 [P1] (Inference route & kiểm tra đơn biến):** Đã tách bạch `control_plane_route_observed` (đạt) và `inference_route_verified` (chưa đạt); probe đã được viết lại để thử nghiệm từng biến môi trường độc lập.
3. **Xử lý R3 [P1] (Redaction & Credential safety):** Đã tạo module `safe_logging.py` áp dụng metadata allowlist; loại bỏ hoàn toàn việc in raw headers, body, Authorization và Cookie; đã có unit test kiểm chứng bằng synthetic data.
4. **Xử lý R4 [P1] (Lỗi readiness/RPC):** Đã sửa các probe để fail-fast, trả về mã thoát nonzero khi có lỗi và xuất kết quả có cấu trúc JSON rõ ràng.
5. **Xử lý R5 [P2] (Cleanup lifecycle):** Đã đưa toàn bộ việc dọn dẹp socket, server, process và webdriver vào khối `finally` chắc chắn; đã có unit test mô phỏng spawn/screenshot failure chứng minh tài nguyên luôn được giải phóng.
6. **Xử lý R6 [P2] (Tính tái hiện & Documentation):** Đã cấp phát cổng động (port 0), bỏ hardcode cứng nhắc, và tạo file [`tools/probes/g0/README.md`](file:///d:/Antigravity-gemini-web/tools/probes/g0/README.md) hướng dẫn đầy đủ.
