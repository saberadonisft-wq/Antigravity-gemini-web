# Báo cáo Khảo sát Khả thi Transparent Shim và Inference Hook (G2 Spike Hardening)

Ngày khảo sát: 14/10/2026  
Môi trường hệ thống: Windows 11 x64, Node v24.18.0, Python 3.13.6, Microsoft C# Compiler (csc.exe v14.8.10001.0, .NET Framework 4.8)  
Mục tiêu cốt lõi: Khắc phục triệt để các hạn chế tính trong suốt (S1–S4), chứng minh launch hook trên Antigravity IDE với profile riêng biệt (S5), bảo đảm ranh giới cô lập (S6), và đánh giá khả năng chuyển hướng suy luận (inference hook) sang Gemini Web mà vẫn giữ executor của IDE.

---

## 1. Tóm tắt Trạng thái Nghiệm thu

| Tiêu chí | Trạng thái | Căn cứ thực nghiệm |
|---|---|---|
| **Sửa S1 (Windows Argv Quoting)** | **PASS** | Cài đặt chuẩn Win32 `QuoteArgument` theo quy tắc `CommandLineToArgvW`. Kiểm chứng 100% token round-trip bằng JSON token assert: bảo toàn chuỗi rỗng `""`, tab `\t`, newline `\n`, path kết thúc bằng backslash `C:\dir\`, chuỗi backslashes trước quote `foo\\\"bar`, Unicode tiếng Việt có dấu, và flag dạng `name=val`. |
| **Sửa S2 (Redaction Flag Equals & Allowlist)** | **PASS** | Loại bỏ dump raw argv; cài đặt bộ lọc che giấu tự động cho cả 2 cú pháp `--key value` và `--key=value` đối với mọi khóa nhạy cảm (`csrf`, `token`, `secret`, `key`, `password`, `auth`, `bearer`). Kiểm chứng bằng synthetic secrets: 0 token lọt vào `shim.log`. |
| **Sửa S3 (Output Drain & Backpressure)** | **PASS** | Quản lý luồng worker stdout/stderr với thời hạn drain an toàn (15 giây) đến khi đạt EOF. Vượt qua bài kiểm tra slow consumer 12.000 byte với delay từng chunk (nhận đủ 100% byte), bài kiểm tra burst đồng thời 64KB trên stdout/stderr, và mã lỗi 125 fail-closed khi drain timeout. |
| **Sửa S4 (Job Object Error & Grandchild Cleanup)** | **PASS** | Kiểm tra toàn bộ mã lỗi Win32 (`Marshal.GetLastWin32Error()`) cho `CreateJobObject`, `SetInformationJobObject`, `AssignProcessToJobObject`. Mã lỗi fail-closed 124 khi khởi tạo lỗi. Kiểm chứng thực tế: khi wrapper process bị kill, cả tiến trình con (child) lẫn tiến trình cháu (grandchild) đều bị tiêu hủy sạch sẽ. |
| **S5 (IDE Launch Hook Thực tế)** | **PASS (Launch Hook Only)** | Đã khởi chạy thành công Antigravity IDE v1.107.0 với profile cô lập `C:\Users\vhc\.gemini\antigravity_shim_test_profile`. IDE (PID 10168) đã spawn `antigravity_shim.exe` (PID 4716), shim đã spawn `language_server_windows_x64.exe` (PID 19824). Ghi nhận log khởi tạo cổng HTTPS 64584, kết nối extension server 64581, và shutdown sạch sẽ không còn tiến trình mồ côi. |
| **S6 (Cô lập Profile & .gitignore)** | **PASS** | Đã cấu hình `.gitignore` loại bỏ `*.exe`, `tmp_ide_user_data/`, `.tmp/`, `temp/`. Profile thử nghiệm được đặt hoàn toàn bên ngoài repository (`C:\Users\vhc\.gemini\antigravity_shim_test_profile`). |
| **Inference Hook (Định tuyến Chat sang Gemini Web)** | **UNRESOLVED / NOT PROVEN** | Launch hook chỉ chứng minh việc IDE khởi chạy wrapper. Binary gốc vẫn gọi Google Cloud Code Assist (`blade:google.ai.generativelanguage.v1main.generativeservice-prod`). Cần một proxy ConnectRPC nội bộ để đánh chặn chat prompt sang Gemini Web mà vẫn giữ executor. Tuyệt đối không coi việc IDE chạy qua wrapper là Gemini Web đã được tích hợp. |
| **Browser Gate (G2-C)** | **NEEDS_USER_ACTION / CONTRACT_ONLY** | Profile Chrome thử nghiệm (`C:\Users\vhc\.gemini\gemini_web_probe_profile`) truy cập thành công nhưng đang chờ người dùng đăng nhập Google. `packages/gemini-browser` hiện đang ở mức Adapter Contract/Stub. |
| **End-to-End Live (G2-D / G2-E)** | **BLOCKED / NOT TESTED** | Bị chặn do Inference Hook chưa được chứng minh và Browser Gate chưa có phiên đăng nhập. |

