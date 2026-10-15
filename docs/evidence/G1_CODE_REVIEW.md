# Kiểm tra G1 trước khi bàn giao G2

Ngày: 14/10/2026. Phạm vi: source năm packages, npm scripts, probe G0 đã sửa, ADR và báo cáo G1. Review chỉ đọc source; chạy build/checks và reproductions có kiểm soát. Không triển khai bridge, không sửa runtime/probe và không chạy inference/browser thật.

## Kết luận gate

Scaffold, strict TypeScript và demo harness hoạt động. Các live stubs chặn inference/apply, nhưng một số API vẫn báo thành công mô phỏng dưới nhãn live. Schema và event/dedupe còn lỗi làm nền tảng chưa đáp ứng đầy đủ contract đã giao.

**G1 có phần đã chạy, chưa nghiệm thu “complete 100%”. G0/native gate vẫn unresolved; chưa đủ điều kiện nghiệm thu G2 live.** Prompt G2 cho phép sửa các thiếu sót này trước, kiểm chứng lại native route/browser, rồi mới ghép luồng thật nếu gate đạt. Không đổi mục tiêu sản phẩm sang agent riêng.

## Checks đã chạy

| Check | Kết quả | Phạm vi bằng chứng |
|---|---|---|
| `npm run build` | PASS, 5 packages | Biên dịch source hiện tại |
| `npm run typecheck` | PASS | Static types |
| `npm run test` | PASS, 16/16 | Bộ test sẵn có, chưa bao phủ các repros dưới đây |
| `python -m unittest tools/probes/g0/test_probes_unit.py` | PASS, 4/4 | Doubles và loopback mock server; không gọi agy/browser thật |
| `npm run dev:mock` | PASS | Demo, không inference/tool thật |
| `npm run lint` | Exit 0, **NO CHECKS** | Các workspace không có lint script; `--if-present` bỏ qua tất cả |
| `npm ls --depth=0` | Đọc version đã cài | TypeScript 5.9.3, Zod 3.25.76; khác version ghi trong báo cáo G1 |

Adversarial reproductions chạy từ dist được build mới, bằng Node in-process và Python mocks. Không ghi credential thật hoặc thay route IDE. Mọi kết luận bên dưới phân biệt bug trong scaffold với khả dụng live của sản phẩm.

## Findings

### F1 — [P1] Mã có nhãn live vẫn báo browser/account thành công mô phỏng

Vị trí: `packages/runtime/src/fake-runtime.ts:30–44`, `:117–139`; `packages/gemini-browser/src/index.ts:35–40`.

`FakeRuntimeEngine(..., "live")` chỉ ép integration/nativeRoute về unverified, nhưng `browser.open` vẫn set ready và `account.check` vẫn set signed_in bằng Demo User. `switchScenario` còn có thể đưa toàn bộ scenario demo về mode live. Browser live stub `openBrowser()` chỉ đổi boolean rồi trả `opened: true`, không mở browser.

Repro: mode live → browser.open → account.check trả accepted và snapshot `{ mode: "live", browser: "ready", account: "signed_in" }`. Browser stub cũng trả opened true khi chưa có implementation.

Sửa: fake engine chỉ chạy demo; live composition phải dùng adapter có bằng chứng hoặc reject rõ. Không chỉ đổi nhãn mode. Browser stub không báo opened nếu không thực hiện; status chưa kiểm tra phải unknown/unverified, không hardcode account/path/host như kết quả vừa detect.

### F2 — [P1] Dedupe không so command type và bỏ kiểm tra conflict khi đang in-flight

Vị trí: `packages/runtime/src/fake-runtime.ts:56–111`.

Cache chỉ so payload. `browser.open` và `account.check` cùng `{}` và requestId thì command sau được ack từ command trước, account không được kiểm tra. Khi request đầu đang in-flight nhưng chưa có dedupeCache, request thứ hai khác payload nhận cùng Promise mà không reject conflict.

