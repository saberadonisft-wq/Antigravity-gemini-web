# Prompt Gemini — phần acceptance còn lại của G4

**Cập nhật 15/10/2026:** Checklist acceptance bên dưới đã hoàn tất trong [G4-A validation](evidence/g4-acceptance-validation.md): 148 tests và actual desktop/owned Chrome fixture PASS. Đây là prompt lịch sử, không chạy lại như backlog chưa làm. Để người dùng thử: [G4_USER_TEST_GUIDE.md](G4_USER_TEST_GUIDE.md). G4-B native/Google live vẫn BLOCKED / NOT_TESTED; không tự chuyển G5 hoặc coi login là native route proof.

Tiếp tục D:\Antigravity-gemini-web, dừng G4; không G5/installer/commit/push. Đọc:
1. docs/evidence/g4-codex-followup-validation.md.
2. docs/evidence/G4_CONTINUE_CODE_REVIEW.md.
3. docs/UI_RUNTIME_CONTRACT.md, IMPLEMENTATION_PLAN.md, ADR 0004 và source/tests mới.

Tuân thủ AGENTS.md và CodeGraph nếu có .codegraph/; không tự index. Baseline 146/146 tests, root build/typecheck/lint và desktop smoke PASS. Giữ toàn bộ Codex patches. Đừng ghi toàn bộ G4-A VERIFIED từ số unit tests.

## Phần đã sửa — giữ nguyên

Early ACK có durable operation trước external wait; một ID giữa receipt/engine/event/lastCheck, dedupe full command, terminal write fail → unknown/block, no replay. Settings sync còn trả known rejection. Export ACK chỉ reservation; Cancel dialog là terminal failed/CANCELLED, không thành công export.

Cancellation binding theo session/turn/operation, terminal/stopped guards, UI observation có deadline. Không đem lại fake success timer. Scope config chỉ fixtureRoot trong OS temp; restore check owned values/conflicts/confirmation; journal trước effect, không catch rỗng.

Dirty Settings giữ base revision và explicit discard; localized errors không raw exception. Native E2E disabled và backend gate; color secondary #5f6770 và CSS-driven contrast tests. Fixture cleanup chỉ owned profile, tối đa 5s retry và lỗi phải fail.

## Hoàn thiện acceptance G4-A

- Actual Electron second-instance: launch hai app processes với cùng owned temp userData; xác minh restore/focus handler thật, child exit, single runtime owner và bounded cleanup. Test copy if/show/focus không đủ.
- Reload/close/navigation khi operation/browser/export đang pending: assert subscriptions, receipt terminal/unknown, no late file write, cleanup kể cả publication lỗi. Dùng production paths, không chỉ giả flag isMainFrame.
- Owned Chrome DOM fixture: open/focus/crash/reconnect qua OwnedBrowserAdapter thật; xác minh Page.bringToFront/correct target/ownership và port race. Không attach Chrome cá nhân, không bỏ guard. CDP tab activation không tự chứng minh OS window foreground; ghi scope chính xác.
- Hoàn thiện 10 UI scenarios trên renderer thật: filters/pagination/race/errors, cancel confirmed/failed, offline/reconnect, outcome_unknown, Settings write failure/conflict/reconcile; label demo và vi/en đúng. Không tính tạo mock object là UI acceptance.
- Native Save dialog lifecycle trên app temp nếu có thể thực nghiệm; file export/cancel không lộ path qua renderer/receipt/journal. Nếu chưa thử, ghi NOT_TESTED.
- Keyboard/focus, long text, light/dark/system/reduced-motion và contrast của controls/badges/alerts. Đo computed CSS hiện hành; 18 text pairs không chứng nhận WCAG toàn bộ.
- Diagnostic/provider messages là dữ liệu nguồn, không giả dịch/quota/model. Cần test locale errors và copy khi đổi language; mock data cũng phải được gắn nhãn.

## Native/live gate

Native launch hook chỉ proof launcher/shim, không inference. No port/rpc_attempted=false chỉ UNRESOLVED/NOT_TESTED; missing parent handshake là giả thuyết, không kết luận đóng kín/MITM bắt buộc. Native install/model/host tools remain gated khi chưa verified.

Google login/MFA/CAPTCHA do người dùng thủ công trên app-owned profile port 9223. Không copy cookie/profile G2 port 9222, không Gemini API/CLI/SDK thay mục tiêu. Tiếp tục acceptance fixture độc lập; không đợi login để làm G4-A.

G4-B chỉ PASS khi native chat → consumer Gemini Web → host read/patch/test PASS và FAIL/approvals thật, trace cùng turn/session. Chưa đủ thì BLOCKED/NOT_TESTED.

## Kiểm chứng/bàn giao

Build trước tests; root tests/typecheck/lint, desktop smoke. Suite watchdog 90s + cleanup 5s, chỉ owned process tree. Không skip/nuốt cleanup hoặc nới deadline để che lỗi. Không tuyên bố hết flaky chỉ nhờ rerun xanh.

Cập nhật README/UI_NOTES/CONTRACT_REQUESTS/evidence theo đúng scope unit/fixture/desktop/native-live. Khi mới PASS thêm một flow, ghi flow đó; chỉ chốt G4-A đầy đủ khi các acceptance còn lại có bằng chứng. Dừng G4.
