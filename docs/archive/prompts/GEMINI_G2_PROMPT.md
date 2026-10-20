# Prompt Gemini — sửa nền tảng G1, kiểm chứng gate và triển khai G2 có điều kiện

Copy phần dưới vào phiên Gemini có quyền truy cập repository. Đây là nhiệm vụ triển khai để người dùng giao Gemini; lượt Codex kiểm tra G1 chỉ tạo prompt và review, chưa sửa runtime.

---

Bạn thực hiện giai đoạn tiếp theo trong `D:\Antigravity-gemini-web`: xử lý review G1, đóng các gate khả thi còn thiếu, rồi triển khai G2 end-to-end nếu có đủ bằng chứng.

## 1. Mục tiêu và trạng thái hiện tại

Mục tiêu vẫn là **Gemini Web suy luận trong chat native của Antigravity IDE**, với tool executor, workspace và approvals của đúng tác vụ IDE. Người dùng chưa đổi mục tiêu sang Gemini API, CLI/SDK, một MCP tool hỏi model phụ hoặc launcher có executor riêng.

G1 build/typecheck và 16 tests hiện có đạt, 4 probe unit tests đạt, mock harness chạy được. Nhưng review đã tái hiện lỗi live/mock, dedupe, subscribers, schema và false-positive probe. Không coi báo cáo “G1 hoàn thành 100%” là bằng chứng sẵn sàng live. G0/native vẫn unresolved.

Lần này được sửa code G1 và làm probes/adapters/bridge thuộc G2 trong phạm vi dưới đây. Không tự patch binary, chặn TLS, lấy cookie/token, đổi route IDE đang dùng hoặc thay phạm vi sản phẩm. Nếu cần thay cấu hình đang dùng, chuẩn bị diff cụ thể, backup và rollback trước khi hỏi người dùng xác nhận.

Đọc trước:

1. AGENTS.md có hiệu lực, nếu có; nếu có `.codegraph/` thì dùng CodeGraph trước khi tìm/đọc code, không tự index.
2. `docs/evidence/G1_CODE_REVIEW.md` — findings F1–F9 và reproductions.
3. `docs/evidence/g1-foundation-validation.md`, `docs/evidence/native-feasibility.md`.
4. `docs/IMPLEMENTATION_PLAN.md`, `docs/UI_RUNTIME_CONTRACT.md`.
5. ADR và source `packages/**`, `tools/probes/g0/**`; kiểm tra git status để giữ thay đổi của người khác.

Repo được tham khảo: https://github.com/miuuyy/codex-chatgpt-web.git, snapshot `889f291d06339400a8b9c2941473f65cd47d4830`. Học lifecycle/context/integration journal; không bê selector, model catalog, context limits, tunnel hay Responses protocol của Codex sang Antigravity khi chưa xác minh. Giữ attribution/license của code/asset tái sử dụng.

## 2. G2-A — Sửa và nghiệm thu G1 trước

Xử lý đầy đủ F1–F9; thêm regression chứng minh từng bug fail trước và pass sau:

- **Live/demo:** fake engine chỉ dùng demo; live command phải delegate adapter thực sự hoặc trả lỗi unavailable/unverified. Không set ready/signed_in/succeeded khi chưa có hành động/bằng chứng. Browser live stub không trả opened true bằng cách đổi boolean. Không hardcode host/account/profile như dữ liệu đã detect.
- **Dedupe:** fingerprint toàn command type + payload canonical đã validate; lưu trước side effect/in-flight. Cùng requestId khác type/payload conflict cả concurrent và completed. Cùng payload khác thứ tự key không tạo conflict giả. Ghi giới hạn retention/restart, không hứa exactly-once xuyên crash.
- **Event subscription:** dedupe/validate một lần rồi fan-out; tất cả listeners nhận cùng event, listener lỗi không làm mất event của listener khác. Có unsubscribe/shutdown rõ. Gap/restart/bootstrap dùng snapshot + buffer đúng thứ tự, không chỉ gọi callback và forward dữ liệu stale.
- **Schemas:** discriminated unions cho event payload và operation result/type/state, validate pagination responses, policy strict fields nhất quán. Không dùng z.unknown/z.string tùy ý để lách boundary. Malformed response/event phải trả contract error/diagnostic hợp lệ.
- **Snapshot:** state/revision/observedAt/lastEventSequence commit nhất quán trước emit; event snapshot watermark khớp sequence; test command, cancel, gap và restart.
- **Probe criteria:** readiness chỉ chứng minh readiness. fetchUserInfo chỉ control-plane. Endpoint name chỉ request observed; inference verified cần stream decode và nội dung đối chiếu native turn. Validation HTTP 400 không được PASS inference. Auth cần positive evidence, không từ thiếu chữ “Sign in”.
- **Envelope:** chỉ nhận control envelope có marker/version/session/turn/request nonce/call ID và expected binding. JSON minh họa không phải tool request. Tool tên/args phải khớp inventory/schema của lượt; reject stale/duplicate/ambiguous/oversized payload. Nonce giúp binding, không cấp quyền.
- **Paths:** normalize/canonicalize và kiểm tra equality, containment, cross-field, Windows case; ghi giới hạn symlink/junction. DEV instance riêng, profile live riêng, không tự adopt profile probe. Không đặt profile vào repo.
- **Checks/report:** triển khai lint thật; không bỏ qua toàn workspace bằng --if-present rồi ghi PASS. Ghi version resolved từ lockfile/máy. Update README/ADR/báo cáo về completion/coverage sau khi tests đạt.