---

## 2. Thông số Nhận diện & Bảng Hash Cố định (Pinned Hashes)

- **IDE Application:** `D:\Antigravity IDE\Antigravity IDE.exe` (v1.107.0, Commit `e0b7a2bcf575cfba10528c4e7c10bd3ce2d7769a`)
- **Target Language Server Binary:**
  - Đường dẫn: `D:\Antigravity IDE\resources\app\extensions\antigravity\bin\language_server_windows_x64.exe`
  - Kích thước: 130.551.808 bytes (124 MB)
  - **SHA256:** `78C4242BF9E5D84A3A0CA44675D44BE09A028056E54C3F0D85280A4D8700DEE4`
- **Shim Executable:**
  - Mã nguồn: [`tools/probes/g2/shim/AntigravityShim.cs`](file:///d:/Antigravity-gemini-web/tools/probes/g2/shim/AntigravityShim.cs)
  - Trình biên dịch: `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` (v14.8.10001.0, .NET Framework 4.8)
  - Binary sinh ra: [`tools/probes/g2/shim/antigravity_shim.exe`](file:///d:/Antigravity-gemini-web/tools/probes/g2/shim/antigravity_shim.exe)
  - **SHA256:** `9CF2AC23727A9C7CF6F0B5E05284B94C6D77914856E39BAA50BE0F84501F08EC`
- **Fake Child Fixture:**
  - Mã nguồn: [`tools/probes/g2/shim/FakeChild.cs`](file:///d:/Antigravity-gemini-web/tools/probes/g2/shim/FakeChild.cs)
  - Binary sinh ra: [`tools/probes/g2/shim/fake_child.exe`](file:///d:/Antigravity-gemini-web/tools/probes/g2/shim/fake_child.exe)
  - **SHA256:** `4EC7FFCFE12B7C07D7B1B62B89617596BE15BFDCF9217DDE8BF02A91F4FD3763`

---

## 3. Khảo sát Cơ chế Đọc Cấu hình của Antigravity IDE (Launch Architecture)

Qua khảo sát dịch ngược mã nguồn của Antigravity IDE v1.107.0, cơ chế đọc đường dẫn Language Server được phân tầng rõ rệt:

1. **Khởi chạy từ Electron Main Process (`resources/app/out/main.js` pos 12837300–12837700):**
   ```javascript
   start() {
     const t = this._environmentMainService.appRoot,
       r = this._configurationService.getValue("codeiumDev.machineLanguageServerBinaryPath");
     let n;
     if (r && Wer(r)) ? (
       n = r,
       this.logger.info(`[LS Main] Using configured machine LS binary path: ${n}`)
     ) : (
       r && this.logger.warn(`[LS Main] Configured machineLanguageServerBinaryPath does not exist: ${r}, falling back to default`),
       n = Jno(t)
     )
     ...
     this.logger.info(`[LS Main] Starting language server from: ${n}`);
   }
   ```
   **Phát hiện mấu chốt:** Khi Antigravity IDE mở lên ở cấp độ cửa sổ chính, tiến trình nền Electron Main đọc khóa cấu hình **`codeiumDev.machineLanguageServerBinaryPath`** để spawn Language Server ban đầu.
2. **Khởi chạy từ Extension Host Process (`resources/app/extensions/antigravity/dist/extension.js` pos 1626238):**
   ```javascript
   async function D(e) {
     let t = (0, X.zj)(X.TS.LANGUAGE_SERVER_BINARY_PATH); // "codeiumDev.languageServerBinaryPath"
     if ("" === t) {
       t = (0, C.o7)("language_server_windows_x64.exe", e);
     }
     ...
   }
   ```
   Tiến trình Extension Host đọc khóa **`codeiumDev.languageServerBinaryPath`**.
3. **Kết luận về cấu hình:** Để bảo đảm wrapper luôn được kích hoạt đầy đủ ở cả Main Process lẫn Extension Host, cài đặt đồng thời cả 2 khóa trong `settings.json`:
   ```json
   {
     "codeiumDev.machineLanguageServerBinaryPath": "D:\\Antigravity-gemini-web\\tools\\probes\\g2\\shim\\antigravity_shim.exe",
     "codeiumDev.languageServerBinaryPath": "D:\\Antigravity-gemini-web\\tools\\probes\\g2\\shim\\antigravity_shim.exe"
   }
   ```

---

## 4. Kết quả Kiểm thử Nâng cao với Fake Child (S1–S4 Hardening Tests)

Tập kiểm thử tự động [`tools/probes/g2/shim/test_shim.py`](file:///d:/Antigravity-gemini-web/tools/probes/g2/shim/test_shim.py) đã thực thi 7 kịch bản kiểm chứng:

```text
Ran 7 tests in 3.158s

OK
```

1. **`test_01_token_round_trip_equality` [S1]:**
   - Đưa vào 10 tokens phức tạp: chuỗi rỗng `""`, token có khoảng trắng, token có ký tự tab `\t`, token có ký tự newline `\n`, đường dẫn kết thúc bằng backslash `C:\Program Files\Antigravity\`, chuỗi backslashes trước dấu nháy kép `foo\\\"bar`, chuỗi Unicode tiếng Việt `Tiếng Việt Có Dấu 2026`, và token dạng gán `name=value with spaces and=equals`.
   - Kết quả: `FakeChild` parse qua Windows standard command line và xuất ra JSON mảng tokens; khẳng định **10/10 tokens khớp chính xác 100% byte-for-byte**.
2. **`test_02_redaction_space_and_equals_syntax` [S2]:**
   - Đưa vào 6 synthetic secrets dưới cả 2 dạng: `--csrf_token <SECRET>`, `--csrf_token=<SECRET>`, `--extension_server_csrf_token <SECRET>`, `--extension_server_csrf_token=<SECRET>`, `--api_key <SECRET>`, `--api_key=<SECRET>`.
   - Kết quả: Tất cả 6 chuỗi bí mật đều biến mất khỏi `shim.log` và được thay bằng `[REDACTED]`. Giá trị cổng an toàn `--extension_server_port 54321` được giữ lại phục vụ chẩn đoán.
3. **`test_03_slow_consumer_and_backpressure_drain` [S3]:**
   - `FakeChild` ghi 12.000 byte ra stdout theo từng khối 512 byte. Bên nhận (parent reader) đọc chậm và tạm dừng 10ms sau mỗi lần đọc để tạo áp lực ngược (backpressure).
   - Kết quả: Shim chờ worker đọc và chuyển tiếp đầy đủ 12.000 byte trước khi thoát, không nuốt dữ liệu, trả về exit code 0.
4. **`test_04_burst_simultaneous_stdout_and_stderr` [S3]:**
   - `FakeChild` đẩy đồng thời 64 KB (65.536 byte) ra stdout và 64 KB ra stderr bằng 2 thread độc lập.
   - Kết quả: Shim drain đồng thời cả 2 luồng đến EOF mà không bị deadlock, bên nhận thu đủ 65.536 byte trên mỗi kênh.
5. **`test_05_job_object_grandchild_cleanup` [S4]:**
   - `FakeChild` tự sinh một tiến trình con của nó (grandchild process).
   - Test thu thập PID của child và grandchild, xác nhận cả 2 đều đang chạy.
   - Khi wrapper process bị ngắt (`proc.terminate()`), Windows Job Object lập tức tiêu hủy **cả tiến trình child lẫn grandchild**. Sau 1 giây, kiểm tra hệ thống xác nhận cả 2 PID đều đã biến mất hoàn toàn khỏi Windows process table.
6. **`test_06_job_object_fail_closed` [S4]:**
   - Đặt biến `ANTIGRAVITY_SIMULATE_JOB_FAIL=1`.
   - Kết quả: Shim từ chối khởi chạy child, ghi log lỗi nghiêm trọng và thoát với mã lỗi an toàn 124 (fail-closed).
7. **`test_07_exit_code_and_missing_binary`:**
   - Lan truyền chính xác mã lỗi 42 của tiến trình con.
   - Trả mã lỗi 127 khi binary đích không tồn tại.

---

## 5. Bằng chứng Thực nghiệm IDE Launch Hook Thực tế (S5 Acceptance)

Đã thực hiện thử nghiệm khởi chạy Antigravity IDE v1.107.0 trên môi trường cô lập:
- **Thư mục cấu hình thử nghiệm:** `C:\Users\vhc\.gemini\antigravity_shim_test_profile` (hoàn toàn ngoài repository).
- **Thiết lập kích hoạt:**
  `C:\Users\vhc\.gemini\antigravity_shim_test_profile\User\settings.json`:
  ```json
  {
    "codeiumDev.machineLanguageServerBinaryPath": "D:\\Antigravity-gemini-web\\tools\\probes\\g2\\shim\\antigravity_shim.exe",
    "codeiumDev.languageServerBinaryPath": "D:\\Antigravity-gemini-web\\tools\\probes\\g2\\shim\\antigravity_shim.exe"
  }
  ```

### 5.1. Dữ liệu Thu thập từ Runtime Thực tế
1. **Tiến trình IDE khởi chạy:**
   - Command: `"D:\Antigravity IDE\Antigravity IDE.exe" --user-data-dir "C:\Users\vhc\.gemini\antigravity_shim_test_profile" --no-sandbox`
   - IDE Main Process PID: `10168`
2. **Cây tiến trình được thiết lập:**
   - IDE Main Process (`Antigravity IDE.exe`, PID `10168`)
     └── Shim Process (`antigravity_shim.exe`, PID `4716`)
         └── Real Language Server (`language_server_windows_x64.exe`, PID `19824`)
3. **Nội dung ghi nhận trong `tools/probes/g2/shim/shim.log`:**
   ```text
   [2026-10-14T09:24:53.992Z] [PID:4716] Antigravity transparent shim invoked. Target: 'D:\Antigravity IDE\resources\app\extensions\antigravity\bin\language_server_windows_x64.exe'. Args: '--csrf_token [REDACTED] --extension_server_port 64581 --extension_server_csrf_token [REDACTED] --app_data_dir antigravity-ide --subclient_type ide --cloud_code_endpoint https://cloudcode-pa.googleapis.com'. Cwd: 'D:\Antigravity IDE'
   [2026-10-14T09:24:54.006Z] [PID:4716] Target process spawned successfully with PID: 19824
   ```
4. **Nội dung ghi nhận trong `logs\20261014T162453\ls-main.log` của IDE:**
   ```text
   2026-10-14 16:24:53.766 [info] [LS Main] Using configured machine LS binary path: D:\Antigravity-gemini-web\tools\probes\g2\shim\antigravity_shim.exe
   2026-10-14 16:24:53.767 [info] [LS Main] Starting language server from: D:\Antigravity-gemini-web\tools\probes\g2\shim\antigravity_shim.exe
   2026-10-14 16:24:53.868 [info] [LS Main] Args: --csrf_token 522978d8-db93-499c-b967-f7e14971cb0b --extension_server_port 64581 --extension_server_csrf_token 51e7d9af-9941-4206-86dd-6d2cc65d3528 --app_data_dir antigravity-ide --subclient_type ide --cloud_code_endpoint https://cloudcode-pa.googleapis.com
   2026-10-14 16:24:53.936 [info] [LS Main] Process spawned with PID: 4716
   2026-10-14 16:24:54.096 [error] [LS Main stderr] I1014 16:24:54.094627 19824 server.go:1296] Starting language server process with pid 19824
   2026-10-14 16:24:54.118 [error] [LS Main stderr] I1014 16:24:54.117983 19824 server.go:493] Language server listening on random port at 64584 for HTTPS (gRPC)
   ```
5. **Kiểm tra Đóng ứng dụng (Clean Shutdown):**
   Khi tiến trình IDE (PID 10168) nhận lệnh dừng, Windows Job Object của shim tự động giải phóng toàn bộ tiến trình con:
   ```text
   After shutdown: Remaining Shim = 0, Remaining LS = 0
   ```
   Không còn bất kỳ tiến trình `antigravity_shim` hay `language_server_windows_x64` nào chạy ngầm trên Windows.
6. **Khôi phục (Rollback):**
   Chỉ cần xóa thư mục cấu hình thử nghiệm `C:\Users\vhc\.gemini\antigravity_shim_test_profile`. IDE chính và dữ liệu người dùng không bị thay đổi.

---

## 6. Khảo sát Inference Hook Trực tiếp trên Binary Thật (Inference Route Analysis)

Khảo sát cờ tham số của `language_server_windows_x64.exe` liên quan đến model/suy luận:
1. **`-generative_service_addr` (Mặc định: `"blade:google.ai.generativelanguage.v1main.generativeservice-prod"`):**
   - Sử dụng giao thức nội bộ Stubby/Blade RPC của Google.
   - Không hỗ trợ giao thức HTTP/JSON thông thường; không thể trỏ trực tiếp đến localhost nếu không có adapter Blade RPC tương thích.
2. **`-model_api_client_type` (Mặc định: `ccpa`, hỗ trợ: `ccpa` hoặc `gemini`):**
   - Khi chọn `gemini`, binary sử dụng Google AI Studio / Gemini API SDK nội bộ, yêu cầu API key hoặc Google Cloud OAuth hợp lệ. Nó **không trỏ sang giao diện Gemini Web**.
3. **`-cloud_code_endpoint` (Mặc định: `https://cloudcode-pa.googleapis.com`):**
   - Endpoint Cloud Code Partner API phục vụ lấy quota, telemetry và danh sách models được cấp phép.
4. **`-inference_api_server_url` (Mặc định: `""`):**
   - URL máy chủ Vertex AI / Enterprise. Nếu trỏ vào local mock, binary yêu cầu xác thực TLS và schema nhị phân nghiêm ngặt của Google.

### Kết luận Kỹ thuật về Inference Hook
- **Cơ chế Passthrough không giải quyết bài toán:** Khi wrapper chuyển tiếp lệnh đến `language_server_windows_x64.exe`, toàn bộ suy luận chat native vẫn được thực thi trên hạ tầng Cloud Code Assist của Google, tiêu tốn quota của người dùng và hoàn toàn không đi qua Gemini Web.
- **Để tích hợp Gemini Web thật sự vào Chat Native IDE:**
  Bắt buộc phải có một thành phần trung gian (proxy hoặc shim nâng cao) đứng tại cổng HTTPS ConnectRPC nội bộ (ví dụ cổng `64584` ở lượt chạy trên) để:
  1. Đánh chặn RPC `StartCascade` / `GetCascadeTrajectory` gửi từ Workbench UI.
  2. Định tuyến câu hỏi sang `GeminiBrowserAdapter` (Gemini Web).
  3. Nhận phản hồi công cụ và chuyển tiếp cho executor của IDE thực thi.
  4. Trả kết quả cuối cùng về cho Workbench UI hiển thị.
- Do đó, Gate Inference Hook được ghi nhận trung thực là **UNRESOLVED / NOT PROVEN**.

---

## 7. Tổng kết Bàn giao G2

1. **Gate Launch Hook:** **PASS** (Đã kiểm chứng đầy đủ IDE → Shim → Language Server).
2. **Gate Inference Hook:** **UNRESOLVED / NOT PROVEN** (Cần kiến trúc proxy ConnectRPC).
3. **Gate Browser (G2-C):** **NEEDS_USER_ACTION** (Chờ người dùng đăng nhập tài khoản Google trên profile Chrome thử nghiệm).
4. **End-to-End (G2-D/E):** **BLOCKED / NOT TESTED**.
5. **Dừng theo đúng quy định G2, bảo toàn toàn bộ nguyên tắc dự án và chưa triển khai G3.**
