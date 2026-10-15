# Báo cáo Khắc phục Code Review G2 (G2-A Remediation)

Ngày: 14/10/2026  
Mục tiêu: Xử lý triệt để findings R1–R7 từ `docs/evidence/G2_CODE_REVIEW.md`, bổ sung regression tests và xác minh toàn bộ checks nền tảng trước khi thực hiện các gate live.

---

## 1. Tóm tắt kết quả kiểm tra (Checks Summary)

| Check | Kết quả | Chi tiết |
|---|---|---|
| `npm run build` | **PASS (Exit 0)** | Build sạch 5/5 packages (`contracts`, `gemini-browser`, `model-bridge`, `native-antigravity`, `runtime`) |
| `npm run typecheck` | **PASS (Exit 0)** | 0 lỗi TypeScript trên toàn bộ workspace |
| `npm run lint` | **PASS (Exit 0)** | Hiện cấu hình `tsc --noEmit` kiểm tra static types/syntax toàn workspace |
| `npm run test` | **PASS (29/29)** | 8 contracts + 1 gemini-browser + 4 model-bridge + 1 native-antigravity + 15 runtime tests |
| `python -m unittest tools/probes/g0/test_probes_unit.py` | **PASS (6/6)** | Toàn bộ unit tests của các probes G0 (mock process, driver, cleanup) |
| `npm run dev:mock` | **PASS (Exit 0)** | Demo harness chạy mượt mà, xác minh dedupe, conflict, settings revision, cancel và activity |

---

## 2. Chi tiết xử lý Findings R1–R7

### R1 — Canonical recursive fingerprinting (Payload lồng nhau)
- **Vấn đề trước sửa:** `JSON.stringify(command.payload, Object.keys(command.payload).sort())` dùng replacer array chỉ lọc top-level keys ở mọi cấp, làm rơi toàn bộ trường bên trong object con (như `patch: { theme: "dark" }` vs `patch: { theme: "light" }`). Dẫn đến cùng fingerprint và dedupe nhầm các lệnh khác payload.
- **Giải pháp áp dụng:** Cài đặt hàm `canonicalJsonStringify(value)` đệ quy:
  - Object: sắp xếp keys theo thứ tự từ điển ở mọi cấp (`Object.keys(obj).sort()`).
  - Array: bảo toàn nguyên thứ tự phần tử ban đầu (`value.map(canonicalJsonStringify)`).
  - Primitives/null: tuần tự hóa chuẩn JSON.
- **Regression Test:** `Behavior 9 [R1 Regression]` trong `packages/runtime/src/runtime.test.ts`:
  - Hai lệnh `settings.update` cùng `requestId` nhưng khác `theme` ("dark" vs "light") bị từ chối với lỗi `CONFIG_CONFLICT`.
  - Hai lệnh cùng payload nhưng khác thứ tự key trong nested object (`{ theme: "system", language: "vi" }` vs `{ language: "vi", theme: "system" }`) tạo cùng fingerprint và được deduplicate thành công.

### R2 — Early in-flight promise reservation (Chống reentrant duplicate)
- **Vấn đề trước sửa:** `processCommand` được gọi trước khi lưu `inFlightMap`. Nếu subscriber gọi lại `execute` trong callback sự kiện đồng bộ trước khi promise được gán, lệnh sẽ bị thực thi lần 2 và sinh operation thứ hai.
- **Giải pháp áp dụng:** Khởi tạo `inFlightPromise` và đăng ký vào `inFlightMap.set(requestId, ...)` **trước khi** kích hoạt bất kỳ side-effect hoặc sự kiện nào trong `processCommand`.
- **Regression Test:** `Behavior 10 [R2 Regression]` trong `packages/runtime/src/runtime.test.ts`:
  - Subscriber lắng nghe `operation.updated` và gọi lại `execute` reentrantly với cùng command: request reentrant nhận đúng `inFlightPromise` đang chạy, không sinh operation thứ hai (`reAck.operationId === mainAck.operationId`).