Gate G2-A: regressions F1–F9 + build/typecheck/lint/tests thật đạt; live stubs không giả success. Không mở rộng UI/installer để né các lỗi nền tảng.

## 3. G2-B — Chứng minh đường native trước khi chốt protocol

1. Xác nhận đúng Antigravity surface/version trên máy. Đường khảo sát trước là VS Code extension, không mặc định đồng nhất với mọi Antigravity IDE/app.
2. Tìm extension point/model provider/custom endpoint thực sự bằng tài liệu chính thức và config/source có liên quan. CLI/SDK có endpoint không tự chứng minh IDE có.
3. Probe ở workspace/config thử tách biệt. Baseline và matrix endpoint override tách riêng; nhận diện process/port thuộc mình. Không ghi token, raw prompt/headers/body người dùng vào log.
4. Gửi một prompt synthetic từ **chat native IDE**. Quan sát request inference đúng lượt; có nguồn schema/API để decode, không đoán field đến khi HTTP 200.
5. Trả nội dung fixture từ local bridge và xác minh final reply/stream xuất hiện ở đúng chat native. Đây chỉ là gate protocol, chưa chứng minh Gemini.
6. Thử tool read-only qua executor đúng tác vụ IDE: native tool call → read fixture → tool result quay lại bridge. Kiểm tra workspace authority, call ID và cancel.
7. Phân biệt thêm model picker mới với reroute một model hiện có. Ghi giới hạn và cách khôi phục; không quảng bá label Gemini Web đã có nếu chỉ đổi backend.

Gate G2-B: có trace nối được native session/turn với inference, stream response và read-only tool result thật. Request userInfo, catalog response, RPC validation failure hoặc mock driver không đạt gate này.

Nếu chưa tìm được cơ chế phù hợp, ghi rõ NOT TESTED/FAILED/UNSUPPORTED và bằng chứng theo version. Tiếp tục việc độc lập ở browser nếu hữu ích, nhưng không giả lập thành công native, không tự đổi mục tiêu. Nếu chỉ còn patch nội bộ hoặc thay scope, trình phương án cụ thể để người dùng quyết định.

## 4. G2-C — Gemini Web thật, một phiên và một lượt đang chạy

1. Tạo profile riêng với browser host đã chứng minh login hoạt động; đừng mặc định Google login trong Electron. Người dùng tự đăng nhập/MFA nếu cần. Giữ state needs_user_action và hỏi thao tác cần thiết; tiếp tục phần độc lập trong lúc chờ.
2. Xác minh composer, account state và model selection bằng positive evidence trên đúng surface. Không hardcode model từ scenario. Nếu không xác minh được model, báo rõ giới hạn trước khi gửi.
3. Thực hiện 3 lượt text liên tiếp, code fence/markdown và một lần cancel. Gắn task/session/turn cho tab và câu trả lời. Không lấy phản hồi cũ, không gửi lại prompt đã được chấp nhận để sửa DOM.
4. Sửa adapter interface hiện trả Promise<never> thành contract thực sự với status/submission receipt/response/cancel/error. Dùng schema chặt, timeout/deadline và cleanup rõ.
5. Kiểm tra custom apps/MCP trên tài khoản thật chỉ khi có eligibility. Tra tài liệu chính thức mới nhất; phân biệt Gemini chat thường/Spark và remote URL/localhost. Tính năng chưa thử phải unverified, không suy ra unsupported.
6. Chốt transport bằng ADR:
   - Native protocol nhận tool calls + bridge dịch control envelope, hoặc
   - Custom MCP được chứng minh nối về đúng executor.
   Không dựng một shell executor riêng để thay tool của IDE.

