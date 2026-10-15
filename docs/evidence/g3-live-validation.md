# G3-B — Trạng thái native và Gemini Web live

Ngày review: 14/10/2026. Nguồn hiện tại: [g3-codex-remediation-validation.md](g3-codex-remediation-validation.md).

| Gate | Trạng thái | Bằng chứng và giới hạn |
|---|---|---|
| Launch hook | PASS theo evidence trước | Isolated IDE launch smoke, chưa chạy lại trong review này; không phải inference integration |
| Native inference | UNRESOLVED / NOT_TESTED | Standalone TIMEOUT_OR_NO_PORT, rpc_attempted=false; nguyên nhân missing IDE handshake là giả thuyết |
| Browser fixture | PASS | 20 tests gồm lifecycle/cancel/concurrency; không gửi chat Gemini thật |
| Google profile login | NEEDS_USER_ACTION theo báo cáo trước, chưa refresh ở review này | Profile riêng C:\Users\vhc\.gemini\gemini_web_probe_profile; phải check lại mới có observedAt hiện tại |
| Chat Gemini 3 turns/cancel live | NOT_TESTED | Chưa có evidence nghiệm thu live |
| Native read/patch/test pass-fail | NOT_TESTED | Native inference và host tool loop chưa verified |
| G3 recovery/context native E2E | NOT_TESTED | Core component tests không chứng minh flow native |

## Binary và provenance

File đo lại: `D:\Antigravity IDE\resources\app\extensions\antigravity\bin\language_server_windows_x64.exe`.

Size: 124.639.232 bytes. SHA-256: **78C4242BF9E5D84A3A0CA44675D44BE09A028056E54C3F0D85280A4D8700DEE4**.

Hash `a9aa4659...` trong bản báo cáo G3 trước không khớp file trên đĩa tại lần review này. Không tiếp tục dùng hash đó làm evidence.

JSON cũ có `url/title/actionReason` không phải format của [status-only probe hiện tại](../../tools/probes/g2/probe_live_gemini.mjs). Probe hiện trả observedAt, origin, trạng thái, ownership và cleanup metadata an toàn. Chưa chạy lại probe trong đợt review; không gắn output cũ thành evidence mới.

## Mở profile để đăng nhập thủ công

Khi cần nghiệm thu browser live và không có process khác sở hữu profile/cổng:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\Users\vhc\.gemini\gemini_web_probe_profile" https://gemini.google.com/app
```

Đăng nhập/MFA do người dùng thực hiện. Kiểm tra profile/cổng/target ownership trước attach; không sao chép cookie từ profile cá nhân. Login thành công chỉ mở browser gate, không chứng minh native inference.

G4-A launcher/IPC có thể phát triển và kiểm chứng độc lập; G4-B native/live vẫn bị gate như bảng trên.

