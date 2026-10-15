# Antigravity-gemini-web

Dự án nghiên cứu và tích hợp Gemini Web làm nguồn suy luận trong chat native của Antigravity IDE, bảo toàn luồng executor và quyền công cụ của IDE.

**Trạng thái hiện tại (15/10/2026):** đã triển khai native provider cho **Antigravity IDE 2.5.5** bằng proxy loopback và profile riêng. **Chat native → Gemini Web thật → trả lời**, cùng **native view_file → kết quả → Gemini trả lời đúng bytes file**, đã PASS. [Chạy bản native](docs/NATIVE_SETUP.md). Sửa file/chạy test, cancellation và compaction native có phạm vi nghiệm thu riêng.

**Độ trễ còn cần khắc phục:** lượt người dùng gửi “alo” sau đó đã TIMEOUT ở browser adapter với 0 ký tự phản hồi. Bản này vẫn gửi đầy đủ context vào chat mới mỗi generation và chờ output hoàn tất; chưa có giữ phiên/delta, stream native hoặc chọn model/effort Web tự động. [Ghi nhận sự cố](docs/evidence/mcp/native-latency-incident.json). Các ca PASS ở trên không chứng nhận độ ổn định hoặc hiệu năng tổng quát.

**MCP:** đã có browser MCP, host-task broker, reverse HTTP MCP và **OAuth gateway kiểm chứng local** (DCR, owner consent, PKCE, refresh/revoke). **3 lượt browser chat Google thật qua MCP PASS**. Chưa deploy HTTPS public hoặc nối reverse connector với Gemini thật. [Cài MCP](docs/MCP_SETUP.md), [chạy gateway](docs/MCP_GATEWAY_SETUP.md). Host-agent pump vẫn cần agent IDE; native provider mới là đường riêng, không phụ thuộc Google reverse connector.

Sau cài lại IDE, đã bật/đăng ký lại và xác nhận trực tiếp trong Manage MCP Servers: **host 4/4 + browser 5/5 = 9 tools**, cả hai Enabled. Đây là IDE discovery PASS, chưa native tool/Gemini connector E2E.

Đã sửa ownership/EOF: entries ưu tiên native IDE qua AG_MCP_TARGET_CLIENT; nhiều client chia sẻ một runtime owner cho mỗi profile/state, giữ receipt deduplication và task authority. [ADR runtime dùng chung](docs/adr/0007-shared-mcp-runtime.md). Báo cáo client-routing cũ là snapshot trước thay đổi này.

**IDE → MCP → Gemini Web → IDE đã PASS**: agent IDE gửi prompt và nhận đúng `MCP_OK`; đã đối chiếu receipt terminal và DOM phản hồi thực tế. [Bằng chứng MCP](docs/evidence/mcp/ide-browser-roundtrip.json). Kiểm chứng native provider mới được ghi riêng tại [native validation](docs/evidence/g4-native-provider-validation.md).

- **G4-A:** Các bản vá operation/cancel/config/Settings giữ nguyên; đã bổ sung actual SDK second-instance, pending reload/navigation/close, owned Chrome crash/reconnect, đủ 10 rendered UI scenarios, keyboard/system/reduced-motion và native Save/Cancel dialog. [Nghiệm thu mới](docs/evidence/g4-acceptance-validation.md).
- **Startup cache:** Đã sửa instance phụ khởi tạo Chromium khi quit, cấu hình shell/session cache riêng trước ready và bổ sung kiểm tra launch/second-instance/restart. [Bản vá cache](docs/evidence/g4-electron-cache-validation.md). Đóng instance cũ trước khi chạy lại launcher.
- **Giới hạn:** Chrome page activation chưa chứng minh Windows foreground; 576 contrast measurements không chứng nhận WCAG toàn ứng dụng hoặc “0 flaky”. Fixture không thay bằng chứng Google/native live.
- **G4-B:** Native picker, chat và vòng đọc file đã PASS với IDE/Gemini Web thật qua provider mới. Sửa file/chạy test, cancel và long-context cần nghiệm thu riêng; chưa G5. Các báo cáo G2/G3 bên dưới giữ nguyên phạm vi lịch sử của standalone/shim probes.

