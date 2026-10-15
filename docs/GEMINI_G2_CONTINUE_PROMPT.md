# Prompt Gemini — tiếp tục G2 còn dang dở

Copy phần dưới vào Gemini có quyền truy cập repository. Người dùng yêu cầu tiếp tục G2, chưa giao G3.

---

Bạn tiếp tục G2 trong `D:\Antigravity-gemini-web`. Hiện mới có phần sửa G1 (G2-A); native/browser/inference vẫn là stub. Nhiệm vụ lần này là xử lý findings mới rồi thực hiện các gate và luồng thật còn thiếu của G2. Không chỉ sửa nền tảng rồi báo G2 đã hoàn thành.

## 1. Đọc và chốt đúng mục tiêu

Đọc:

- AGENTS.md có hiệu lực, nếu có. Nếu có `.codegraph/`, dùng CodeGraph trước khi tìm/đọc code; không tự index.
- `docs/evidence/G2_CODE_REVIEW.md` — findings R1–R8 và kết quả review mới.
- `docs/GEMINI_G2_PROMPT.md` — phạm vi đầy đủ G2-A/B/C/D/E vẫn có hiệu lực.
- `docs/IMPLEMENTATION_PLAN.md`, `docs/UI_RUNTIME_CONTRACT.md` và ADR.
- `docs/evidence/g1-review-remediation.md`, source packages/probes và git status.

Mục tiêu giữ nguyên: **Gemini Web suy luận trong chat native Antigravity IDE, giữ workspace/tool executor/approvals của đúng tác vụ IDE**. Chưa được đổi sang Gemini API, CLI/SDK, một tool hỏi model phụ hoặc chat/agent độc lập.

G1 đã có 22 TypeScript tests và 6 Python tests xanh, nhưng G2 live chưa được chứng minh. Hai báo cáo `g2-native-browser-gates.md` và `g2-end-to-end-validation.md` đang thiếu. Không lấy test mock hoặc stub trả lỗi làm bằng chứng tích hợp thật.

Repo tham khảo được phép: https://github.com/miuuyy/codex-chatgpt-web.git, snapshot `889f291d06339400a8b9c2941473f65cd47d4830`. Giữ attribution/license; không sao chép giao thức/selector/model/context budgets khi chưa xác minh cho Antigravity/Gemini.

## 2. Sửa R1–R7 trước khi mở tool loop

1. **R1:** canonical fingerprint đệ quy. Không dùng JSON.stringify replacer array lấy top-level keys vì nó xóa nội dung patch lồng nhau. Test dark/light conflict, reordered equivalent nested payload và arrays.
2. **R2:** reserve requestId/fingerprint/in-flight Promise trước mọi side effect/event. Test subscriber reentrant gửi lại cùng command không tạo operation thứ hai; test concurrent conflict và error path.
3. **R3:** live runtime.check/end_to_end, integration.preview và activity.export phải delegate implementation thật hoặc báo unverified/unavailable. Không dùng lastCheck/demo account hoặc trả succeeded/exported khi không có artifact. Demo/live composition rõ, mọi live capability/status có nguồn bằng chứng.
4. **R4:** terminal turn bất biến. Cancel missing/stale/terminal phải reject hoặc no-op idempotent có semantics rõ; không đổi outcome_unknown thành cancel_requested. Ack hủy không là completion; operation phải kết thúc theo cleanup/timeout, không running vô hạn.
5. **R5:** event instance/epoch có authority từ transport/snapshot; reject late event của retired instance. Resync buffer + snapshot + watermark trước fan-out, không apply stale payload ngay. Test restart + late event, gap + delayed snapshot và multi-subscriber.
6. **R6:** operation type/result/state liên kết đúng schema, failed có error, result của command khác bị reject. Bỏ result as any; xây operation hoàn chỉnh trước khi emit, không thêm error sau event.
7. **R7:** parse-for-execution bắt buộc session/turn/nonce binding đầy đủ và tool inventory/schema của host. Syntax-only inspection không được nối trực tiếp executor. Reject stale/duplicate/ambiguous/oversized control payload; nonce không tự cấp quyền workspace.

Thêm regressions tái hiện bug trước/sau, chạy source build mới. Giữ các cải thiện đã có và thay đổi của người khác. Cập nhật remediation report đúng phạm vi; “lint” hiện là typecheck lặp lại thì ghi rõ hoặc bổ sung lint rules cần thiết, không gọi đó là coverage 100%.

## 3. Sau sửa, thực hiện G2-B — native gate

