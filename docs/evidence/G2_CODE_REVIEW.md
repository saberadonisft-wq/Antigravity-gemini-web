# Kiểm tra G2 và phần cần tiếp tục

Ngày: 14/10/2026. Review source hiện tại, chạy build/checks và reproductions có kiểm soát. Không sửa runtime/probe, không gọi agy/Gemini thật hoặc đổi cấu hình IDE. Tài liệu này là kết quả kiểm tra mới; không thay lịch sử review G1.

## Kết luận tiến độ

**Repo mới có phần G2-A sửa nền tảng G1; chưa có G2 live được chứng minh.**

- Native adapter vẫn trả `unverified`, apply bị chặn.
- Browser adapter chưa có driver; open trả `opened: false`, sendPrompt luôn throw.
- Model bridge vẫn là LiveModelBridgeStub; routeInference luôn throw.
- Chưa có native tool executor bridge, read → patch → test → final reply từ Gemini Web thật.
- Không có `docs/evidence/g2-native-browser-gates.md` và `docs/evidence/g2-end-to-end-validation.md` tại thời điểm review.
- Báo cáo `g1-review-remediation.md` có phần sửa tốt, nhưng “khắc phục triệt để F1–F9” chưa phù hợp với reproductions dưới đây.

Prompt giao tiếp: [GEMINI_G2_CONTINUE_PROMPT.md](../GEMINI_G2_CONTINUE_PROMPT.md). Người dùng yêu cầu tiếp tục G2, chưa giao G3.

## Kiểm tra đã chạy

| Check | Kết quả | Phạm vi |
|---|---|---|
| npm run build | PASS | 5 packages, dist build mới |
| npm run typecheck | PASS | Static types |
| npm run lint | Exit 0 | Hiện là `tsc --noEmit`, trùng typecheck; chưa có lint rules riêng |
| npm run test | PASS, 22/22 | Bộ test sẵn có, chưa bao phủ các repros bên dưới |
| python -m unittest tools/probes/g0/test_probes_unit.py | PASS, 6/6 | Mock process/driver và loopback mock server |
| npm run dev:mock | PASS | Demo harness, không live acceptance |

Các reproductions Node in-process dùng dữ liệu synthetic, không khởi chạy shell/tool executor, không viết credential. Các kết luận “accepted” ở dưới nói về API scaffold hiện có, không phải đã gây thao tác thật trong IDE.

## Findings cần xử lý

### R1 — [P1] Fingerprint xóa nội dung payload lồng nhau

Vị trí: `packages/runtime/src/fake-runtime.ts:75–78`.

`JSON.stringify(command.payload, Object.keys(command.payload).sort())` dùng replacer array cho tất cả cấp JSON. Với settings.update, keys ngoài là expectedRevision/patch; theme/language ở trong patch bị bỏ, khiến các patch khác nhau có cùng fingerprint.

Repro: cùng requestId/revision, patch theme dark rồi light đều accepted, cùng operationId; theme vẫn dark. Request sau phải conflict vì khác payload.

Sửa: canonical serialization đệ quy giữ mọi key/value ở mọi cấp, giữ thứ tự array, chỉ sort object keys. Test nested conflict, reordered equivalent object, null/array và payload đúng schema.

### R2 — [P1] In-flight registration xảy ra sau side effect và event

Vị trí: `packages/runtime/src/fake-runtime.ts:119–121`.

Gọi processCommand trước khi set inFlightMap. Hàm async có thể thực hiện mutation/emit đồng bộ trước await. Subscriber gọi lại execute với cùng ID trong callback sẽ thấy chưa có cache/latch và chạy thêm operation.

Repro: subscriber operation.updated gọi lại cùng runtime.check một lần; hai command accepted, tạo hai operationId khác nhau. Không có vòng callback vô hạn trong repro.

Sửa: reserve request ID/fingerprint/Promise trước khi chạy bất kỳ mutation/event; hoàn tất ack sau đó. Thêm test reentrant, concurrent, exception và retry semantics.

### R3 — [P1] Nhánh live vẫn báo end-to-end/export thành công bằng demo

Vị trí: `packages/runtime/src/fake-runtime.ts:200–215`, `:296–303`; constructor `:39–56` và scenarios.

browser/account fake success trực tiếp đã bị chặn, nhưng runtime.check trong live vẫn trả succeeded từ lastCheck của demo. Payload scope end_to_end không được thực thi. Nó mang browser/account passed và summary “Demo account profile simulated”, dù route/tools chưa chứng minh. activity.export live cũng trả succeeded và redacted true mà không tạo export artifact. integration.preview vẫn dùng synthetic plan.

Repro: mode live, runtime.check end_to_end accepted, operation succeeded và checks demo; activity.export accepted/succeeded dù không có exporter.

Sửa: fake engine demo-only hoặc live composition delegate mọi command tương ứng. Stub/unverified phải trả đúng trạng thái, không báo diagnostic/export thành công. Metadata check không được suy ra PASS end-to-end. Profile/model/capability chưa đo phải unverified/unknown.

### R4 — [P1] Cancel mở lại terminal turn và nhận cả lượt không tồn tại

