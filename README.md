# Antigravity-gemini-web

Dự án nghiên cứu và tích hợp Gemini Web làm nguồn suy luận trong chat native của Antigravity IDE, bảo toàn luồng executor và quyền công cụ của IDE.

**Trạng thái source (19/10/2026):** Native **40 / browser worker 25** có tài khoản cách ly, receipt/fence bền vững, quản lý nguồn dự án, preview ZIP và kiểm tra trang import theo tài khoản, cùng tùy chọn semi-space Node mặc định tắt. Bản 40 sửa phạm vi model context: 3.8 chỉ dùng cho lần nạp đầy đủ; append/patch/replace dùng model chính. [Bằng chứng và giới hạn](docs/evidence/g4-native-r40-context-model-scope.md), [chạy và test nhanh](docs/NATIVE_TEST_QUICKSTART.md), [thiết lập native](docs/NATIVE_SETUP.md). Bằng chứng chat/view_file/stream/cancel trên Web và IDE thật thuộc các revision trước. Luồng context 3.8 → model chính cần nghiệm thu lại; Secondary bị Google từ chối đăng nhập, hai tài khoản thật, executor đầy đủ và các gate P6–P8 chưa hoàn tất. Các đoạn revision cũ dưới đây được giữ làm lịch sử kiểm chứng.

P7a/P7b có [kiểm tra ZIP trước khi import lịch sử](docs/NATIVE_CHAT_IMPORT.md): CLI offline và màn hình Nhập lịch sử thử nghiệm (`AG_NATIVE_IMPORTS_EXPERIMENTAL=1`). Preview gắn tài khoản/epoch, có tiến độ và hủy; chưa upload tới Google hoặc chứng nhận chuyển Gemini A → B.

**Bản native revision 12:** build monorepo đã PASS. Proxy lưu metadata riêng tư để khởi động lại rồi gắn lại đúng tab; lượt đầu sau khôi phục gửi full snapshot, sau đó tiếp tục append/patch. Một số mô tả tool chuẩn được rút gọn trong prompt, còn schema đầy đủ vẫn validate local. Batch tool chỉ bật tường minh qua `AG_NATIVE_BATCH_TOOL_CALLS=1`, giới hạn ở đọc `view_file`. Soft resync chỉ giữ base khi có bằng chứng lỗi xảy ra trước Send. Test suite chưa chạy lại cho revision 12 và các thay đổi chưa nghiệm thu live; giữ **4 Argon / Low** theo cấu hình.

**Bằng chứng trước revision 12:** 226/226 tests local PASS trên snapshot trước các thay đổi mới. Native chat, đọc file, stream/cancel, resume URL và tối ưu delta có các giới hạn nghiệm thu được ghi tại [NATIVE_SETUP](docs/NATIVE_SETUP.md). Bộ sửa file/chạy lệnh G4-B chưa nghiệm thu; script fixture mới có `prepare`/`verify` để người dùng đối chiếu receipt IDE, file thật và kết quả checker. Revision 12 build sạch nhưng chưa chạy test suite, không có bằng chứng live mới và không được xem là G4-B PASS.

**Native đọc file:** revision 8 đã PASS hai vòng `view_file` → functionResponse → final trên IDE/Gemini Web thật, gồm lượt tiếp nối sau khi đóng tab Gemini ban đầu. IDE hiển thị đúng hai marker chỉ có trong file và receipt native tương ứng; 4 browser requests completed, 0 failed. [Bằng chứng](docs/evidence/g4-native-retained-tab-validation.md). Sửa file/chạy lệnh vẫn chưa nghiệm thu trong lần này.

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
  - **Browser package:** Có fresh-tab isolation, retained target, verified model/effort, DOM progress, cancellation và cây tiến trình Windows thật. Reservation trước await, terminal bất biến, cleanup epoch, outcome unknown không resend và surface allowlist được giữ. Fixture acceptance độc lập với Google live.
  - **Live Gemini Web:** **PASS 3 browser turns qua MCP** trên profile launcher đã signed-in. Custom MCP app chiều Gemini gọi host vẫn NOT_OBSERVED/NOT_TESTED; xem [MCP validation](docs/evidence/g4-mcp-validation.md).
- **Native live hiện tại:** chat và view_file roundtrip PASS. Ma trận sửa file/chạy test/cancel chưa hoàn tất; Google reverse connector vẫn chưa kết nối nhưng không chặn provider native mới. Chưa G5.

---

## 1. Cấu trúc Monorepo

Dự án sử dụng npm workspaces (`Node.js 22.13+ (22.x) hoặc 24+`, `npm >= 10`):

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



cd D:\Antigravity-gemini-web
npm run native:launch


Multi-account native (từ revision 23; source hiện revision 36 / browser worker 23): mở và đăng nhập từng profile bằng `npm run native -- account:browser "Tên account"`, rồi chạy `npm run native -- account:verify "Tên account"` trước khi dùng. Chọn account bằng `account:use`; xem [hướng dẫn native](docs/NATIVE_SETUP.md) và [trạng thái nghiệm thu P1/P2](docs/evidence/g4-native-p1-p2-safety-validation.md). Hai tài khoản thật và executor IDE vẫn cần nghiệm thu riêng.

