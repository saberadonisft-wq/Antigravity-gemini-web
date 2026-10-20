# Prompt Gemini — G3: độ bền, phục hồi và ngữ cảnh

Copy phần dưới vào Gemini có quyền truy cập repo.

---

Tiếp tục tại `D:\Antigravity-gemini-web`. Người dùng đã yêu cầu Codex sửa lỗi còn lại và chuẩn bị G3. Giữ các bản vá Codex và thay đổi của người khác.

Đọc AGENTS.md có hiệu lực; nếu có `.codegraph/`, dùng CodeGraph trước khi tìm/đọc code, không tự index. Đọc:

1. `docs/evidence/g2-codex-remediation-validation.md` — mốc mới nhất.
2. `docs/IMPLEMENTATION_PLAN.md`, phần G2/G3; `docs/UI_RUNTIME_CONTRACT.md`.
3. Native/browser gate reports, provider probe report, browser live report.
4. Browser adapter/driver/CDP/selectors, `concurrency.test.ts`, runtime, contracts, model-bridge và native adapter.

Hiện có **50 TS tests PASS** (browser 20), **4 Python safety tests**, **3 probe verifications**, build/typecheck sạch. Native inference vẫn `UNRESOLVED / NOT_TESTED`; Gemini Web chat live và native tool E2E chưa nghiệm thu. Giữ mục tiêu Gemini Web làm nguồn suy luận trong chat native Antigravity IDE, giữ executor/workspace/approvals của IDE. Không thay bằng API/CLI/SDK/agent shell hay MCP hỏi model phụ.

## 0. Checkpoint và phạm vi

- Lập `docs/evidence/g3-entry-status.md`, phân biệt implementation/fixture/live và blockers.
- **G3-A** state/session/recovery/context policy được làm độc lập trên controlled fixtures theo yêu cầu người dùng. **G3-B** live acceptance chỉ chạy khi real G2 gates đủ điều kiện. Không coi prompt G3 là chứng nhận G2 đã pass.
- Native standalone chưa có listening port. Khảo sát launch/init contract từ source/descriptor/launch trace hoặc profile IDE cô lập đã được phép; baseline phải ready trước flag overrides. Thiếu handshake là giả thuyết cho tới khi có controlled comparison.
- Chỉ lưu metadata allowlist: protocol/port/byte count/field names/status/synthetic correlation IDs. Không lưu raw handshake/auth/CSRF/OAuth/cookie/prompt thật. Không patch IDE/binary/trust store hoặc triển khai TLS interception mặc định.
- Nếu baseline vẫn chưa ready sau probe có deadline, ghi phase/error/blocker cụ thể và tiếp tục G3-A; không giả lập adapter success hoặc chờ vô hạn.

## 1. State machine và thẩm quyền

- Chuẩn hóa queue/reserved/submitting/accepted/streaming/tool pending/terminal/cancel requested/cancel confirmed/interrupted/outcome unknown. Map contract nhất quán; đổi schema cần version/migration/tests rõ ràng.
- Dedupe theo runtime instance, workspace/session/turn/request/tool call ID và payload fingerprint. Reserve trước await/side effect. Waiter chia sẻ result/error leader; không unhandled rejection.
- Accepted prompt hoặc tool mutation mất ack không auto resend. Outcome unknown chặn retry và cần reconciliation. Không hứa exactly-once xuyên crash khi chưa chứng minh.
- Terminal bất biến. Late poll/event/tool result từ epoch cũ không đổi kết quả hoặc hồi sinh công việc đã hủy.
- Cancel trước Send, sau Send và trong tool có quy tắc riêng. Chỉ terminal cancelled sau xác nhận dừng/cleanup cần thiết; Stop false/throw/timeout không đổi thành success.
- Host tool inventory/approval là thẩm quyền. Context/model không tạo quyền, mở workspace/tools hoặc hợp thức hóa stale nonce/call ID.

## 2. Session/workspace và recovery

- Bind workspace identity, task/session/turn, browser instance, CDP target, conversation identity và account/model evidence. Không dùng last response toàn trang làm identity.
- Một conversation chỉ có một mutation active; queue bounded có backpressure và cancel queued item rõ ràng. Không đưa hai workspace vào cùng conversation hoặc dùng turn ID đơn lẻ làm global identity.
- Detect page navigation/target close/CDP disconnect/browser crash/account change/model change/IDE restart. Retire epoch/authority cũ; pending ops thành failed/interrupted/outcome unknown đúng bằng chứng.
- Reconnect là attach/reconcile, không resend. Owned process/tab cleanup có budget; attached target chỉ disconnect.
- Journal tối thiểu: version, instance/session/workspace fingerprint, turn/request/call IDs, phase, receipt và terminal metadata. Không persist/export raw credential/profile/prompt/payload theo mặc định.
- Journal write atomic, xử lý partial/corrupt file. Restart phân biệt queued chưa gửi, accepted chưa terminal, mutation unknown; không replay accepted/unknown work.
- Terminal ledger/queue bounded; eviction không mở lại duplicate IDs còn hiệu lực. Snapshot/event resync vẫn đúng contract hiện tại hoặc version mới có migration.

