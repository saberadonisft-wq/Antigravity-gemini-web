# G0 Diagnostic Probes & Safety Documentation

Thư mục này chứa các script kiểm chứng (probes) độc lập cho giai đoạn G0.

## 1. Nguyên tắc An toàn & Bảo mật (Strict Safety & Redaction)
- **Metadata Allowlist Logging**: Các probe HTTP chỉ ghi nhận `method`, `path` đã loại bỏ query parameters, `content-type`, `content-length` và `status`. Tuyệt đối không log hoặc print raw headers, `Authorization` (Bearer token), `Cookie`, hay request/response body.
- **Cô lập môi trường**: Probe sử dụng thư mục dữ liệu tách biệt (`--app_data_dir=test_probe`) và browser profile tách biệt (`C:\Users\vhc\.gemini\gemini_web_probe_profile`). Không can thiệp hoặc thay đổi profile / cấu hình IDE đang sử dụng.
- **Giải phóng tài nguyên (Guaranteed Cleanup)**: Mọi socket, HTTP server, child process (`agy.exe`) và trình duyệt (`webdriver`) đều được bọc trong các khối `try ... finally` để đảm bảo terminate/kill và shutdown hoàn toàn khi có lỗi hoặc ngoại lệ.

## 2. Danh mục Script

| File | Mục đích | Cách chạy |
|---|---|---|
| `safe_logging.py` | Tiện ích filter và sanitize log HTTP theo allowlist metadata. | Thư viện nội bộ |
| `test_aicode_endpoint.py` | Kiểm tra tác động của biến `AICODE_ENDPOINT_URL` đối với danh mục model catalog của `agy.exe`. | `python tools/probes/g0/test_aicode_endpoint.py` |
| `test_start_cascade_details.py` | Kiểm tra định tuyến từng biến môi trường độc lập (`JETSKI_SERVICE_ENDPOINT_URL`, `AICODE_ENDPOINT_URL`, `BASELINE`). | `python tools/probes/g0/test_start_cascade_details.py [VAR_NAME]` |
| `test_start_cascade.py` | Baseline control test cho `StartCascade`. | `python tools/probes/g0/test_start_cascade.py` |
| `test_gemini_web.py` | Khởi chạy Chrome với profile riêng biệt để xác định trạng thái truy cập và eligibility của Gemini Web. | `python tools/probes/g0/test_gemini_web.py [--headless]` |
| `test_probes_unit.py` | Unit test với doubles/mocks kiểm chứng redaction, cleanup khi spawn lỗi, cleanup khi screenshot lỗi và xử lý lỗi timeout. | `python tools/probes/g0/test_probes_unit.py` |

## 3. Dependency Yêu cầu
- Python 3.10+
- `selenium` 4.x (tùy chọn cho probe trình duyệt)
- Google Chrome (tại đường dẫn mặc định của hệ thống)

