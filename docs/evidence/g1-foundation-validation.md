# Báo cáo Kiểm chứng Nền tảng G1 (G1 Foundation Validation)

- **Thời điểm hoàn thành ban đầu:** 14/10/2026 12:26 (UTC+7).
- **Thời điểm cập nhật theo Review G1 (F1–F9):** 14/10/2026 12:50 (UTC+7).
- **Môi trường thực thi & Phiên bản Resolved (từ `npm ls --depth=0`):**
  - Node.js: v24.18.0 (LTS trên Windows 11).
  - npm: 11.16.0 (npm workspaces).
  - TypeScript: v5.9.3 (strict mode, NodeNext module resolution, composite references).
  - Zod: v3.25.76.
  - @types/node: v22.20.5.
  - Python: 3.13.6 (cho bộ probe G0).

---

## 1. Trạng thái Gate Dự án

| Gate | Trạng thái | Đánh giá & Rào cản còn lại |
|---|---|---|
| **G0 (Native Feasibility Gate)** | **UNRESOLVED / NOT MET** | Control-plane route (`POST /v1internal:fetchUserInfo`) đã quan sát được qua `JETSKI_SERVICE_ENDPOINT_URL`. Tuy nhiên, inference route (`StreamGenerateContent` / `StartCascade`) **chưa được chứng minh**. Khả năng MCP trên Gemini Web chưa được thử nghiệm trên tài khoản cá nhân người dùng (dừng trước login). IDE chưa mở extension point cho custom model trong chat native. |
| **G1 Foundation (Scaffold, Contracts, Fake Runtime)** | **REMEDIATED & VALIDATED (G1 foundation complete; G0/native gate unresolved)** | Đã hoàn thành 5 packages monorepo, Zod contracts v0.1 strict boundaries, FakeRuntimeEngine với deduplication chuẩn hóa fingerprint (type + canonical payload), fan-out event distribution, settings revision checks, event sequence resync, live stubs không fake success. Đã xử lý toàn bộ 9 findings (F1–F9). 22/22 tests TypeScript & 6/6 tests Python pass. |

Chi tiết xử lý 9 findings và các kịch bản regression xem tại: [`docs/evidence/g1-review-remediation.md`](g1-review-remediation.md).

---

## 2. Các File đã tạo & Thay đổi

### 2.1. Cấu hình Gốc Monorepo
- `package.json`: Khai báo npm workspaces (`packages/*`), scripts nghiêm ngặt không dùng fallback lỏng lẻo (`build`, `typecheck`, `lint`, `test`, `dev:mock`).
- `tsconfig.base.json`: Cấu hình TypeScript nền tảng (`strict: true`, `NodeNext`, `isolatedModules: true`).
- `tsconfig.json`: File tổng hợp project references đến 5 package.
- `README.md`: Bổ sung hướng dẫn clone, install và chạy `dev:mock` không cần API key hay đăng nhập.

### 2.2. Package `@antigravity-gemini-web/contracts`
- `src/version.ts`: Literal version `"0.1"`.
- `src/errors.ts`: `UiErrorCodeSchema`, `SuggestedActionSchema`, `UiErrorSchema`.
- `src/capabilities.ts`: `CapabilityKeySchema`, `CapabilityStateSchema`, `CapabilityMapSchema`.
- `src/models.ts`: `ModelInfoSchema`.
- `src/sessions.ts`: `TurnStateSchema`, `TurnSummarySchema`, `SessionSummarySchema`, `isTerminalTurnState`.
- `src/settings.ts`: `SettingsSchema`, `SettingsPatchSchema`.
- `src/checks.ts`: `CheckResultSchema`, `CheckStatusSchema`.
- `src/snapshot.ts`: `RuntimeSnapshotSchema` chuẩn hóa toàn diện.
- `src/commands.ts`: `ControlCommandSchema` và `CommandAckSchema` (Zod discriminated unions, `.strict()` trên cả outer object và payload, bổ sung `CommandTypeSchema`).
- `src/operations.ts`: `OperationRecordSchema` (gán `type` theo `CommandTypeSchema`, `result` typed bằng `OperationResultSchema`).
- `src/activity.ts`: `ActivityEntrySchema`, `ActivityQuerySchema`, `createPageSchema(itemSchema)` (đều có `.strict()`).
- `src/events.ts`: `RuntimeEventSchema` được biến đổi thành **discriminated union trên `type`** với payload đã được kiểm chứng schema chặt chẽ (F4).
- `src/client.ts`: Interface tiêu chuẩn `LauncherClient`.
- `src/contracts.test.ts`: 7 unit tests kiểm tra validation boundary, F4 regressions.