## 3. Context manager — không cắt ngầm

- Nhận context cấu trúc từ host khi contract đã chứng minh: instructions, role/author, history, workspace/task identity, tool results và model metadata.
- Giữ thứ tự/authority host instructions, user messages, tool results. Không trộn workspace; nội dung file/web/model không được coi là host instruction hoặc approval.
- Preflight budget và lỗi `CONTEXT_TOO_LARGE`. Token budget chỉ gọi là chính xác khi có measurement/tokenizer phù hợp model; byte/character estimate phải ghi nhãn estimate.
- Không bê context window/quota/model catalog của repo ChatGPT hoặc tự đặt giới hạn Gemini giả. Unknown model/limit giữ unknown; local safety cap có nguồn và nhãn rõ.
- Compaction/handoff chỉ triển khai khi host contract hỗ trợ và được kiểm chứng. Nếu chưa, fail rõ hoặc có operator action; không âm thầm bỏ history/instructions/tool results.
- Attachment/account/model change: tối thiểu phát hiện và thông báo unsupported/rebind needed; không giả định upload/image/model switching đầy đủ.

## 4. Tests bắt buộc G3-A

Thêm behavioral tests với delayed/failed/disconnected fixtures:

- Duplicate/conflicting requests đồng thời; hai workspace/session cùng turn ID; queue full/cancel queued item.
- Cancel trước Send, accepted/streaming, trong tool read/write; Stop false/throw/timeout; late poll/event không đổi terminal.
- Browser crash/tab close/CDP disconnect; reconnect; queued open/close; cleanup lặp/cleanup failure có retry hữu hạn và không mất ownership.
- Runtime/IDE restart; stale snapshot/event/nonce/call ID; authority cũ bị reject; journal partial/corrupt file và restart giữa accepted/ack.
- Unknown mutation không chạy lần hai; accepted prompt không replay để chữa DOM. Assert số Send/executor calls, không chỉ status.
- Context gần/vượt local cap, unknown model, account/model change; không cắt ngầm hoặc trộn workspace.
- Owned PID/port/temp profile được dọn; cleanup failure làm test fail. Watchdog toàn lệnh 90s; chỉ dọn process tree do chính lệnh tạo.
- Export/log success/error không chứa synthetic quoted cookie/token/prompt/path markers.

Build mới, focused tests, suite liên quan, typecheck. Lint hiện alias typecheck; không trình bày như lint rules độc lập. Checks đã pass thì không lặp happy path để thay evidence live.

## 5. G3-B — live acceptance

- User tự login/MFA profile `C:\Users\vhc\.gemini\gemini_web_probe_profile`; không lấy cookie profile cá nhân. Refresh auth state, chưa login ghi NEEDS_USER_ACTION và tiếp tục việc độc lập.
- Gemini Web thật: đúng surface/account/model evidence; 3 lượt text/markdown/code và cancel; response đúng turn/conversation. Unknown model giữ unknown. Tách live khỏi fixture evidence.
- Native đầu tiên chứng minh synthetic prompt → response fixture → read-only executor round-trip. Tiếp đó native → Gemini Web → IDE read/patch/test PASS và FAIL → final reply đúng exit code/approvals để đạt G2 thật.
- Khi route đạt, thử 10 task nhỏ liên tiếp; ghi từng failure/latency/retry và cancel/reconnect/crash/restart/stale authority.
- Scenario live chưa chạy ghi NOT_TESTED cùng blocker. Không nâng runtime mock thành PASS hoặc nghiệm thu Gate G3 live khi native/browser E2E chưa đạt.

## 6. Bàn giao và dừng

Cập nhật:

- `docs/adr/0003-session-recovery-context-policy.md`: state/identity/journal/reconciliation/context decisions và giới hạn evidence.
- `docs/evidence/g3-resilience-validation.md`: commands/counts/behavior/resource outcomes.
- `docs/evidence/g3-context-validation.md`: measurement/cap source, role/workspace preservation và compaction unsupported nếu chưa chứng minh.
- `docs/evidence/g3-live-validation.md`: live acceptance/blockers; entry/native/browser/E2E reports và README theo sự thật mới.

Được sửa runtime, gemini-browser, model-bridge, contracts, probes/tests/docs trong phạm vi này; giữ thay đổi người khác. Native adapter chỉ triển khai route có evidence, không thay executor. Không redesign UI/launcher, installer/auto-update, publish, commit/push hoặc chuyển G4–G5.

Dừng với files changed, checks, G3-A đạt/chưa đạt, G2/G3-B live đạt/chưa đạt, blocker và user action cần thiết. Không claim mọi lỗi đã hết hoặc production-ready từ test count.
