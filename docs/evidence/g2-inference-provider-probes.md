# Báo Cáo Khảo Sát Outbound Inference và Provider Hooks trên Antigravity Language Server

**Ngày khảo sát:** 14/10/2026  
**Mục tiêu:** Khảo sát các cờ nhị phân (command-line flags) và cấu hình outbound route của `language_server_windows_x64.exe` nhằm đánh giá khả năng bẻ hướng suy luận (inference routing) từ chat native của Antigravity IDE sang consumer Gemini Web (`gemini.google.com`).

---

## 1. Thông Tin Nhị Phân Khảo Sát (Binary Metadata)

- **Đường dẫn mục tiêu:** `D:\Antigravity IDE\resources\app\extensions\antigravity\bin\language_server_windows_x64.exe`
- **Kích thước:** `124,639,232 bytes` (~118.86 MB)
- **Thời gian sửa đổi cuối:** `17/06/2026 22:36:24`
- **SHA256 Checksum:** `78C4242BF9E5D84A3A0CA44675D44BE09A028056E54C3F0D85280A4D8700DEE4`
- **Kiến trúc:** PE32+ executable (GUI/console) x86-64, biên dịch từ C++/Go với Google Abseil flags và ConnectRPC/gRPC.

---

## 2. Phát Hiện Cấu Hình Tĩnh (Static Findings từ `--help` và Descriptor)

Qua việc giải mã usage strings (`--help`) và descriptor của nhị phân `language_server_windows_x64.exe`:
- **Model API Client Types:** Hỗ trợ `ccpa` (Cloud Code Partner API, mặc định) hoặc `gemini`.
- **Default Generative Service Address:** Mặc định trỏ đến `blade:google.ai.generativelanguage.v1main.generativeservice-prod` (Stubby/Blade RPC nội bộ Google).
- **Các cờ cấu hình mạng liên quan:**
  - `-cloud_code_endpoint`: Endpoint dịch vụ Cloud Code Partner API.
  - `-generative_service_addr`: Địa chỉ dịch vụ generative nội bộ cho client type `gemini`.
  - `-inference_api_server_url`: URL server inference backend nội bộ.
  - `-subclient_type`: Kiểu subclient (ví dụ: `ide`).
- **Nhận định tĩnh:** Nhị phân không có cờ tham số nhận HTML, Server-Sent Events hay endpoint web consumer `gemini.google.com`. Tuy nhiên, đây là cấu hình tham số tĩnh, chưa phải là bằng chứng thực nghiệm về semantics outbound hay khả năng kết nối qua một compatibility bridge tương thích.

---

## 3. Kết Quả Thực Nghiệm Probe Nhị Phân (Empirical Observations)

Dữ liệu đối chiếu trực tiếp từ file kết quả thực nghiệm thô [`tools/probes/g2/inference_routes_probe_results.json`](../../tools/probes/g2/inference_routes_probe_results.json):

| Kịch bản | Cờ thực thi thực tế (Arguments) | Port Mock Server | Ports phát hiện (HTTP/HTTPS/Ext) | RPC Attempted | Verdict Thực Nghiệm |
|---|---|---|---|---|---|
| **Scenario 1: Baseline** | `[]` (không cờ bổ sung) | `52690` | `null / null / null` | `false` | `TIMEOUT_OR_NO_PORT` (~11.0s) |
| **Scenario 2: Cloud Code Override** | `["-cloud_code_endpoint=http://127.0.0.1:58202"]` | `58202` | `null / null / null` | `false` | `TIMEOUT_OR_NO_PORT` (~11.0s) |
| **Scenario 3: Gemini Client Type** | `["-model_api_client_type=gemini", "-generative_service_addr=127.0.0.1:65305"]` | `65305` | `null / null / null` | `false` | `TIMEOUT_OR_NO_PORT` (~11.0s) |
| **Scenario 4: Inference Server URL** | `["-inference_api_server_url=http://127.0.0.1:65306"]` | `65306` | `null / null / null` | `false` | `TIMEOUT_OR_NO_PORT` (~11.0s) |