Repro: command khác type/cùng ID đều accepted và cùng operation; hai `runtime.check` đồng thời với scope connection/end_to_end cũng accepted và cùng operation.

Sửa: lưu fingerprint của toàn bộ command type + payload đã validate/canonicalize trước khi thực thi. In-flight có fingerprint riêng; cùng ID khác command phải conflict cả trong và sau execution. Ghi rõ phạm vi dedupe, restart và retention.

### F3 — [P1] Subscriber thứ hai mất event do dùng chung cursor dedupe

Vị trí: `packages/runtime/src/in-process-client.ts:23–24`, `:68–95`.

Mỗi subscribe tạo một wrapper engine riêng, nhưng các wrapper dùng chung lastSeenSequence. Wrapper đầu nâng cursor, wrapper sau coi cùng event là duplicate. UI có nhiều component subscribe sẽ không cập nhật nhất quán.

Repro: cùng client có hai subscriber; một browser.open phát hai event, subscriber thứ nhất nhận 2, thứ hai nhận 0.

Sửa: dùng một source subscription, validate/dedupe một lần rồi fan-out cho tất cả listeners; hoặc cursor độc lập đúng contract cho từng subscription. Cô lập lỗi listener. Resync phải tải snapshot/buffer event đúng thứ tự, không chỉ gọi callback rồi forward event stale.

### F4 — [P1] Event/result và responses chưa được validate đúng payload

Vị trí: `packages/contracts/src/events.ts:14–24`, `packages/contracts/src/operations.ts:25–34`, `packages/runtime/src/in-process-client.ts:52–58`, `packages/contracts/src/commands.ts:5–73`.

Event payload là z.unknown; operation type cho phép bất kỳ string và result z.unknown. getSessions/getActivity không validate page response. Các command object ngoài cùng không strict nên field ngoài payload bị strip thay vì reject.

Repro: `snapshot.updated` với `{snapshot:17}`, operation type `invented.shell` với result tùy ý, command thêm field lạ đều parse thành công. Client nhận session/activity malformed từ engine mà không reject.

Sửa: discriminated union theo event type và command/result; constraints theo operation state; schema Page<T> tại mọi boundary. Chốt unknown-field policy có chủ đích và bám tài liệu. Invalid event không được silently bỏ qua vì engine nuốt exception, phải có diagnostic/resync contract.

### F5 — [P2] Snapshot trong event lệch sequence và revision không phản ánh thay đổi

Vị trí: `packages/runtime/src/fake-runtime.ts:117–139`, `:312–324`, `:350–362`.

Snapshot payload được lấy trước khi emitEvent tăng sequence. Revision/observedAt không được cập nhật nhất quán khi browser/account/session đổi. UI dùng snapshot làm watermark có thể replay/drop sai hoặc không thấy snapshot mới.

Repro: snapshot.updated sequence 2 chứa snapshot.lastEventSequence 1; browser thay closed → ready nhưng revision vẫn 1.

Sửa: transaction cập nhật state/revision/observedAt và watermark trước khi chụp snapshot event. Quy định rõ snapshot revision có bao gồm operation/activity không, rồi test lifecycle, gap/restart và bootstrap.

### F6 — [P1] Probe còn có thể đánh dấu inference verified giả

Vị trí: `tools/probes/g0/test_start_cascade_details.py:160–175`; `test_aicode_endpoint.py:142`; browser probe `test_gemini_web.py:64–85`.

Probe details set PASSED chỉ từ readiness, dù StartCascade HTTP 400. `inference_route_verified` chỉ tìm tên path StreamGenerateContent/v1/chat, không kiểm tra prompt/response/token stream. Probe catalog coi bất kỳ incoming request là inference observed. Browser coi không thấy chữ login là SIGNED_IN, không có bằng chứng composer/account; navigation không được dùng làm điều kiện pass.

