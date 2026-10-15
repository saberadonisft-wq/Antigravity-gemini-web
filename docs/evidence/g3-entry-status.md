# Báo Cáo Trạng Thái Bắt Đầu G3 (G3 Entry Status)

**Thời điểm:** 14/10/2026  
**Môi trường:** Windows 11 x64, Node v24.18.0, Python 3.13.6, Antigravity IDE v1.107.0 (isolated test profile)

**Ghi chú sau Codex review:** Đây là mốc entry lịch sử, không phải báo cáo nghiệm thu hiện tại. Xem [g3-codex-remediation-validation.md](g3-codex-remediation-validation.md) và [G3_CODE_REVIEW.md](G3_CODE_REVIEW.md). Native launch dựa trên evidence trước; login metadata dưới đây chưa được refresh bằng format probe hiện tại, không dùng làm bằng chứng live mới.

---

## 1. Kiểm Kê Thực Trạng Kỹ Thuật (Current State Verification)

Trước khi triển khai G3, toàn bộ các bản vá Codex và kết quả kiểm thử hồi quy được kiểm tra xác thực thực tế:

| Thành phần / Bộ kiểm thử | Số lượng bài test | Kết quả | Ghi chú kỹ thuật |
|---|---|---|---|
| **TypeScript Contracts** (`@antigravity-gemini-web/contracts`) | 8 | **PASS** | Zod schemas, discriminated unions command/ack/event |
| **TypeScript Gemini Browser** (`@antigravity-gemini-web/gemini-browser`) | 20 | **PASS** | Gồm fixture lifecycle (3 turns + cancel), F1 driver đóng, 13 concurrency/lifecycle tests mới của Codex, V2–V6 regressions |
| **TypeScript Model Bridge** (`@antigravity-gemini-web/model-bridge`) | 4 | **PASS** | EnvelopeParser (inspectSyntax vs parseForExecution), LiveModelBridgeStub |
| **TypeScript Native Adapter** (`@antigravity-gemini-web/native-antigravity`) | 1 | **PASS** | Trạng thái `unverified`, không fake success |
| **TypeScript Runtime** (`@antigravity-gemini-web/runtime`) | 17 | **PASS** | Recursive fingerprinting, in-flight reservation, terminal turn immutability, epoch retirement |
| **Tổng số TypeScript Tests** | **50** | **50/50 PASS** | Thời gian chạy ~6s, typecheck sạch, lint sạch |
| **Python Probe Safety Tests** (`test_probe_safety.py`) | 4 | **PASS** | Kiểm tra redaction marker nhạy cảm, queue allowlist, sanitized flags, dripping body timeout |
| **Python Probe Timeout Verification** (`verify_probe_timeout.py`) | 3 | **PASS** | V7 log sanitization, V8 mock incomplete body timeout (1.01s), silent-child termination (3.06s) |
| **Python Shim Tests** (`test_shim.py`) | 9 | **PASS** | H1 metadata sanitization, H2 Win32 broken pipe code 128 |

---

## 2. Phân Định Rõ Ràng Giữa Thực Nghiệm (Fixture) và Trạng Thái Live

| Hạng mục | Trạng thái | Minh chứng & Blocker thực tế |
|---|---|---|
| **G2-A (Nền tảng Runtime & Contracts)** | **PASS** | Đạt 100% kiểm thử tự động, không có fake success. |
| **G2-B.Launch (Transparent Shim)** | **PASS (Launch Hook Only)** | IDE (PID 10168) → `antigravity_shim.exe` (PID 4716) → `language_server_windows_x64.exe` (PID 19824). Windows Job Object quản lý dọn dẹp tiến trình. |
| **G2-B.Inference (Native Inference Route)** | **UNRESOLVED / NOT_TESTED** | **Blocker:** Language Server standalone startup/readiness (`TIMEOUT_OR_NO_PORT`, cổng lắng nghe `null`, `rpc_attempted=false`). Thiếu handshake khởi tạo từ IDE cha là giả thuyết cần kiểm chứng qua so sánh có kiểm soát. |
| **G2-C.Driver (CDP & DOM Fixture)** | **PASS** | 20 bài kiểm thử trên DOM fixture và mock targets đạt 100%. Đã khắc phục triệt để các vấn đề race condition, reservation trước await, và dọn dẹp file lock trên Windows. |
| **G2-C.Live (Gemini Web Live Session)** | **NEEDS_USER_ACTION** | **Blocker:** Profile độc lập `C:\Users\vhc\.gemini\gemini_web_probe_profile` chưa có phiên đăng nhập Google. Probe thực nghiệm ghi nhận `isAllowedSurface: true`, `url: "https://gemini.google.com/app"`, `accountState: "needs_user_action"`. Cần người dùng đăng nhập thủ công 1 lần. |
| **G2-D / G2-E (End-to-End Live)** | **NOT_TESTED** | Bị chặn bởi cả G2-B (inference) và G2-C (live session) chưa sẵn sàng đồng thời. |

---

## 3. Kế Hoạch Triển Khai G3 (G3 Plan & Scope Boundaries)

Theo yêu cầu trong `docs/GEMINI_G3_PROMPT.md`:
1. **G3-A (Độ bền, Phục hồi và Ngữ cảnh trên Controlled Fixtures):**
   - Được triển khai độc lập trên các fixture có kiểm soát.
   - Chuẩn hóa state machine và thẩm quyền của host tool inventory.
   - Ràng buộc workspace identity, session, turn và conversation.
   - Cơ chế recovery: Journal nguyên tử, phát hiện disconnect/crash, không auto-replay accepted/unknown mutation.
   - Quản lý ngữ cảnh (Context Manager): Cấu trúc hóa context từ host, không cắt ngầm (no silent dropping), ước tính budget token/byte có nhãn rõ ràng, từ chối trộn lẫn workspace.
   - Bộ kiểm thử hành vi G3-A toàn diện.
2. **G3-B (Nghiệm thu Live):**
   - Chỉ được kích hoạt khi cả hai gate G2 thật (Native Inference và Live Web) đủ điều kiện.
   - Tuyệt đối không đánh tráo bài test fixture thành chứng nhận pass gate live.
3. **Nguyên tắc An Toàn:**
   - Giữ nguyên toàn bộ các bản vá Codex đã thực hiện.
   - Không can thiệp binary hay cấu hình chính của Antigravity IDE (`D:\Antigravity IDE`).
   - Không tự động sao chép cookie của profile cá nhân.
   - Dừng đúng phạm vi G3; chưa thực hiện G4–G5.