### Phân Tích Sự Thật Chẩn Đoán (Diagnostic Truth):
1. **Startup / Readiness Blocker:**
   - Trong cả 4 kịch bản, khi Language Server được khởi chạy độc lập (standalone) bằng command-line bên ngoài IDE, tiến trình không mở bất kỳ cổng lắng nghe HTTP/HTTPS/Extension nào trước khi hết hạn deadline phát hiện cổng.
   - Do không phát hiện được cổng lắng nghe, probe chưa thực hiện được bất kỳ cuộc gọi RPC nào (`rpc_attempted = false`, `rpc_status = null`).
   - Mock server cục bộ không nhận được bất kỳ request outbound nào (`mock_requests_received = []`).
2. **Trạng Thái Thực Nghiệm:**
   - Baseline chưa đạt trạng thái sẵn sàng (readiness); do đó chưa kiểm tra được suy luận thực tế (inference), giải mã token phản hồi, hay round-trip executor native.
   - Startup/readiness trong môi trường probe độc lập là **blocker quan sát được hiện tại**.
3. **Phân Định Giữa Traffic Quan Sát và Nghiệm Thu Inference:**
   - Việc chỉ quan sát được request HTTP đơn thuần (ví dụ `/generate-health`) không tương đương với việc bẻ hướng suy luận native thành công.
   - Inference Gate chỉ có thể đạt khi có:
     - Synthetic prompt từ native chat của IDE,
     - Token stream / response fixture được giải mã đúng từng lượt,
     - Tool call read-only được thực thi round-trip qua đúng executor gốc của IDE.
4. **Kết Luận Kiến Trúc:**
   - Không kết luận "TLS interception / MITM giữa IDE và Language Server là phương án duy nhất bắt buộc" chỉ từ các lần timeout thiếu port này.
   - Khả năng định tuyến suy luận native sang Gemini Web hiện tại được xác định chính xác là: **`UNRESOLVED / NOT_TESTED`**.

---

## 4. Kiến Trúc Bộ Dò Được Thắt Chặt (Hardened Probe Architecture - V7 & V8)

Bộ dò `tools/probes/g2/probe_ls_inference_routes.py` đã được tái cấu trúc triệt để theo review findings V7 & V8:

1. **Log Sanitization & Zero Raw Output (V7):**
   - Loại bỏ hoàn toàn việc in thô stdout/stderr của tiến trình con.
   - Chỉ trích xuất port/protocol/severity thành metadata chuẩn; không chuyển tiếp free-form message hoặc dựa vào keyword blacklist để bảo vệ nội dung.
   - Chỉ in các thông điệp metadata allowlist đã được lọc sạch (cổng, mã trạng thái lỗi, tiến độ kịch bản).
   - Kiểm chứng quoted cookie/prompt/JSON, queue output và argv/path qua `verify_log_sanitization()` và `test_probe_safety.py`; không suy ra coverage tuyệt đối từ một marker.
2. **SafeMockServer Body Read & Shutdown Deadline (V8):**
   - Body có absolute deadline 1.0s và cap 1MB. Shutdown ngắt active socket của fixture trước khi join có budget, không chỉ dựa vào idle timeout.
   - Xử lý sạch lỗi đọc dở dang (incomplete POST body) mà không làm tắc nghẽn server.
   - `server.stop(timeout_s=2.0)` có deadline rõ ràng, đóng socket lắng nghe và join thread có giới hạn thời gian.
   - Đã kiểm chứng qua hàm `verify_mock_server_incomplete_body_timeout()`.
3. **Budget Thời Gian Rõ Ràng (V8):**
   - Phân định rõ ràng: Scenario budget (`3.0s`) và Cleanup budget (`2.0s`), tổng ngân sách tối đa `5.0s`.
   - Đã kiểm chứng qua `verify_timeout_on_silent_child()` với thời gian thực tế `4.04s`, tiêu diệt tiến trình con sạch sẽ và xác nhận không còn tiến trình mồ côi.
