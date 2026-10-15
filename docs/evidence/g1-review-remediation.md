# Báo cáo Khắc phục Review G1 (G1 Review Remediation)

- **Ngày:** 14/10/2026.
- **Phạm vi:** 9 findings (F1–F9) từ [`docs/evidence/G1_CODE_REVIEW.md`](./G1_CODE_REVIEW.md).
- **Mục tiêu:** Củng cố nền tảng G1 đạt chuẩn contract, loại bỏ thành công giả trên live path, sửa lỗi dedupe/subscribers/schema/probes trước khi bước vào G2.

---

## 1. Chi tiết Khắc phục & Kết quả Regression (F1 – F9)

| Finding | Phân loại | Bản chất lỗi ban đầu | Giải pháp & Thay đổi Code | Minh chứng Regression Test |
|---|---|---|---|---|
| **F1** | **[P1] Live báo thành công mô phỏng** | `FakeRuntimeEngine(..., "live")` vẫn chuyển browser sang `ready` và account sang `signed_in` (Demo User). `LiveGeminiBrowserAdapter.openBrowser()` chỉ lật boolean rồi trả `opened: true` mà không mở browser. | • `LiveGeminiBrowserAdapter.openBrowser()` trả về `{ opened: false, actionReason: "Live browser driver is not attached..." }`.<br>• `checkStatus()` khởi tạo `accountState: "unknown"`, `browserState: "closed"`, không gán nhãn tài khoản demo.<br>• Trong `FakeRuntimeEngine`, khi ở live mode, `browser.open` và `account.check` ủy quyền cho live adapter và từ chối fake success (`BROWSER_USER_ACTION_REQUIRED`, `LOGIN_REQUIRED`). | `packages/runtime/src/runtime.test.ts` (`Behavior 7 [F1 Regression]`) & `packages/gemini-browser/src/browser.test.ts` (`F1 regression`). PASS. |
| **F2** | **[P1] Dedupe nhận nhầm command & bỏ qua conflict in-flight** | Dedupe chỉ so sánh `payload`. Cùng `requestId` nhưng khác `type` (`browser.open` vs `account.check`) nhận chung operation. Request đang in-flight bị concurrent request khác payload nhận chung Promise mà không báo conflict. | • Tạo fingerprint chuẩn hóa: `getCommandFingerprint(command)` kết hợp `command.type` và canonical JSON payload (sort object keys).<br>• `inFlightMap` lưu `{ fingerprint, promise }`. Nếu request cùng `requestId` có fingerprint khác, reject ngay lập tức với `CONFIG_CONFLICT`.<br>• `dedupeCache` so sánh fingerprint; khác type hoặc payload trả `CONFIG_CONFLICT`. | `packages/runtime/src/runtime.test.ts` (`Behavior 2 [F2 Regression]`). PASS. |
| **F3** | **[P1] Subscriber thứ hai mất event do chung cursor** | `InProcessLauncherClient` dùng chung biến `this.lastSeenSequence`. Khi listener 1 xử lý xong, nó cập nhật cursor; listener 2 chạy sau thấy `sequence <= lastSeenSequence` nên bỏ qua sự kiện như một duplicate. | • `InProcessLauncherClient` chuyển sang kiến trúc **Single-source subscription + Fan-out**.<br>• Client chỉ subscribe 1 lần duy nhất tới engine, kiểm tra sequence/dedupe/gap một lần ở boundary, rồi phát tán (fan-out) tới tất cả active listeners.<br>• Đóng gói từng listener trong `try...catch` để cô lập ngoại lệ. | `packages/runtime/src/runtime.test.ts` (`Behavior 4 [F3 Regression]`). Cả 2 subscribers đều nhận đủ 100% events. PASS. |
| **F4** | **[P1] Schema thiếu strict validation ở boundaries** | `RuntimeEventSchema.payload` cho phép `z.unknown()`. `OperationRecordSchema.type` cho phép bất kỳ string và `result: z.unknown()`. `getSessions()`/`getActivity()` ở client không kiểm tra schema Page. Command outer object không `.strict()`. | • Biến `RuntimeEventSchema` thành **strict discriminated union** trên `type` với payload cụ thể cho từng loại sự kiện.<br>• `OperationRecordSchema.type` gán theo `CommandTypeSchema` (enum 9 commands), `result` có schema union chặt chẽ.<br>• Thêm `.strict()` vào tất cả 9 command schemas.<br>• `InProcessLauncherClient` validate Page responses (`createPageSchema`) cho `getSessions()` và `getActivity()`. | `packages/contracts/src/contracts.test.ts` (`RuntimeEventSchema [F4]`, `OperationRecordSchema [F4]`, `createPageSchema [F4]`, `ControlCommandSchema [F4]`). PASS. |
| **F5** | **[P2] Snapshot trong event lệch sequence & revision** | `snapshot.updated` lấy snapshot trước khi tăng sequence (`lastEventSequence` trong snapshot bị chậm 1 nhịp so với `event.sequence`). Các thay đổi trạng thái (`browser.open`, `model.select`) không tăng `revision`. | • Đưa các thay đổi snapshot vào transaction `commitSnapshotChange(mutator)`: cập nhật state, tăng `revision`, cập nhật `observedAt`, tăng `lastEventSequence`, rồi mới clone snapshot vào payload `snapshot.updated`. Đảm bảo `snapshot.lastEventSequence === event.sequence`. | `packages/runtime/src/runtime.test.ts` (`Behavior 8 [F5 Regression]`). PASS. |
| **F6** | **[P1] Probe xác nhận inference giả** | `test_start_cascade_details.py` gán `inference_route_verified = True` chỉ từ việc tìm thấy chuỗi URL; và gán status `PASSED` dù StartCascade trả HTTP 400. `test_gemini_web.py` dùng phép kiểm tra phủ định (không thấy chữ "Sign in") để kết luận `SIGNED_IN`. | • `test_start_cascade_details.py` phân tách tiêu chí: `readiness`, `control_plane_route_observed`, `inference_request_observed`, `token_stream_decoded`. `inference_route_verified` CHỈ True khi có cả request, token stream và StartCascade HTTP 200. Nếu StartCascade HTTP 400, status là `FAILED`.<br>• `test_gemini_web.py` dùng **bằng chứng khẳng định (positive evidence)**: tìm composer elements (`rich-textarea`, `textarea`, `div[contenteditable='true']`). Nếu không có composer, trạng thái là `SIGN_IN_REQUIRED`. | `tools/probes/g0/test_probes_unit.py` (`test_cascade_validation_failure_marks_failed`, `test_gemini_web_positive_auth_evidence`). PASS. |
| **F7** | **[P2] Envelope thiếu authority & nhận JSON thường** | `EnvelopeParser` nhận cả fenced ```json thông thường, thiếu callId, nonce, và không kiểm tra ràng buộc turn/session authority của host. | • Chỉ chấp nhận duy nhất marker ```antigravity-tool. Bỏ qua hoàn toàn fenced code block ```json thông thường.<br>• Bổ sung schema: `schemaVersion: "0.1"`, `callId`, `sessionId`, `turnId`, `requestNonce`, `tool`, `args`.<br>• Validate schema tham số riêng cho từng tool (`read_file`, `list_dir`).<br>• Hỗ trợ `expectedBinding`: nếu `turnId`/`sessionId`/`nonce` không khớp với lượt đang chạy, từ chối với `CONTRACT_MISMATCH`. | `packages/model-bridge/src/bridge.test.ts` (`EnvelopeParser strictly ignores generic json [F7]`, `authority binding [F7]`). PASS. |
| **F8** | **[P2] Path separation chỉ so sánh bằng nhau thô sơ** | `assertNoPathOverlap` chỉ so sánh chuỗi bằng nhau trên cùng field, không canonicalize, không xử lý case-insensitive Windows, không kiểm tra containment (thư mục con) hay cross-field. | • Chuẩn hóa đường dẫn bằng `path.resolve()` và lowercase trên Windows.<br>• Kiểm tra chéo (cross-field) toàn diện giữa tất cả các đường dẫn DEV và Live.<br>• Kiểm tra quan hệ cha - con (containment): cấm tuyệt đối một đường dẫn DEV nằm trong thư mục Live hoặc ngược lại. | `packages/runtime/src/runtime.test.ts` (`Behavior 5 [F8 Regression]`). PASS. |
| **F9** | **[P2] Lint script là no-op & version không đồng nhất** | Workspaces không có script `lint`. Root `npm run lint` dùng `--if-present` nên exit 0 mà không chạy kiểm tra nào. Báo cáo ghi sai version resolved. | • Thêm `"lint": "tsc --noEmit"` vào tất cả 5 `packages/*/package.json`.<br>• Cập nhật root `package.json` thành `"lint": "npm run --workspaces lint"` (bỏ `--if-present`, bắt buộc chạy thật).<br>• Ghi nhận chính xác resolved dependencies từ lockfile: TypeScript 5.9.3, Zod 3.25.76, @types/node 22.20.5. | Chạy `npm run lint` thực thi `tsc --noEmit` trên cả 5 workspaces. Exit code 0. |

---

## 2. Bảng Tổng Hợp Kiểm Tra Regression Toàn Bộ Hệ Thống

```text
1. TypeScript Lint & Typecheck:
   npm run lint        -> 5/5 packages passed (tsc --noEmit)
   npm run typecheck   -> 5/5 packages passed (tsc --noEmit)
   npm run build       -> 5/5 packages compiled cleanly to dist/

2. TypeScript Unit & Behavior Tests (npm run test):
   - @antigravity-gemini-web/contracts:       7/7 passed (including F4 regressions)
   - @antigravity-gemini-web/gemini-browser:  1/1 passed (including F1 regression)
   - @antigravity-gemini-web/model-bridge:    3/3 passed (including F7 regressions)
   - @antigravity-gemini-web/native-antigravity: 1/1 passed
   - @antigravity-gemini-web/runtime:        10/10 passed (including F1, F2, F3, F5, F8 regressions)
   Total: 22/22 TypeScript tests passed (100%).

3. Python Probe Unit Tests (python -m unittest tools/probes/g0/test_probes_unit.py):
   Ran 6 tests in 9.408s -> 6/6 passed (including F6 regressions).

4. Runtime Mock Harness (npm run dev:mock):
   Executed cleanly with demo banner, deduplication, revision conflict rejection, and cancel handling.
```

---

## 3. Trạng Thái Cổng Dự Án Sau Khắc Phục G1

- **G1 Foundation Quality:** Đã khắc phục triệt để F1–F9. Tất cả các kịch bản lỗi (reproductions) đều có regression tests bảo vệ, không còn lỗ hổng fake success trên live path.
- **G0 / Native Gate:** Vẫn giữ nguyên trạng thái **`UNRESOLVED / NOT MET` (Chưa đạt)**.
- **Điều kiện chuyển sang G2 Live:** Chỉ khi bước kiểm chứng native protocol thật (chat native IDE → connectRPC inference token stream decode) và browser authentication thật được chứng minh.