Repro bằng fake HTTP/process: StartCascade validation failure vẫn status PASSED. Một request zero-byte có path StreamGenerateContent làm inference_route_verified true, dù không sinh token nào.

Sửa: mỗi criterion có kết quả riêng (readiness, control-plane, inference request observed, response decoded, tool round-trip). Chỉ mark inference verified khi decode stream đúng và đối chiếu nội dung từ native turn; thiếu dữ liệu là NOT_TESTED/FAILED. Auth/navigation chỉ kết luận từ positive evidence có timeout, không từ thiếu một chuỗi.

### F7 — [P2] Envelope chưa gắn authority của lượt và cho phép code JSON thông thường

Vị trí: `packages/model-bridge/src/index.ts:7–11`, `:21–54`.

Parser nhận cả fenced json thường, chỉ validate turnId là chuỗi và args là record tùy ý. Không có expected session/turn/request nonce, callId/tool inventory/schema từng tool. Repro: block json minh họa có turn stale và đường dẫn ngoài workspace vẫn được trả thành tool envelope.

Hiện chưa có executor nên review không xác nhận đã đọc ngoài workspace; đây là protocol gap bắt buộc xử lý trước khi wire tool trong G2.

Sửa: đường control có marker/version/request nonce/call ID rõ và expected binding của host. Văn bản/code minh họa không cấp quyền; validate inventory + schema, size và ambiguity. Executor của host kiểm tra workspace/policy, bridge không tự chạy filesystem/shell từ prose.

### F8 — [P2] Kiểm tra tách profile chỉ so đường dẫn bằng nhau

Vị trí: `packages/runtime/src/paths.ts:41–54`.

assertNoPathOverlap chỉ so appDataDir/profile/config cùng field, không kiểm tra parent/child, cross-field, đường dẫn canonical/case-insensitive Windows. Demo dùng một thư mục cố định chung cho mọi instance; profile live trỏ lại profile G0 probe.

Repro: live paths nằm dưới DEV paths vẫn được chấp nhận. Không có bảo đảm “tách biệt tuyệt đối” như ADR ghi.

Sửa: resolved/canonical paths, containment và cross-field checks; xử lý case/symlink/junction với giới hạn được ghi; DEV instance riêng và live profile riêng, không tự adopt profile probe nếu chưa có quyết định migration.

### F9 — [P2] Lint là no-op, báo cáo version/coverage vượt bằng chứng

Vị trí: `package.json:11–12`, các `packages/*/package.json`, `docs/evidence/g1-foundation-validation.md:7–8`, README/ADR phần hoàn thành.

Không package nào có lint script. Root lint dùng --if-present nên exit 0 dù không có rule nào chạy. Dependencies khai báo ranges; lockfile/máy hiện dùng TypeScript 5.9.3 và Zod 3.25.76, báo cáo ghi 5.7.3 và 3.23.8. 16 green tests không phải “behavior bao phủ 100%”; reproductions F1–F8 cho thấy khoảng trống.

Sửa: lint thực sự chạy trên source và fail khi thiếu setup cần thiết; test/build từ source mới, ghi phiên bản resolved và checks đúng phạm vi. Update completion claim sau khi regression đạt, không tự nâng native capability từ các mock tests.

## Thứ tự bàn giao

1. Sửa F1–F9 và thêm regressions thực sự tái hiện trước/sau, cập nhật báo cáo.
2. Gate native: probe có criterion đúng → request thật từ chat native → decode stream đúng → tool read-only qua host executor.
3. Gate browser: user login → model/composer → 3 lượt text/markdown → cancel → status có bằng chứng.
4. Chỉ sau các gate mới làm G2 live: đọc file → patch → test pass/fail → final reply ở IDE.

Prompt đầy đủ: [GEMINI_G2_PROMPT.md](../GEMINI_G2_PROMPT.md). Review không kết luận native bất khả thi; kết luận hiện chưa đủ điều kiện đi thẳng tới live integration.
