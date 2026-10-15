# Báo Cáo Trạng Thái Bắt Đầu G4 (G4 Entry Status)

> Snapshot lịch sử đầu G4. Kiểm chứng mới ngày 15/10: 146 tests + Electron smoke PASS theo [validation](g4-codex-followup-validation.md), G4-A acceptance đầy đủ còn PARTIAL; xem [review continuation](G4_CONTINUE_CODE_REVIEW.md).

**Thời điểm:** 14/10/2026  
**Môi trường:** Windows 11 x64, Node v24.18.0, npm 11.16.0, Python 3.13.6

---

## 1. Kiểm Kê Thực Trạng Kỹ Thuật Trước G4

Trước khi bước vào G4, toàn bộ các bản vá Codex và kết quả kiểm thử hồi quy được kiểm tra xác thực thực tế trên môi trường:

| Bộ kiểm thử / Thành phần | Số lượng bài test | Kết quả | Ghi chú |
|---|---|---|---|
| `@antigravity-gemini-web/contracts` | 8 | **PASS** | Shared Zod schemas, discriminated unions, client interface |
| `@antigravity-gemini-web/gemini-browser` | 20 | **PASS** | DOM fixture lifecycle, 13 concurrency regressions, V2–V6 regressions, element mounting wait |
| `@antigravity-gemini-web/model-bridge` | 4 | **PASS** | EnvelopeParser (syntax vs execution), LiveModelBridgeStub |
| `@antigravity-gemini-web/native-antigravity` | 1 | **PASS** | Live adapter unverified state, không fake success |
| `@antigravity-gemini-web/runtime` | 51 | **PASS** | G3 regressions (G3-R1 đến G3-R11), G3-A resilience suite, resync buffering, snapshot replay rules |
| **Tổng số TypeScript Tests** | **84** | **84/84 PASS** | Thời gian chạy ~6s, typecheck và lint đều đạt |
| **Python Probe Safety Tests** | 5 | **PASS** | Redaction marker nhạy cảm, queue allowlist, sanitized flags, dripping body shutdown |
| **Python Shim Suite** | 9 | **PASS** | H1 metadata sanitization, H2 Win32 broken pipe code 128 |
| **Python Probe Timeout Verification** | 3 | **PASS** | V7 log sanitization, V8 mock timeout (0.00s), silent child timeout (3.07s) |

---

## 2. Trạng Thái Các Cổng Kỹ Thuật (Diagnostic Truth)

1. **Native Launch Hook (G2-B):** **PASS** trên profile IDE cô lập (`antigravity_shim.exe` khởi chạy `language_server_windows_x64.exe` an toàn qua Windows Job Object).
2. **Native Outbound Inference & Provider Hook (G2-B):** **UNRESOLVED / NOT_TESTED**. Language Server standalone không mở cổng lắng nghe nội bộ (`TIMEOUT_OR_NO_PORT`, `rpc_attempted = false`). Giả thuyết thiếu handshake khởi tạo từ IDE cha chưa được chứng minh bằng so sánh có kiểm soát.
3. **Trình điều khiển Gemini Web trên Fixture (G2-C):** **PASS (20/20 tests)**. Hoạt động ổn định trên fixture và mock targets.
4. **Phiên đăng nhập Gemini Web Live (G2-C):** **NEEDS_USER_ACTION**. Profile `C:\Users\vhc\.gemini\gemini_web_probe_profile` chưa có tài khoản Google đăng nhập thủ công; probe thực nghiệm trước đó báo `accountState: "needs_user_action"`.
5. **Desktop Launcher (`apps/launcher`):** Chưa tồn tại tại thời điểm bắt đầu G4. Cần tạo mới cấu trúc `main`, `preload`, `renderer`.

---

## 3. Kế Hoạch Triển Khai G4

- **G4-A (Desktop Launcher, Preload IPC, Runtime Facade & Capability Gating):**
  - Xây dựng `apps/launcher/main`: Electron main process tuân thủ Electron Security Checklist (contextIsolation, sandbox, CSP hạn chế, validate sender/origin/Zod input).
  - Xây dựng `apps/launcher/preload`: Expose duy nhất hợp đồng `LauncherClient` qua `contextBridge` (`getSnapshot`, `execute`, `getOperation`, `getSessions`, `getActivity`, `subscribe`).
  - Xây dựng `apps/launcher/renderer`: React + TypeScript strict + Vite với các màn hình: Onboarding, Overview, Tasks/Sessions, Activity, Settings. Hỗ trợ Demo Mode (thuần client, dán nhãn rõ ràng) và Live Mode (kết nối qua Preload).
  - Kết nối dịch vụ G3 (`SessionCoordinator`, `ContextManager`, `RecoveryJournal`) vào đường gọi thực thi của backend runtime.
  - Áp dụng Capability Gating: Khóa các thao tác chưa có hạ tầng thật (native install, model selection, native tool loops).
- **G4-B (Nghiệm thu Live):**
  - Giữ nguyên trạng thái `BLOCKED / NOT_TESTED` cho đến khi người dùng đăng nhập tài khoản Google và luồng native inference được xác nhận.
  - Tuyệt đối không giả lập thành công cho phiên live.
- **Nguyên tắc an toàn:**
  - Dừng sau G4; không làm G5.
  - Không sửa binary hay cấu hình chính của Antigravity IDE (`D:\Antigravity IDE`).
  - Không commit/push lên git remote.