### R3 — Live runtime commands delegation & Không báo thành công giả
- **Vấn đề trước sửa:** Ở chế độ live, `runtime.check` vẫn trả `succeeded` kèm kết quả checks từ kịch bản demo (`Demo account profile simulated`). Lệnh `integration.preview` trả kết quả synthetic plan; `activity.export` trả `succeeded` dù không có exporter.
- **Giải pháp áp dụng:**
  - Trong constructor của `FakeRuntimeEngine` ở mode `live`, `currentSnapshot.lastCheck` được đặt là `null` (xóa bỏ toàn bộ checks giả lập của demo).
  - `runtime.check`: gọi trực tiếp `liveNativeAdapter.checkStatus()` và `liveBrowserAdapter.checkStatus()`. Nếu scope là `end_to_end` hoặc `native_bridge` và các điều kiện live chưa đạt, lệnh bị từ chối với `accepted: false`, operation `failed` và lỗi `NATIVE_ROUTE_UNVERIFIED`.
  - `integration.preview`: ở mode `live` bị từ chối với `accepted: false`, operation `failed` và lỗi `NATIVE_ROUTE_UNVERIFIED`.
  - `activity.export`: ở mode `live` bị từ chối với `accepted: false`, operation `failed` và lỗi `SERVICE_UNAVAILABLE`.
- **Regression Test:** `Behavior 11 [R3 Regression]` trong `packages/runtime/src/runtime.test.ts`:
  - Kiểm tra `initialSnap.lastCheck === null`.
  - Kiểm tra `runtime.check` (scope `end_to_end`), `integration.preview` và `activity.export` đều bị từ chối chính xác trên nhánh live.

### R4 — Terminal turn bất biến & Xác thực lệnh hủy
- **Vấn đề trước sửa:** `turn.cancel` chấp nhận cả session/turn không tồn tại (tạo operation running vô hạn), và có thể mở lại một lượt đã ở trạng thái terminal (như `outcome_unknown`) thành `cancel_requested`.
- **Giải pháp áp dụng:**
  - Kiểm tra session tồn tại (`SESSION_NOT_FOUND`).
  - Kiểm tra active turn khớp ID (`TURN_NOT_FOUND`).
  - Sử dụng hàm `isTerminalTurnState(state)` từ contracts: nếu turn đã ở trạng thái terminal (`completed`, `cancelled`, `failed`, `interrupted`, `outcome_unknown`), lệnh bị từ chối với `TURN_TERMINAL`.
  - Kiểm tra `canCancel === false` (`TURN_NOT_CANCELLABLE`).
  - Operation hủy hoàn tất trạng thái xác định qua timer dọn dẹp, không treo ở `running`.
- **Regression Test:** `Behavior 12 [R4 Regression]` trong `packages/runtime/src/runtime.test.ts`:
  - Hủy turn trong scenario `outcome_unknown` bị từ chối với `TURN_TERMINAL`; trạng thái turn không bị thay đổi.
  - Hủy session không tồn tại bị từ chối với `SESSION_NOT_FOUND`.

### R5 — Chống nhận nhầm event từ retired runtime instance & Resync buffering
- **Vấn đề trước sửa:** Bất kỳ `runtimeInstanceId` khác instance hiện tại đều bị coi là một lần restart mới, khiến event giao muộn từ instance cũ có thể kích hoạt resync ngược và ghi đè trạng thái UI.
- **Giải pháp áp dụng:**
  - `InProcessLauncherClient` duy trì `retiredInstances: Set<string>` ghi nhận mọi instance ID đã qua. Bất kỳ event nào có ID nằm trong `retiredInstances` đều bị loại bỏ ngay lập tức.
  - Chỉ cho phép chuyển đổi sang instance mới nếu nhận được sự kiện có tính thẩm quyền (`snapshot.updated`).
  - Trong quá trình resync (`isResyncing`), các sự kiện đến được đưa vào bộ đệm `resyncBuffer` và chỉ xả (drain) các sự kiện có sequence cao hơn watermark sau khi resync xong.
