# Prompt Gemini — sửa review inference/browser và tiếp tục G2

Copy phần dưới vào Gemini có quyền truy cập repository. Chưa chuyển G3.

---

Tiếp tục tại `D:\Antigravity-gemini-web`. Đọc AGENTS.md có hiệu lực; nếu có `.codegraph/` dùng CodeGraph trước khi đọc/tìm code, không tự index. Đọc `docs/evidence/G2_INFERENCE_BROWSER_CODE_REVIEW.md`, observations JSON, `docs/GEMINI_G2_INFERENCE_BROWSER_PROMPT.md` và source hiện tại. Giữ thay đổi người khác.

Mục tiêu vẫn Gemini Web làm nguồn suy luận cho chat native Antigravity IDE, giữ executor/workspace/approvals của IDE. Chưa làm G3–G5. Không chuyển sang Gemini API/agent shell riêng hoặc MCP hỏi model phụ để thay mục tiêu.

Reviewer xác nhận build/typecheck, 32 TypeScript tests, 9 shim tests và 6 G0 unit tests pass. H1/H2 regressions đạt. Nhưng G2 chưa nghiệm thu: V1–V8 trong review đã được đối chiếu hoặc tái hiện bằng controlled probes.

## 1. Sửa sự thật trong báo cáo trước

- Raw inference JSON của cả 4 scenario đều không có port, `rpc_attempted=false`, `TIMEOUT_OR_NO_PORT`. Ghi native inference `UNRESOLVED / NOT_TESTED`; blocker hiện thấy là startup/readiness. Không tiếp tục báo khảo sát đã chứng minh unsupported hoặc MITM bắt buộc.
- Ghi riêng static help/default flags và observation thực nghiệm. Đồng bộ arguments/endpoints giữa Markdown và raw artifact; không biến placeholder thành experiment đã chạy.
- Browser chỉ có fixture happy-path PASS; live và native E2E chưa được kiểm chứng. Bỏ claim 100%/zero-orphans tuyệt đối nếu chưa có assertion/evidence.
- Cập nhật README để phản ánh driver đã có implementation nhưng còn review findings; test counts theo lần thực sự chạy. Không nói login là điều kiện duy nhất còn thiếu.

## 2. Sửa browser correctness trước khi thử tài khoản thật (V2–V6)

### Ownership và surface

- Track owned process/tab và target chỉ attach. Cleanup target attach chỉ disconnect; không `Browser.close` toàn browser hoặc taskkill process không thuộc mình.
- `checkStatus()` không spawn; chỉ attach đúng target được xác minh. Live xác minh exact origin/path của Gemini và evidence DOM cụ thể, không dùng substring/any page/generic textarea để suy ra account.
- Fixture mode riêng với explicit URL allowlist; không để fixture shortcut chạy trên live. Không biết account/model thì giữ unknown/absent; bỏ fallback `Gemini 1.5 Pro`.
- Kiểm chứng bằng owned unrelated textarea page: không được signed_in/ready và không được gửi prompt.

### Completion, cancellation và turn binding

- `pollResponse()` không trả completed khi driver trả `completed=false`, kể cả đã có partial text. Giữ partial trong failure/timeout semantics phù hợp contract.
- Cancel requested khác cancel confirmed. Stop false/throw/disconnect không được báo terminal cancelled thành công. Xác minh generation dừng hoặc cleanup đã hoàn tất.
- Poll đang chờ và cancel phải thống nhất một terminal outcome bất biến. Completed/failed/cancelled turn không được hủy lại hoặc đổi outcome.
- Reserve record trước click Send; serialize conversation hoặc reject BUSY. Cùng turnId/content không resend; cùng ID khác content trả conflict. Bind receipt/poll vào page/conversation/response identity; không gán last response cho hai accepted turns.
- Thêm behavioral regressions cho partial timeout, Stop false/throw, cancel giữa poll, cancel sau terminal, duplicate/conflicting submissions và overlapping turns. Giữ hiện hành typed contract hoặc cập nhật contract/docs nhất quán; không chữa bằng `as any`.

## 3. Sửa probe evidence, logging và deadlines (V1/V7/V8)