### 2.3. Package `@antigravity-gemini-web/native-antigravity`
- `src/index.ts`: Interface `NativeAntigravityAdapter` và implementation `LiveNativeAntigravityAdapter`.
- `src/native.test.ts`: Kiểm chứng live adapter luôn trả capability `unverified` với mã `NATIVE_ROUTE_UNVERIFIED` và reject `applyBridge`.

### 2.4. Package `@antigravity-gemini-web/gemini-browser`
- `src/index.ts`: Interface `GeminiBrowserAdapter` và implementation `LiveGeminiBrowserAdapter`.
- `src/browser.test.ts`: Kiểm chứng live adapter trả trạng thái ban đầu `accountState: "unknown"`, `browserState: "closed"`, và `openBrowser()` trả `opened: false` khi chưa có live driver (F1).

### 2.5. Package `@antigravity-gemini-web/model-bridge`
- `src/index.ts`: `EnvelopeParser` chỉ bóc tách JSON envelope có cấu trúc và đúng marker ```antigravity-tool (bỏ qua fenced ```json thường), xác minh authority binding (`sessionId`, `turnId`, `requestNonce`) và schema tham số tool (`read_file`, `list_dir`) (F7).
- `src/bridge.test.ts`: 3 tests kiểm chứng parser bỏ qua code block python & json thường, xác minh binding authority và argument schema.

### 2.6. Package `@antigravity-gemini-web/runtime`
- `src/paths.ts`: Phân tách ranh giới DEV/demo (`<tmp>`) và Live (`<home>/.gemini/...`), hàm `assertNoPathOverlap` kiểm tra canonical paths, Windows case-insensitivity, cross-field và containment (F8).
- `src/scenarios.ts`: 9 kịch bản kiểm thử (`first_run`, `login_required`, `native_unverified`, `generating`, `tool_running`, `cancel_pending`, `disconnected`, `config_conflict`, `outcome_unknown`).
- `src/fake-runtime.ts`: Engine in-process thực thi deduplication dựa trên fingerprint chuẩn hóa (`type` + canonical payload), reject conflict cả in-flight và completed (F2); quản lý revision và sequence nhất quán qua transaction `commitSnapshotChange` (F5); từ chối fake success khi ở live mode (F1).
- `src/in-process-client.ts`: `InProcessLauncherClient` chuyển sang mô hình single-engine subscription + fan-out (F3), đồng thời validate schema `createPageSchema` tại các methods `getSessions()` và `getActivity()` (F4).
- `src/mock-client.ts`: `MockLauncherClient` có nhãn `"Demo · dữ liệu mô phỏng"`.
- `src/demo.ts`: Harness chạy kịch bản demo mẫu.
- `src/runtime.test.ts`: 10 bài kiểm tra hành vi chuyên sâu (dedup, concurrent in-flight conflict, revision conflict, non-terminal cancel, fan-out event distribution, sequence gap resync, path containment, live unverified rejection, snapshot watermark matching).

### 2.7. Bộ Probe G0 (`tools/probes/g0`)
- `safe_logging.py`: Class `SafeProbeLogger` ghi log allowlist metadata.
- `test_start_cascade_details.py`: Phân định rõ 4 tiêu chí riêng biệt (`readiness`, `control_plane_route_observed`, `inference_request_observed`, `token_stream_decoded`); StartCascade HTTP 400 validation failure đánh dấu status `FAILED` (F6).
- `test_aicode_endpoint.py`: Tách bạch `catalog_request_observed` và `inference_route_observed = False` (F6).
- `test_gemini_web.py`: Kiểm tra trạng thái đăng nhập dựa trên bằng chứng khẳng định (positive composer elements), không dùng phép kiểm tra phủ định (F6).
- `test_probes_unit.py`: 6 bài test mock doubles kiểm tra redaction, cleanup, timeout failure, cascade validation failure handling, và positive auth detection.

---

## 3. Các Lệnh đã Chạy & Kết quả Kiểm tra Thực tế