Vị trí: `packages/runtime/src/fake-runtime.ts:257–270`.

Chỉ so session/turn ID, không kiểm tra terminal state/canCancel. outcome_unknown bị đổi sang cancel_requested, vẫn giữ completedAt cũ. Session/turn không tồn tại cũng accepted và tạo operation running vô hạn.

Repro: outcome_unknown + canCancel false → cancel accepted → cancel_requested. Missing session/turn cũng accepted, operation running.

Sửa: transition table và invariant terminal bất biến; stale/missing/terminal cancel phải reject hoặc no-op idempotent có semantics rõ. Operation hủy có completion/failure/timeout xác định. Outcome unknown không được mở lại hay tự retry.

### R5 — [P2] Client nhận event của runtime instance đã nghỉ như một restart mới

Vị trí: `packages/runtime/src/in-process-client.ts:86–105`.

Single-source fan-out đã sửa việc subscriber thứ hai mất event. Nhưng bất kỳ instance ID khác đều bị coi là restart; không có epoch/source authority hay retired-instance filtering. Resync chỉ gọi callback rồi forward event ngay, chưa buffer hoặc lấy snapshot trước khi cho UI áp dụng.

Repro: nhận old snapshot event, simulateRestart sang instance mới, sau đó delivery muộn old event; client forward event cũ và trigger resync ngược. Chưa có bảo đảm state mới không bị ghi đè trong UI.

Sửa: instance hiện hành phải được xác nhận qua transport/snapshot, không chỉ bởi event tùy ý; reject retired instance, buffer trong resync, watermark/dedupe theo instance. Test late event sau restart, gap + delayed snapshot, concurrent events và unsubscribe/reconnect.

### R6 — [P2] Operation result vẫn không ràng buộc command/state

Vị trí: `packages/contracts/src/operations.ts:26–58`; `fake-runtime.ts:327–337`.

Schema đã chặn invented type và unknown result shape, nhưng union result tách khỏi type/state. browser.open succeeded vẫn nhận preview result; failed không error vẫn parse được. Factory còn `result as any`, che khác biệt với contract.

Repro: OperationRecordSchema nhận browser.open + preview result, và failed thiếu error. Live account.check cũng tạo failed event trước khi gắn op.error, khiến event và getOperation khác nhau.

Sửa: command/result/state discriminated contract hoặc refinements có test; xây operation hoàn chỉnh trước emit. Không dùng any để vượt validator.

### R7 — [P2] Authority binding của tool envelope vẫn tùy chọn

Vị trí: `packages/model-bridge/src/index.ts:27–31`, `:41`, `:108–135`.

Marker và per-tool schemas tốt hơn G1. Nhưng ExpectedBinding fields đều optional, parse cho phép bỏ binding hoặc `{}`; stale session/turn/nonce vẫn được trả thành envelope. Chưa có host inventory, nonce retirement/call ledger dùng trong action path.

Repro: antigravity-tool block với stale IDs/nonce vẫn parse khi không có binding hoặc binding rỗng. Hiện executor chưa triển khai, nên chưa xác nhận side effect ngoài workspace; đây là gap bắt buộc trước khi wire tool loop G2.

Sửa: tách syntax inspection khỏi parse-for-execution; action path bắt buộc binding đầy đủ/inventory/schema/current authority, hạn chế size và ambiguity, dedupe call ID. Quyền workspace do host executor kiểm tra, nonce không thay policy.

### R8 — [P1, gate] G2-B/C/D/E chưa có code và evidence nghiệm thu

Vị trí: `packages/native-antigravity/src/index.ts:27–61`, `packages/gemini-browser/src/index.ts:23–48`, `packages/model-bridge/src/index.ts:156–168`.

Stub reject là hành vi đúng khi chưa tích hợp; không coi stub là bug cần biến thành fake success. Phần thiếu là triển khai/probe có nguồn giao thức, login thật, model/composer binding, read-only tool round-trip, rồi patch/test/final trong native IDE. Mock tests xanh không hoàn thành các mục này.

Sửa: tiếp tục G2 theo thứ tự prerequisite/gate của prompt. Nếu chưa có extension point phù hợp hoặc chờ user login, ghi NOT_TESTED/FAILED/UNSUPPORTED theo bằng chứng; không đổi mục tiêu, không nâng capability hay tự đánh dấu G2 complete.

## Phần sửa trước đã được ghi nhận

- Outer command strict hơn, event payload schemas cụ thể và pagination response đã validate.
- Fan-out hoạt động cho nhiều subscribers, exception listener được cô lập.
- Snapshot update thông thường có revision/sequence tốt hơn.
- Browser stub không còn trả opened true; live browser/account direct commands bị chặn.
- Probe không còn coi tên endpoint là token stream decoded; token_stream_decoded hiện luôn false nên vẫn chưa có inference evidence.
- Path kiểm tra containment/cross-field tốt hơn; chưa có evidence realpath/junction và durability.

Các cải thiện này là nền tảng để tiếp tục G2. Tình trạng hiện tại vẫn là **remediation có tiến triển; native/browser/end-to-end chưa được nghiệm thu**.