- **G2-B / G3-B (Cổng Native IDE & Launch Hook):**
  - **Launch Hook (`machineLanguageServerBinaryPath`):** **PASS**. Prototype `antigravity_shim.exe` (C# .NET 4.8) khởi chạy thành công trong Antigravity IDE v1.107.0 (profile cô lập): IDE (PID 10168) → `antigravity_shim.exe` (PID 4716) → `language_server_windows_x64.exe` (PID 19824). Chuyển tiếp 100% tham số, quản lý lifecycle bằng Windows Job Object và xử lý Win32 broken pipe.
  - **Standalone/shim inference, snapshot G2/G3:** **UNRESOLVED / NOT_TESTED**. Probes khi đó chưa phát hiện listening port và chưa RPC. Provider mới dùng endpoint Cloud Code của IDE đã vượt qua chat/read-file acceptance; xem [hướng dẫn native](docs/NATIVE_SETUP.md).
- **G2-C / G3-B (Cổng Trình duyệt Gemini Web):**
  - **Browser package:** **24/24 tests PASS**, gồm fresh-tab isolation, cây tiến trình Windows thật và các regression trước. Có reservation trước await, coalesced submit/poll/cancel, terminal bất biến, cleanup epoch, outcome unknown không resend và surface allowlist. Fixture acceptance độc lập với Google live.
  - **Live Gemini Web:** **PASS 3 browser turns qua MCP** trên profile launcher đã signed-in. Custom MCP app chiều Gemini gọi host vẫn NOT_OBSERVED/NOT_TESTED; xem [MCP validation](docs/evidence/g4-mcp-validation.md).
- **Native live hiện tại:** chat và view_file roundtrip PASS. Ma trận sửa file/chạy test/cancel chưa hoàn tất; Google reverse connector vẫn chưa kết nối nhưng không chặn provider native mới. Chưa G5.

---

## 1. Cấu trúc Monorepo

Dự án sử dụng npm workspaces (`Node.js >= 22`, `npm >= 10`):

- [`packages/contracts`](packages/contracts): Nguồn chuẩn duy nhất định nghĩa Zod schemas, TypeScript types, discriminated unions cho command/ack/events, và interface `LauncherClient` (v0.1).
- [`packages/runtime`](packages/runtime): Runtime control thử nghiệm, client/resync, `RuntimeFacade`, và G3 context/journal/session coordinator. Coordinator gọi preflight/journal; native chat orchestration chưa có. Live snapshot loại bỏ metadata mô phỏng và chặn commands chưa có provider.
- [`packages/native-antigravity`](packages/native-antigravity): Native Cloud Code proxy, model catalog, browser backend và CLI chạy trên profile riêng. Adapter launcher cũ giữ gate thận trọng; xem bằng chứng provider độc lập.
- [`packages/gemini-browser`](packages/gemini-browser): Trình điều khiển CDP client và browser adapter cho Gemini Web với đầy đủ typed contract: `submitPrompt`, `pollResponse`, `cancelPrompt`, `cleanup`, turn reservation, và surface allowlist.
- [`packages/model-bridge`](packages/model-bridge): Bộ phân tích cú pháp tool call envelope (`antigravity-tool`), phân tách giữa kiểm tra cú pháp `inspectSyntax` và kiểm tra thẩm quyền `parseForExecution` với host tool inventory và call ledger.
- [`packages/mcp-server`](packages/mcp-server): Browser/host stdio MCP, task broker và gateway OAuth tới các web tools của task. Gateway cần HTTPS deployment và Google custom-app acceptance riêng.
- [`apps/launcher`](apps/launcher): Desktop Launcher (React 18 + Vite) với Preload IPC security bridge, 10 mock contract scenarios, và giao diện Onboarding / Overview / Sessions / Activity / Settings.

---

## 2. Cài đặt và Chạy Kiểm thử Toàn diện

Không yêu cầu API key, token bí mật hay đăng nhập tài khoản Google để chạy toàn bộ test suite cục bộ:

```bash
# 1. Cài đặt dependencies và liên kết các workspaces
npm install

# 2. Biên dịch toàn bộ TypeScript các packages và apps
npm run build

# 3. Kiểm tra kiểu tĩnh strict mode
npm run typecheck

# 4. Kiểm tra lint (hiện cùng tsc --noEmit, chưa có rules riêng)
npm run lint

# 5. Chạy các bài kiểm thử TypeScript across workspaces
npm test

# 6. Chạy unit tests cho Shim suite (bao gồm H1/H2 regressions)
python -m unittest tools/probes/g2/shim/test_shim.py

# 7. Chạy probe verifications (V7 sanitization, V8 mock timeout, silent child)
python tools/probes/g2/verify_probe_timeout.py

# 8. Probe safety: metadata logging và HTTP shutdown
python -m unittest tools/probes/g2/test_probe_safety.py
```

Sau build, mở launcher desktop thật hoặc chạy smoke:

~~~powershell
npm run launcher
npm run launcher:demo
npm run test:desktop
~~~

Demo thuần browser: `npm run dev --workspace=@antigravity-gemini-web/launcher`, rồi mở `http://127.0.0.1:5173/?mode=demo`. URL thiếu demo flag/preload hiện lỗi. Python counts trong evidence Gemini trước không rerun ở đợt Codex G4 này. Desktop smoke không cần Google login.

---

## 3. Tài liệu Tham khảo & Báo cáo

- **Tài liệu & Báo cáo G4:**
  - [Hướng dẫn tự test bản G4](docs/G4_USER_TEST_GUIDE.md)
  - [Nghiệm thu mới: 148 tests + Electron/Chrome/Windows dialog acceptance](docs/evidence/g4-acceptance-validation.md)
  - [Review continuation và các bản vá Codex](docs/evidence/G4_CONTINUE_CODE_REVIEW.md)
  - [Snapshot remediation trước: 146 tests + React/Electron smoke](docs/evidence/g4-codex-followup-validation.md)
  - [Review G4 và các bản vá](docs/evidence/G4_CODE_REVIEW.md)
  - [Kiểm chứng Codex: 119 tests và Electron desktop thật](docs/evidence/g4-codex-remediation-validation.md)
  - [Prompt Gemini tiếp tục G4, chưa G5](docs/GEMINI_G4_CONTINUE_PROMPT.md)
  - [ADR 0004: Launcher IPC và Runtime Ownership (G4)](docs/adr/0004-launcher-ipc-and-runtime-ownership.md)
  - [Báo cáo Kiểm chứng IPC Launcher & Runtime Facade (G4-A)](docs/evidence/g4-launcher-ipc-validation.md)
  - [Báo cáo Kiểm chứng UI Launcher (G4-A)](docs/evidence/g4-ui-validation.md)
  - [Báo cáo Đánh giá Nghiệm thu Live và Rào cản Kỹ thuật (G4-B)](docs/evidence/g4-live-validation.md)
  - [Báo cáo Trạng thái Bắt đầu G4 (Entry Status)](docs/evidence/g4-entry-status.md)
  - [Ghi chú UI và Trợ năng Launcher](apps/launcher/renderer/UI_NOTES.md)
  - [Yêu cầu & Đề xuất Hợp đồng G4](apps/launcher/renderer/CONTRACT_REQUESTS.md)
  - [Hướng dẫn Sử dụng Launcher](apps/launcher/README.md)
- **Tài liệu & Báo cáo G3:**
  - [Review G3 và các findings đã sửa](docs/evidence/G3_CODE_REVIEW.md)
  - [Bản vá Codex G3, kết quả và API hiện tại](docs/evidence/g3-codex-remediation-validation.md)
  - [Prompt Gemini G4: launcher, IPC và backend](docs/GEMINI_G4_PROMPT.md)
  - [Báo cáo Trạng thái Bắt đầu G3 (Entry Status)](docs/evidence/g3-entry-status.md)
  - [ADR 0003: Chính Sách Quản Lý Phiên, Phục Hồi Lỗi và Ngữ Cảnh (G3)](docs/adr/0003-session-recovery-context-policy.md)
  - [Báo cáo Kiểm Chứng Độ Bền và Phục Hồi Lỗi (G3-A Resilience Validation)](docs/evidence/g3-resilience-validation.md)
  - [Báo cáo Kiểm Chứng Quản Lý Ngữ Cảnh (G3 Context Validation)](docs/evidence/g3-context-validation.md)
  - [Báo cáo Nghiệm Thu Live và Rào Cản Kỹ Thuật (G3-B Live Validation)](docs/evidence/g3-live-validation.md)
  - [Bản vá Codex và kết quả kiểm chứng G2](docs/evidence/g2-codex-remediation-validation.md)
  - [Prompt Gemini G3](docs/GEMINI_G3_PROMPT.md)

- **Báo cáo G2:**
  - [Báo cáo Khảo sát Khả thi Transparent Shim & Inference Hook (G2 Spike)](docs/evidence/g2-shim-feasibility.md)
  - [Tài liệu Thiết kế & Kiểm thử Shim PoC](tools/probes/g2/shim/README.md)
  - [Báo cáo Khắc phục Code Review G2 (G2-A Remediation)](docs/evidence/g2-review-remediation.md)
  - [Báo cáo Đánh giá Khả thi Native & Browser Gates (G2-B & G2-C)](docs/evidence/g2-native-browser-gates.md)
  - [Báo cáo Nghiệm thu End-to-End G2 (G2-D & G2-E Validation)](docs/evidence/g2-end-to-end-validation.md)
  - [ADR 0002: Đánh giá Giao thức Native và Cơ chế Điều khiển Gemini Web](docs/adr/0002-g2-native-and-browser-gate-findings.md)
- **Lịch sử G0 & G1:**
  - [Báo cáo Kiểm chứng Nền tảng G1](docs/evidence/g1-foundation-validation.md)
  - [Báo cáo Khắc phục Review G1](docs/evidence/g1-review-remediation.md)
  - [Review Code G1](docs/evidence/G1_CODE_REVIEW.md)
  - [Review Code G2](docs/evidence/G2_CODE_REVIEW.md)
  - [Báo cáo Khả thi Native G0](docs/evidence/native-feasibility.md)
  - [Review Code G0](docs/evidence/G0_CODE_REVIEW.md)
  - [ADR 0001: Hợp đồng UI-Runtime v0.1 và Fake Runtime](docs/adr/0001-g1-contracts-and-fake-runtime.md)

Repo tham khảo: [miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web) (snapshot `889f291d06339400a8b9c2941473f65cd47d4830`). Tái sử dụng mã phải giữ attribution/license tương ứng.