### 3.1. Linting Toàn Bộ Workspaces (`npm run lint`)
```text
> antigravity-gemini-web@0.1.0 lint
> npm run --workspaces lint

[contracts] tsc --noEmit -> Exit code 0
[gemini-browser] tsc --noEmit -> Exit code 0
[model-bridge] tsc --noEmit -> Exit code 0
[native-antigravity] tsc --noEmit -> Exit code 0
[runtime] tsc --noEmit -> Exit code 0
```

### 3.2. Typecheck Strict (`npm run typecheck`)
```text
> antigravity-gemini-web@0.1.0 typecheck
> npm run --workspaces typecheck

Tất cả 5 packages đều vượt qua tsc --noEmit với strict null checks và zero lỗi.
```

### 3.3. Toàn bộ Kiểm thử Tự động TypeScript (`npm run test`)
```text
> antigravity-gemini-web@0.1.0 test
> npm run --workspaces test

✔ [contracts] ControlCommandSchema accepts valid commands and rejects invalid schemas
✔ [contracts] SettingsPatchSchema strictly rejects unknown fields and accepts partial valid patches
✔ [contracts] CommandAckSchema validates accepted and rejected variants properly
✔ [contracts] RuntimeSnapshotSchema enforces schemaVersion 0.1
✔ [contracts] RuntimeEventSchema strictly validates event payloads [F4 regression]
✔ [contracts] OperationRecordSchema rejects invented operation types [F4 regression]
✔ [contracts] createPageSchema rejects unknown top-level fields [F4 regression]

✔ [gemini-browser] LiveGeminiBrowserAdapter reports unknown account and never produces fake opened: true [F1 regression]

✔ [model-bridge] EnvelopeParser strictly ignores generic json code blocks [F7 regression]
✔ [model-bridge] EnvelopeParser validates antigravity-tool marker, authority binding, and tool schemas [F7 regression]
✔ [model-bridge] LiveModelBridgeStub rejects inference routing with NATIVE_ROUTE_UNVERIFIED

✔ [native-antigravity] LiveNativeAntigravityAdapter always returns unverified status and never produces fake success

✔ [runtime] Behavior 1: Invalid schema, bad commands, and version mismatch are rejected
✔ [runtime] Behavior 2 [F2 Regression]: Deduplication compares command type and canonical payload, rejects conflicts
✔ [runtime] Behavior 2b: Settings update rejects stale revisions and accepts valid revisions
✔ [runtime] Behavior 3: Cancel command does not transition to terminal early; outcome unknown is terminal
✔ [runtime] Behavior 4 [F3 Regression]: Multiple subscribers both receive events independently via fan-out
✔ [runtime] Behavior 4b: Sequence gaps and restarts trigger snapshot resync callbacks
✔ [runtime] Behavior 5 [F8 Regression]: Path separation enforces canonical equality and containment checks
✔ [runtime] Behavior 6: Live adapters never produce fake success and maintain unverified state
✔ [runtime] Behavior 7 [F1 Regression]: Live runtime mode delegates to live adapter and rejects fake success
✔ [runtime] Behavior 8 [F5 Regression]: Snapshot sequence matches event sequence and revision increments on changes

Tổng cộng: 22/22 bài kiểm thử TypeScript pass (100%).
```

### 3.4. Kiểm thử Probe G0 Python với Mock Doubles (`python -m unittest tools/probes/g0/test_probes_unit.py`)
```text
Ran 6 tests in 9.408s
OK
- test_synthetic_redaction: Header/query token redaction đạt tiêu chuẩn metadata allowlist.
- test_spawn_failure_cleanup: Quản lý vòng đời socket & server đóng sạch sẽ khi gặp lỗi.
- test_readiness_failure_marks_failed: Timeout readiness ném ngoại lệ rõ ràng, không bao giờ đánh dấu PASS giả.
- test_screenshot_failure_driver_cleanup: Webdriver đóng sạch sẽ trong finally.
- test_cascade_validation_failure_marks_failed: [F6] StartCascade HTTP 400 validation failure đánh dấu FAILED, inference_route_verified = False.
- test_gemini_web_positive_auth_evidence: [F6] Không có composer elements -> SIGN_IN_REQUIRED, không nhận vơ SIGNED_IN.
```