Theo yêu cầu ngày 18/10, CLI mặc định dùng **3.8 Flash chỉ để nạp context ban đầu**, rồi khôi phục model/Thinking level chính trước COMMIT. Các lượt patch tiếp theo dùng model chính. Có thể tắt bước tách model bằng `$env:AG_NATIVE_CONTEXT_MODEL = 'off'` trước khi khởi động proxy. [Chi tiết và giới hạn nghiệm thu](docs/evidence/g4-native-context-bootstrap-model.md): menu Web đã pass chọn/khôi phục không Send; luồng native mới chưa pass live vì còn lỗi capture và sau đó Google yêu cầu xác minh lưu lượng. Runtime đang chạy revision 29; bản sửa context revision 30 (có trong source 36) chưa nạp trong lúc chờ người dùng xác minh.

P3 upload snapshot vẫn thử nghiệm, mặc định tắt. Revision 28 đã pass đủ ba bước native ở 145k và 261k; 78k follow-up và 28k cold startup còn lỗi nên chưa đạt gate 10 vòng. Xem [báo cáo P3 cùng các mẫu pass/fail](docs/evidence/g4-native-p3-context-transport-spike.md).

Source 32 thêm mục **Tài khoản Web** trong launcher: thêm profile, mở đăng nhập, kiểm tra danh tính, chọn/tạm ngưng tài khoản, theo dõi lượt đang chạy, hủy và đánh dấu nối hội thoại. Thao tác đi qua native owner API; launcher không tạo pool riêng. [P5 và giới hạn nghiệm thu](docs/evidence/g4-native-p5-account-management.md). Runtime 29 đang giữ cửa sổ Google xác minh nên chưa nạp UI/API mới.

P4 đã có store physical receipt SQLite và tra cứu sau restart trong source mới; 2.100 lượt fixture cùng migration toàn bộ 2.048 receipt cũ đã pass. Ngày 17/10 runtime revision 27 / worker 19 đã verify Default Account và giữ đủ ledger thật 135 receipt; kiểm tra read-only pass, không gửi prompt. Live vẫn manual; các mode tự động chỉ có sau cờ thử nghiệm, source 31 đã có failover hữu hạn chỉ khi có bằng chứng chưa Send, mặc định tắt; HTTP + MCP + SQLite fixture đã pass, chưa nghiệm thu hai account Web thật. [Bằng chứng failover](docs/evidence/g4-native-p4-failover.md). [Trạng thái router](docs/evidence/g4-native-p4-routing.md). Xem [bằng chứng và phần P4 còn lại](docs/evidence/g4-native-p4-physical-ledger.md).

Khôi phục account, binding, receipt, model restoration và rollback bằng cấu hình: [Native recovery runbook](docs/NATIVE_RECOVERY_RUNBOOK.md). Source 33 thu hồi cache hết TTL cả ở đường đọc; việc hết kết quả RAM không xóa fence hoặc cho phép Send lại. Runtime đang giữ cửa sổ Google vẫn chưa reload.

Source 35 có **Nguồn dự án** trong launcher và CLI, mặc định tắt. Import file qua chooser của main hoặc GitHub checkout local qua CLI, xem filenames/hash/commit/overlay, kiểm tra/refresh snapshot và gắn nguồn riêng theo chat/account/epoch. File stale bị loại; không đổi request ID để gửi lại. Electron/IPC/HTTP fixture và hồi quy desktop đã pass; browser và chooser grant giả lập, chưa phải Web/IDE thật. [Hướng dẫn](docs/NATIVE_KNOWLEDGE.md), [báo cáo và ảnh UI](docs/evidence/g4-native-p6b-project-knowledge-ui.md). Gem/Notebook/Drive/GitHub Web vẫn chỉ đăng ký metadata chưa xác minh; P6 còn các adapter Web và gate chất lượng/live.

Source 36 sửa cleanup của backend gắn account: release thành công bỏ ownership metadata, BUSY vào queue đúng owner và giữ yêu cầu preserve mạnh hơn. Thêm giới hạn metadata/cached worker handles, health `backendResources` và shutdown terminal. Probe pool tổng hợp 10.000 vòng đã có before/after; đây chưa phải soak RAM nhiều MCP/Chrome thật. [Bằng chứng P8a và các gate còn mở](docs/evidence/g4-native-p8a-pool-lifecycle.md).

Checkpoint ngày 19/10: build/typecheck/lint và **406 test toàn workspace đã PASS**, cùng fixture CLI/MCP/SQLite và Electron. [Báo cáo kiểm thử, phạm vi commit và phần còn lại](docs/evidence/native-r36-commit-validation.md). Các gate Web/IDE thật, P6/P7 và độ bền P8 vẫn được giữ trong kế hoạch.

Đợt source 33 đã chạy CLI/Electron với process crash/restart và TTL thật khoảng 601 giây, giữ đúng receipt/fence; browser trong bài thử được giả lập. [Kết quả và ranh giới](docs/evidence/g4-native-p5-lifecycle-cache-expiry.md).
