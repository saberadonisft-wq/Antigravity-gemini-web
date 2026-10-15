# Antigravity Transparent Shim PoC (G2 Launch Hook)

Thư mục này chứa prototype bộ đệm khởi chạy trong suốt (Transparent Wrapper / Shim) phục vụ kiểm chứng launch hook `codeiumDev.languageServerBinaryPath` của Antigravity IDE v1.107.0.

---

## 1. Mục đích và Ranh giới Kỹ thuật

- **Mục đích:** Đứng giữa IDE và binary Language Server gốc (`language_server_windows_x64.exe`), chuyển tiếp toàn bộ tham số, luồng I/O (stdin/stdout/stderr) và mã thoát (exit code).
- **Ranh giới:**
  - Chứng minh cơ chế launch hook của IDE.
  - **KHÔNG** chứng minh việc đổi route suy luận sang Gemini Web (Inference Route).
  - Không thay đổi binary gốc, không vá mã nguồn IDE, không giải mã TLS.
  - Sử dụng Windows Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) để bảo đảm khi wrapper bị tắt hoặc IDE đóng, toàn bộ cây tiến trình con được dọn dẹp sạch sẽ, không tạo tiến trình mồ côi.

---

## 2. Chuỗi Công cụ (Pinned Toolchain)

- **Trình biên dịch:** `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` (Microsoft C# Compiler v14.8.10001.0).
- **Môi trường thực thi:** .NET Framework 4.8+ có sẵn trên mọi bản cài đặt Windows 10/11 x64.
- **Không phụ thuộc thư viện ngoài:** Không cần cài đặt pip packages, npm global, hay SDK bên ngoài.

---

## 3. Cấu trúc Thư mục

- [`AntigravityShim.cs`](AntigravityShim.cs): Mã nguồn wrapper C#.
- [`build.ps1`](build.ps1): Script biên dịch `antigravity_shim.exe`.
- [`FakeChild.cs`](FakeChild.cs): Mã nguồn executable double mô phỏng language server.
- [`test_shim.py`](test_shim.py): Bài kiểm tra tự động bao gồm:
  1. Chuyển tiếp tham số nguyên vẹn (`--enable_lsp`, `--extension_server_port`, ...).
  2. Byte-level stream STDIN / STDOUT / STDERR.
  3. Che giấu thông tin nhạy cảm trong log (`--csrf_token`, `--extension_server_csrf_token` được thay bằng `[REDACTED]`).
  4. Lan truyền mã lỗi chính xác (Exit Code 0, Exit Code 42, Exit Code 127).
  5. Quản lý vòng đời ngắt tiến trình (Job Object + termination handling).
- [`README.md`](README.md): Tài liệu hướng dẫn này.

---

## 4. Biên dịch và Kiểm thử

```powershell
# 1. Biên dịch Shim và Fake Child
powershell -ExecutionPolicy Bypass -File tools\probes\g2\shim\build.ps1
& "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /target:exe /optimize+ /out:tools\probes\g2\shim\fake_child.exe tools\probes\g2\shim\FakeChild.cs

# 2. Chạy bộ kiểm thử
python tools\probes\g2\shim\test_shim.py
```

---

## 5. Cấu hình Thử nghiệm trên IDE & Cách Khôi phục (Rollback)

### Cấu hình thử nghiệm qua VS Code Settings:
Nếu thử nghiệm trên profile người dùng riêng biệt của IDE, thêm vào file `settings.json`:
```json
{
  "codeiumDev.languageServerBinaryPath": "D:\\Antigravity-gemini-web\\tools\\probes\\g2\\shim\\antigravity_shim.exe"
}
```

### Biến môi trường tùy chọn:
- `ANTIGRAVITY_TARGET_LS_PATH`: Đường dẫn binary đích cần chuyển tiếp (mặc định trỏ về `D:\Antigravity IDE\resources\app\extensions\antigravity\bin\language_server_windows_x64.exe`).
- `ANTIGRAVITY_SHIM_LOG_PATH`: Đường dẫn file nhật ký (mặc định tạo `shim.log` tại thư mục chứa shim).

### Khôi phục (Rollback):
Xóa bỏ khóa cấu hình `"codeiumDev.languageServerBinaryPath"` trong `settings.json` để IDE tự động quay về sử dụng trực tiếp `language_server_windows_x64.exe` nguyên bản.