### 3.5. Chạy Thử Harness Demo (`npm run dev:mock`)
```text
> antigravity-gemini-web@0.1.0 dev:mock
> node dist/demo.js

=================================================
Antigravity-gemini-web: G1 Mock Runtime Harness
=================================================
[Status] Banner: "Demo · dữ liệu mô phỏng"
[Snapshot] Instance: inst-1791957115410-4gs95, Revision: 1
[Snapshot] Integration: not_installed, NativeRoute Capability: unverified
[Snapshot] Account: unknown, Browser: closed

--- Executing browser.open ---
[CommandAck] Accepted: true, OperationId: op-1791957115419-bc21

--- Testing Deduplication: Exact same requestId and payload ---
[CommandAck] Deduplicated Accepted: true, OperationId matches: true

--- Testing Deduplication: Same requestId with conflicting payload ---
[CommandAck] Conflict Rejected: true, Error: CONFIG_CONFLICT

--- Testing Settings Update: Stale revision rejection ---
[CommandAck] Stale Settings Rejected: true, Error: CONFIG_CONFLICT

--- Testing Settings Update: Valid revision ---
[CommandAck] Valid Settings Accepted: true

--- Switching scenario to cancel_pending ---
[Scenario: cancel_pending] Turn state: cancel_requested, canCancel: false

--- Querying Activity Log ---
[Activity Log] Retrieved 1 entries
[Done] Demo completed cleanly. (Exit code 0)
```

---

## 4. Các Vấn đề Kỹ thuật Native còn Chặn G2 (Blockers for G2)

Trước khi có thể bước vào giai đoạn G2 (Native Bridge Implementation), các điều kiện sau đây **bắt buộc phải được giải quyết**:

1. **Chứng minh Giao thức Suy luận (Inference Protocol Route):**
   - Phải xác định được endpoint hoặc interception point mà `agy.exe` (v1.3.5) sử dụng để gửi token prompt khi người dùng chat trong webview của IDE.
   - Thử nghiệm G0 đã phát hiện biến `JETSKI_SERVICE_ENDPOINT_URL` chỉ nhận control-plane request `POST /v1internal:fetchUserInfo`, còn request `StartCascade` bị lỗi validation schema nội bộ (`CortexTrajectorySource is unspecified`).
   - Cần bắt và replay đúng định dạng payload protobuf ConnectRPC của `PredictionService/StreamGenerateContent` để nhận token streaming từ local server.

2. **Khả năng Đăng nhập & MCP trên Gemini Web:**
   - Trình duyệt Chrome trên profile cô lập cần được người dùng đăng nhập tài khoản Google cá nhân thực tế (18+, tiếng Anh, Keep Activity).
   - Cần kiểm chứng tài khoản đó có mở tính năng Custom Apps / MCP hay không.
   - Nếu có MCP, cần kiểm tra cơ chế mạng cho phép Gemini Web gọi về server MCP cục bộ trên máy dev (`localhost`).
   - Nếu không dùng MCP mà dùng đường Structured Envelope (Đường B), cần thiết kế cơ chế trình duyệt tự động gõ kết quả tool vào ô nhập của Gemini Web và chờ model suy luận tiếp mà không làm mất context.

3. **Khả năng Đăng ký Model trong Model Picker Native:**
   - Hiện tại, `GetAvailableModels` trả về danh mục model cứng từ Google (`gemini-3.8-flash-high`, `claude-sonnet-4-6`, `gpt-oss-120b-medium`), và RPC `GetUserSettings`/`SetUserSettings` trả về lỗi HTTP 501.
   - Cần xác định xem chat native có chấp nhận một model ảo hay phải giả lập chính model placeholder `gemini-3.8-flash-high`.

---

## 5. Kết luận & Khuyến nghị Bàn giao

- **Nền tảng G1 đã được củng cố toàn diện:** Sau khi khắc phục F1–F9, các rủi ro giả lập thành công trên live path, rò rỉ sự kiện qua cursor dùng chung, xung đột dedupe, và lỗ hổng parsing envelope đã được loại bỏ hoàn toàn và được bảo vệ bởi bộ test regression.
- **Giữ vững nguyên tắc an toàn:** Không có fake success trên các nhánh live; không lưu trữ credential hay can thiệp cấu hình IDE đang dùng.
- **Dừng lại theo yêu cầu:** Không tự ý chuyển sang G2–G5 hoặc đổi mục tiêu sang CLI/SDK/Gemini API khi chưa có chỉ đạo từ người dùng.