- `/generate-health` hoặc path có `cascade` không được làm `inference_route_verified=true`. Tách observed traffic khỏi verified native inference. Gate cần prompt synthetic từ native chat, response decode đúng lượt và read-only tool round-trip qua executor gốc.
- Không in raw LS stdout/stderr. Chỉ metadata allowlist đã sanitize: port/protocol/status/error code. Test synthetic auth/prompt markers trên success/error paths; không dùng secret thật.
- Deadline phải bao phủ connect, RPC, body read và cleanup. Đặt socket/read/body limits cho mock server; incomplete POST không được giữ `shutdown()` vô hạn.
- Cleanup budget hữu hạn, timeout taskkill/child wait và CDP close; connection timeout/error phải đóng transport và xóa state. `isConnected` phản ánh transport thực sự mở.
- Test silent child, incomplete HTTP body, CDP không phản hồi/disconnect và cleanup failure. Ghi scenario budget/cleanup budget thực tế; không gọi 4 giây là strict 3 giây.

## 4. Khảo sát native từ baseline hợp lệ

- Dùng đúng LS native và hash đã xác nhận trong review. Không dùng agy.exe/CLI/SDK để thay bằng chứng của native IDE.
- Xác định launch/init/stdio contract từ bundle/launch trace hoặc chạy IDE trên profile cô lập đã được phép. Xử lý nguyên nhân no-port trước khi lặp lại flag matrix; không đoán payload RPC.
- Baseline phải ready và có synthetic native chat stimulus hợp lệ; sau đó từng override có controls, metadata sanitized và response fixture. Schema/protocol không khớp ghi rõ lỗi; không suy ra endpoint không hỗ trợ từ request chưa gửi được.
- Cân nhắc local provider compatibility bridge theo flags nếu evidence hỗ trợ. Không mặc định TLS interception giữa UI và LS là phương án duy nhất.
- Không patch binary/bundle/trust store hoặc triển khai TLS interception mặc định. Nếu chỉ còn hướng cần can thiệp như vậy, trình evidence và thiết kế cụ thể, chưa thực hiện.
- Nếu baseline chưa ready sau một probe có deadline, báo phase/error/blocker chính xác và tiếp tục phần browser độc lập; không để task chờ vô hạn.

## 5. Kiểm thử và evidence

- Mỗi browser fixture dùng profile tạm và port riêng, owned localhost server; đăng ký cleanup ngay khi cấp phát tài nguyên.
- Lệnh test toàn bộ có watchdog ngoài 90 giây; timeout thì lưu metadata phase và dọn riêng process tree do lệnh tạo. Không dọn tất cả Chrome/Node/IDE trên máy.
- Kiểm chứng tự thoát, owned PID/port/profile đã được dọn; lỗi cleanup phải làm check thất bại, không nuốt để suite xanh.
- Build mới rồi chạy focused regressions, suite liên quan, build/typecheck; không lặp happy path nhiều lần để thay gate evidence.
- Sau khi V2–V8 được xử lý mới kiểm tra Gemini live bằng profile riêng `C:\Users\vhc\.gemini\gemini_web_probe_profile`. Người dùng tự login/MFA; không lấy cookie profile cá nhân. Xác minh lại auth state thực tế, không copy trạng thái SIGN_IN_REQUIRED cũ.
- Nếu có phiên đăng nhập, kiểm chứng 3 lượt text/markdown/code, cancel và response binding thật. Fixture evidence và live evidence phải tách riêng. Chưa login thì ghi NEEDS_USER_ACTION, tiếp tục việc độc lập.
- Chỉ chạy native → browser → IDE read/patch/test PASS-FAIL → final reply khi hai live gates thật đạt. Giữ tool inventory, approvals, session/turn/request/call binding và không retry mutation outcome unknown.

Cập nhật remediation V1–V8 với command/output hoặc safe metadata artifacts; native/browser gate reports, end-to-end report, README và ADR nếu có quyết định đã được chứng minh. Source/artifact hashes ghi theo đúng build được test. Không commit/push/publish, redesign UI, installer hoặc chuyển G3–G5.

Dừng với phần đã đạt/chưa đạt, blocker cụ thể và thao tác người dùng cần làm. Không báo G2 hoàn tất chỉ từ compile/test count/fixture/launch hook.