- **Regression Test:** `Behavior 13 [R5 Regression]` trong `packages/runtime/src/runtime.test.ts`:
  - Sau khi `simulateRestart()`, truyền trực tiếp một sự kiện muộn mang `oldInstanceId`: sự kiện bị loại bỏ hoàn toàn, không gây tăng số lần gọi callback resync.

### R6 — Discriminated OperationRecord Schema & Ràng buộc Result/State
- **Vấn đề trước sửa:** Schema cho phép operation ở trạng thái `failed` mà không có `error`, hoặc nhận `result` của lệnh khác (như `browser.open` nhận `previewResult`). Factory trong runtime còn dùng `result as any`.
- **Giải pháp áp dụng:**
  - Tách các schemas kết quả theo từng loại lệnh: `IntegrationPreviewResultSchema`, `RuntimeCheckResultSchema`, `ActivityExportResultSchema`, `GenericSummaryResultSchema`.
  - Dùng `.superRefine()` trên `OperationRecordSchema`:
    - Nếu `state === "failed"`: `error` bắt buộc phải có, và `result` KHÔNG được phép tồn tại.
    - Nếu `state === "succeeded"`: kiểm tra tính hợp lệ của `result` theo đúng `type` (ví dụ `integration.preview` bắt buộc có `IntegrationPreviewResult`, các lệnh khác không được dùng schema này).
  - Loại bỏ hoàn toàn `result as any` trong runtime engine; xây dựng đầy đủ `error` trước khi phát sinh event `operation.updated`.
- **Regression Test:** `OperationRecordSchema enforces discriminated command/result/state rules [R6 regression]` trong `packages/contracts/src/contracts.test.ts`:
  - Kiểm tra 4 trường hợp vi phạm schema đều throw ZodError; các trường hợp hợp lệ parse thành công.

### R7 — Mandatory Execution Binding & Host Tool Inventory trong Model Bridge
- **Vấn đề trước sửa:** `ExpectedBinding` cho phép bỏ qua hoặc truyền object rỗng `{}`; parser chấp nhận tool call với session/turn/nonce tùy ý. Chưa kiểm tra tool inventory của host và dedupe call ID.
- **Giải pháp áp dụng:**
  - Tách biệt kiểm tra cú pháp (`inspectSyntax`) khỏi đường dẫn thực thi (`parseForExecution`).
  - Định nghĩa interface `ExecutionBinding` với các trường bắt buộc: `sessionId`, `turnId`, `requestNonce`, `allowedTools` (không được rỗng).
  - Bổ sung `patch_file` và `run_test` vào `SafeToolNameSchema` kèm Zod argument schemas chặt chẽ.
  - Trong `parseForExecution`:
    - Bắt buộc kiểm tra khớp chính xác `sessionId`, `turnId`, `requestNonce` (`CONTRACT_MISMATCH`).
    - Bắt buộc tool phải nằm trong `allowedTools` của host (`TOOL_DENIED`).
    - Kiểm tra và ghi nhận call ledger `executedCallIds`; nếu trùng `callId` ném lỗi `CONTRACT_MISMATCH`.
- **Regression Test:** `EnvelopeParser.parseForExecution mandates authority binding, host inventory, and call ledger [R7 regression]` trong `packages/model-bridge/src/bridge.test.ts`.

---

## 3. Trạng thái và Kết luận
- **G2-A (Foundation Remediation):** Đã hoàn tất 100% các yêu cầu từ R1 đến R7.
- **Độ tin cậy:** Toàn bộ 29 TypeScript tests và 6 Python tests đều pass xanh, không có bất kỳ fake success hay mock pass nào trên live paths.
- Sẵn sàng chuyển sang đánh giá thực nghiệm cho các Gate G2-B (Native) và G2-C (Browser).