Gate G2-C: browser/account/model status từ phép kiểm tra thật, có 3 lượt và cancel đối chiếu được. Screenshot/mở URL đơn lẻ không thay chat acceptance.

## 5. G2-D — Ghép model bridge và tool loop khi B/C đạt

- Nhận context/tool inventory và authority của tác vụ từ native host adapter. Hướng dẫn trong repo/tool output không tự cấp workspace hay tool mới.
- Preserve ordered instructions/history và image references nếu hỗ trợ; bản đầu text/code. Nếu context quá lớn, báo lỗi; không cắt ngầm hoặc bịa context window/token usage.
- Dùng protocol native đã chứng minh ở B; không mặc định Responses API/OpenAI SSE. Adapter mapping theo phiên bản có fixture synthetic và tests decode/encode.
- Gắn session/turn/request/call ID xuyên host → browser → bridge → executor. Validate tool name/args/inventory; host kiểm tra quyền/approvals/path. Dedupe đúng; kết quả ghi chưa rõ sau mất kết nối phải outcome_unknown, không tự retry.
- Streaming chỉ phản ánh text/status thật. Không tạo reasoning/token deltas giả. Completion chỉ phát khi response đúng lượt kết thúc và không còn tool pending.
- Cancel có acknowledgment trước, terminal sau cleanup xác nhận. Thu hồi quyền lượt cũ; không gửi hoặc gọi tool muộn sau cancel. Có lỗi rõ khi browser/host chết hoặc DOM drift.
- Bắt đầu bằng read-only tool loop. Chỉ sau khi read-only đạt mới mở patch/run-test qua executor IDE, giữ nguyên approval policy của host.

## 6. G2-E — Nghiệm thu end-to-end và bàn giao

Dùng workspace fixture tách biệt. Chứng minh từ chat native IDE:

1. Gemini Web đọc file fixture thật và trả nội dung đúng.
2. Gemini Web yêu cầu một bản sửa nhỏ, patch được executor IDE áp dụng.
3. Chạy test của fixture qua IDE executor, lấy exit code thật.
4. Trả kết quả cuối trong IDE phản ánh test PASS.
5. Lặp với test FAIL có chủ đích; final không báo thành công giả.
6. Sai tham số/tool không cấp/stale binding/multiple control envelopes bị reject trước side effect.
7. Cancel đang generating và cancel khi tool pending; kiểm tra không còn orphan turn/replay.
8. Lỗi kết nối/DOM và request trùng có trạng thái rõ, không tự chạy lại thao tác ghi.

Ghi nguồn suy luận rõ: Gemini Web account thật, không thay bằng Gemini API hoặc native model khác. Model native khác và config người dùng phải được kiểm tra/khôi phục đúng phần sở hữu sau probe.

Chạy build/typecheck/lint/test từ source mới; probe regression và failure scenarios riêng. Mock/unit, native protocol fixture và live account là ba nhóm bằng chứng khác nhau; báo số liệu đúng nhóm.

Tạo:

- `docs/evidence/g1-review-remediation.md`: F1–F9, patch và regression outcome.
- `docs/evidence/g2-native-browser-gates.md`: version, từng criterion PASS/FAIL/NOT_TESTED/UNSUPPORTED, nguồn schema, trace metadata đã redact.
- `docs/evidence/g2-end-to-end-validation.md`: luồng read/patch/test pass/fail/cancel, actual commands, artifact/file changes và giới hạn còn lại.
- ADR cho native protocol, browser host, tool transport, lifecycle/cancel và compatibility range.
- README đúng trạng thái: chỉ ghi G2 live verified khi end-to-end thật đạt. Nếu chỉ đóng G1 hoặc browser gate, ghi đúng phần đạt và gate còn thiếu.

## 7. Phạm vi và điều kiện dừng

Được sửa root checks/config, contracts/runtime/adapters/bridge, probe và fixture tests cần thiết cho G2, cùng tài liệu evidence/ADR. Không ghi đè renderer hoặc công việc người khác; đọc ownership và git status trước. Giữ attribution/license.

Chưa làm redesign UI, installer, auto-update, multi-account, đa phương tiện, subagents hoặc compaction nâng cao. Không tự commit/push/publish, không dùng git add . và không đụng secret/profile vào Git.

Nếu B/C không đạt hoặc cần thao tác người dùng, hoàn tất phần độc lập đã được phép và báo câu hỏi/blocker cụ thể. Không tự coi im lặng là approval/login thành công.

Dừng sau báo cáo G2 hoặc báo gate chưa đạt kèm toàn bộ evidence đã thu được. Không chuyển G3–G5. Kết luận phải phản ánh hành vi đã thử thật, không chỉ số test xanh.