- Xác nhận đúng surface/version trên máy; VS Code extension không mặc định đồng nhất mọi Antigravity app/IDE.
- Tìm cơ chế model/endpoint/provider có nguồn chính thức hoặc config/source xác minh được. CLI/SDK không chứng minh native IDE.
- Tạo workspace/config probe riêng; endpoint overrides có baseline và mỗi biến riêng, port/process identity đúng phần mình sở hữu.
- Từ **chat native IDE**, gửi prompt synthetic đến local bridge; decode request/stream theo schema có nguồn. Trả response fixture vào đúng chat và nhận tool read-only request/result của đúng executor.
- Đối chiếu session/turn/call ID; phân biệt inference với userInfo/catalog/readiness. Không mark gate đạt bằng HTTP 200, tên endpoint hoặc validation failure.
- Ghi route/model-picker support thực tế và rollback. Không patch binary, chặn TLS, lấy credential hoặc thay route đang dùng mặc định. Nếu cần thay config đang dùng, chuẩn bị diff/backup/rollback trước khi hỏi xác nhận.

Nếu route không đạt, thu đầy đủ evidence và reason theo version. Đừng tự chuyển scope hoặc giả lập success. Vẫn tiếp tục browser gate độc lập nếu có ích và đã được phép.

## 4. G2-C — browser gate thật

- Profile riêng; người dùng tự login/MFA khi cần. Hỏi thao tác cụ thể và tiếp tục việc độc lập trong lúc chờ; không lấy cookie từ profile đang dùng, không coi im lặng là login/approval.
- Browser host có bằng chứng login dùng được; xác minh URL/composer/account/model bằng positive evidence đúng surface, không generic textarea hoặc hardcode status.
- Thử 3 lượt text/markdown/code fence trong cùng phiên và một lượt cancel, đọc đúng response của lượt vừa gửi; không resend accepted prompt để sửa DOM.
- Thay Promise<never> stub bằng adapter contract thực sự, có submission receipt, status/response/cancel/error/deadline và cleanup.
- Kiểm tra custom apps/MCP eligibility trên account thật nếu cần; chưa thử thì unverified. Custom MCP không tự chứng minh gọi localhost/IDE executor. Đường envelope chỉ mở khi authority/control schemas đã đạt.

## 5. G2-D/E — ghép end-to-end khi gate native/browser đạt

Thực hiện đúng host protocol đã chứng minh. Không mặc định OpenAI Responses/SSE hoặc tự chạy shell/fs để thay executor IDE.

Luồng bắt buộc trong fixture workspace tách biệt:

```text
Native IDE prompt → bridge → Gemini Web thật
→ read file bằng executor IDE → tool result về Gemini
→ patch file bằng executor IDE → chạy test
→ final reply trong native IDE phản ánh exit code thật
```

- Read-only tool loop đạt trước rồi mới mở patch/run-test theo approvals của host.
- Chạy một test PASS và một test FAIL có chủ đích; final không báo thành công giả.
- Tool inventory/workspace authority đến từ host; repo content/prose không tự cấp tool/quyền.
- Bind session/turn/request/call IDs, dedupe đúng; mutation chưa rõ outcome không tự retry.
- Streaming/completion/cancel có nguồn thực tế; không bịa reasoning/token usage/context limit. Pending tool chặn completion.
- Thử invalid args, stale binding, request trùng, cancel đang generating/tool pending, mất kết nối và DOM lỗi.

## 6. Bằng chứng phải bàn giao

Tạo/cập nhật:

1. `docs/evidence/g2-review-remediation.md`: R1–R7, patch, regressions và checks.
2. `docs/evidence/g2-native-browser-gates.md`: mỗi criterion PASS/FAIL/NOT_TESTED/UNSUPPORTED, version, schema source và trace metadata đã redact.
3. `docs/evidence/g2-end-to-end-validation.md`: read/patch/test pass/fail/final/cancel, actual file changes và exit codes. Nếu chưa chạy được, ghi NOT TESTED cùng blocker, không làm artifact giả.
4. ADR cho native protocol/browser host/tool transport đã lựa chọn bằng chứng.
5. README phản ánh giai đoạn thực tế; không dùng báo cáo G1 để gọi G2 complete.

Chạy build/typecheck/tests/probe regressions và mock demo; phân biệt unit/mock, protocol fixture và live account. Không dump token/cookie/raw prompt/tool output người dùng; dùng dữ liệu synthetic và metadata đã sanitize.

## 7. Phạm vi và dừng

Được sửa root checks, contracts/runtime/native/browser/bridge, probes/fixtures và evidence cần cho G2. Không ghi đè renderer hoặc thay đổi người khác; không tự commit/push/publish, không đưa secret/profile vào Git.

Không dựng UI/installer/auto-update/subagents/compaction để thay việc chứng minh native. Không làm G3–G5.

Dừng sau G2 verified hoặc báo gate chưa đạt có bằng chứng cụ thể. Báo chính xác: remediation đã xong bao nhiêu, native/browser gate nào đạt, phần G2 còn thiếu, và cần người dùng làm gì nếu thực sự bị chặn. Không báo “G2 xong” chỉ vì số test tăng.
