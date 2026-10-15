# Prompt Gemini — G4: launcher, IPC và backend có kiểm chứng

Dán phần sau vào Gemini có quyền truy cập workspace.

---

Tiếp tục tại `D:\Antigravity-gemini-web`. Thực hiện G4 theo kế hoạch dưới đây và dừng sau G4. Giữ các bản vá Codex, code của người khác và mục tiêu **Gemini Web làm nguồn suy luận trong chat native Antigravity IDE**; executor, workspace và approval vẫn thuộc IDE.

## 0. Đọc trước và kiểm kê

Đọc theo thứ tự:

1. `docs/evidence/g3-codex-remediation-validation.md` — mốc kiểm chứng mới nhất.
2. `docs/evidence/G3_CODE_REVIEW.md`, `docs/adr/0003-session-recovery-context-policy.md`.
3. `docs/IMPLEMENTATION_PLAN.md`, phần G4; `docs/UI_RUNTIME_CONTRACT.md`.
4. `docs/GEMINI_UI_HANDOFF.md`, `docs/GEMINI_UI_PROMPT.md`.
5. Shared contracts, runtime/client, context/journal/coordinator, browser adapter/driver và tests G3/G2.

Đọc AGENTS.md đang có hiệu lực. Nếu có `.codegraph/`, dùng CodeGraph trước khi locate/read code; không tự index.

Baseline Codex: **84 TS tests PASS** (8 contracts, 20 browser, 4 bridge, 1 native, 51 runtime), **5 Python safety**, **9 shim**, **3 probe verifications**; build/typecheck/lint pass. Lint hiện chỉ là tsc. Tự kiểm chứng, không chép số pass vào báo cáo khi chưa chạy.

Tại mốc này `apps/launcher` chưa có. Nếu hiện đã có renderer/thay đổi mới, khảo sát và ghép chúng, không ghi đè. Không báo renderer đã được bàn giao khi chưa tìm thấy.

Phân loại ngay:

- **G4-A:** triển khai/kiểm chứng launcher, preload IPC, local settings/export và control commands thực sự có backend. Có thể hoàn thành khi Google chưa login hoặc native route chưa thông.
- **G4-B:** native/live acceptance. Native inference vẫn UNRESOLVED/NOT_TESTED; Google login là trạng thái báo cáo trước, cần check mới nếu muốn xác nhận. Không đủ gate thì ghi BLOCKED/NOT_TESTED; không đổi sang fake success.
- G3 core mới được test ở cấp component; chưa có native chat orchestration gọi đầy đủ các services. Ghép runtime service theo G4-A và test đường gọi đó bằng owned fixtures, không tuyên bố native đã tích hợp.

Lập `docs/evidence/g4-entry-status.md` trước khi bắt đầu.

## 1. Phạm vi và cấu trúc

Prompt này giao cả phần ghép desktop, mở rộng phạm vi renderer-only trong UI handoff cũ:

- `apps/launcher/renderer/**`: React + TypeScript strict + Vite, styles/assets/UI tests.
- `apps/launcher/main/**`, `apps/launcher/preload/**`: Electron main và preload.
- Được bổ sung facade/services/transport tests trong `packages/runtime/**`, shared contracts/changelog khi cần, và root workspace/scripts/lockfile để build đồng bộ.
- Chỉ sửa browser/bridge/native packages khi cần compatibility hay lỗi chứng minh được. Giữ 13 browser concurrency regressions và các bản vá G3; không viết lại driver.
- Không thực hiện installer, auto-update, G5, commit/push/publish. Không sửa binary, trust store, IDE/profile chính, sao chép cookie, tự điền credential hoặc vượt MFA.
- Không thay mục tiêu bằng Gemini API, CLI/SDK inference, agent shell tự chạy tools hoặc chat app độc lập.

Chọn dependency tối thiểu, pin phiên bản tương thích, ghi rõ nguồn/attribution nếu lấy code từ repo tham khảo `miuuyy/codex-chatgpt-web` (snapshot tham khảo trong README). Dùng shared types; không duy trì một bản contract copy riêng trong renderer.

## 2. Main/preload và runtime facade

Tạo một `LauncherClient` transport theo `packages/contracts/src/client.ts`:

`getSnapshot / execute / getOperation / getSessions / getActivity / subscribe`.

- Preload chỉ expose những methods này qua contextBridge; không expose ipcRenderer, invoke channel tùy ý, filesystem/shell, cookie, CDP, profile path hoặc nonce.
- Main validate input/output bằng shared Zod schemas. Kiểm tra sender WebContents + main frame + origin/app surface; renderer/subframe lạ bị từ chối.
- Cửa sổ local: nodeIntegration=false, contextIsolation=true, sandbox=true; CSP hạn chế; chặn navigation/popups/permissions ngoài allowlist. Dev server chỉ dùng origin loopback được cấu hình; packaged UI dùng app protocol cố định.
- Main giữ browser adapter/runtime; renderer không import runtime/browser/Node packages hoặc chạy JS trên Gemini DOM.
- IPC listeners/subscriptions có dispose; hủy khi renderer destroy/reload. Clone dữ liệu, không gửi Electron event object hoặc raw exception/stack sang UI.
- Bundle preload cho sandbox; kiểm chứng build thực tế. Kiểm tra Node/WebSocket/fetch trong process chạy CDP; runtime cần Node >=22. Không tắt sandbox để chữa dependency.
- Demo dùng mock client có nhãn cố định. Live thiếu preload/contract mismatch phải báo lỗi; không fallback mock.
- Renderer demo độc lập dùng mock thuần browser + shared types; mock engine Node hiện có chỉ dùng ở main/test, không import runtime index có fs/CDP vào Vite.
- Main startup/shutdown idempotent, một runtime owner. Làm second-instance/window reload không tạo browser/operation trùng; cleanup có timeout và chỉ dọn process do ứng dụng sở hữu.

Cơ sở API/security: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [Electron IPC](https://www.electronjs.org/docs/latest/tutorial/ipc). Khi chọn dependency, xác minh compatibility trên official docs/version thực tế.

Ghép G3 vào **đường gọi runtime service có test**, không chỉ export classes:

- Một coordinator cho mỗi binding session/conversation; cùng runtimeInstanceId cho journal owner. Journal single-writer, không mở nhiều writer vào cùng file.
- `fingerprintPayload` đầy đủ, context preflight trước submission, commit journal trước dispatch, transitions mang epoch và full host authority.
- Không đưa prompt/context hoặc nonce/tool inventory thành control command công khai cho renderer. Host context chỉ từ adapter đã xác minh hoặc owned test fixture.
- Browser/CDP disconnect, runtime close và late completion đi qua retirement/recovery; không auto replay.
- Giữ tombstones/ledger bounded. Không tạo session mới chỉ để bỏ qua unresolved generation; account/model/target/conversation đổi phải yêu cầu rebind hoặc báo chưa hỗ trợ.
- Tool dispatch vẫn chặn ở native adapter chưa verified. Fixture executor có ledger call IDs bắt buộc, host allowlist và số lần thực thi đo được; syntax-only parser không được cấp quyền execution.

## 3. Command nào live được, command nào phải khóa

| Command | Yêu cầu G4-A |
|---|---|
| browser.open | Mở/focus browser profile độc lập, visible để người dùng login; không coi opened là signed_in/route verified. Coalesce, kiểm tra target/profile và ownership. |
| account.check | Status-only, không gửi prompt hoặc tự spawn browser từ checkStatus; phân biệt unknown/signed_out/challenge/signed_in, browser state riêng. |
| runtime.check connection | Trả từng check thật. Host chưa đo là not_run; diagnostic operation succeeded không đồng nghĩa tất cả checks passed. |
| runtime.check end_to_end | Chỉ hoạt động khi native/live gates đủ. Hiện phải trả lỗi đúng, không mô phỏng native tools. UI nói rõ phép kiểm tra có thể gửi tin thử. |
| settings.update | Lưu allowlisted settings tại app data riêng, revision conflict, atomic commit; persistence lỗi phải fail. Theme/language/log level không thay route/profile/roots. |
| activity.export | Main mở Save dialog; cancel dialog không báo đã export. Xuất metadata đã sanitize; không raw prompt/tool output/token/URL hội thoại. Capability chỉ available sau exporter thật. |
| integration.preview/apply/restore | Native route hiện unverified: UI disable và backend reject. Có thể test transaction bằng file cấu hình synthetic trong temp; không cài shim rồi gọi đó là inference connected. |
| model.select / cancel native | Chưa có verified provider/host turn: giữ disabled/reject. Demo có thể minh họa; không giả model switch hay terminal cancel trong live. |

Các operation dài phải ack operationId sớm, phát progress/result thật, giữ requestId khi retry và conflict khi đổi payload. Event-driven state, không dùng setTimeout/progress giả. Deadline chỉ được dùng để báo timeout.

Khi renderer reconnect/reload, tra operation cũ trước; không resend mutation. Qua main restart mà chưa có operation journal chứng minh thì giữ outcome_unknown, không hứa exactly-once. Journal turn không được dùng như control-operation journal mà không có schema và identity rõ.

Nếu triển khai config transaction fixture: preview có opaque ID/hash/revision/expiry; apply chỉ sau confirm và không active turn; reject khi file bị sửa ngoài; rollback đúng thay đổi, không ghi đè unrelated edits. Cả suite chỉ dùng đường dẫn tạm đã kiểm tra, không settings IDE thật. Không bật nativeRoute capability từ fixture.

## 4. UI launcher

Màn hình: onboarding, overview, sessions/tasks, activity, settings.

- Onboarding kiểm tra IDE → mở browser đăng nhập → xem kết quả connection. Native chưa verified thì không có trạng thái hoàn tất/kết nối xanh.
- Overview tách runtime, native route, browser/account, model. Unknown không hiển thị zero hay model/quota đoán.
- Task list theo workspace/session; state từ shared schemas, bao gồm reserved/accepted/streaming/cancel_requested/cancel_confirmed/interrupted/outcome_unknown. Không sao chép chat IDE.
- Cancel pending chờ acknowledgment terminal; outcome_unknown dẫn tới Activity, không có retry tất cả.
- Activity có lọc/pagination/empty/error, correlation ID. Main export đã sanitize; UI render text an toàn.
- Settings theme system/light/dark, vi/en, diagnostic level; model selector chỉ từ verified catalog. Lỗi persistence/revision không mất lựa chọn đang sửa.
- Live thiếu backend/capability có lý do cụ thể. Demo luôn ghi “Demo · dữ liệu mô phỏng”, kể cả ảnh bàn giao.
- Kiểm tra 1280×800, 1024×720, 800×600, chuỗi dài, keyboard/focus/modal restore, reduced motion, loading/offline/error. Không spinner vô hạn hay phần trăm giả.

## 5. Kiểm thử bắt buộc, có deadline

Trước test, build source để không test dist cũ. Các scenario browser chỉ dùng owned fixtures/profile tạm, đăng ký cleanup trước assertion.

1. Renderer → preload → main → runtime → operation/event → renderer thực sự đi qua IPC.
2. Reject invalid payload/version, unknown IPC channel, wrong sender/origin/subframe; no shell/CDP/secret exposure.
3. Live thiếu preload không dùng mock; route unverified chặn install/model/native cancel cả UI lẫn main.
4. Browser opened nhưng login required, check không spawn, unknown host không passed.
5. Duplicate request click/reload coalesce; cùng ID khác payload conflict; progress/terminal không tự thành success.
6. Subscribe-before-snapshot buffer; drop <= watermark/duplicate/retired instance, replay contiguous; reconnect/gap/failure/timeout không treo waiter.
7. Runtime facade thực sự gọi G3 coordinator/context/journal; crash sau Send không gửi lại, old epoch không chạy tool, write failure không dispatch. Assert Send/executor counters, không chỉ assert enum.
8. Settings restart/revision/write failure; export Save/cancel/sanitization (dùng save destination mock/temporary).
9. Config preview/apply/restore fixture conflict/expiry/active turn/rollback nếu có implementation.
10. Renderer reload/window close/app quit khi operation chạy: dispose listener, retire epoch, cleanup owned children; attached browser chỉ disconnect.
11. UI keyboard, viewport và trạng thái pending/error/offline; có bằng chứng trực quan desktop thật, phân biệt demo và live control.

Mỗi test/scenario tối đa 30s; suite tối đa 90s, cleanup có budget riêng tối đa 5s. Dùng runner watchdog và dọn cây PID do runner tạo; không kill toàn bộ Chrome/Node/Python. Nếu command vượt budget, stop, chẩn đoán và sửa trước khi chạy lại; không chờ nền vô hạn.

Chạy build/typecheck/lint/tests root sau sửa; giữ 84 TS regressions baseline. Chạy UI/IPC tests mới. Python/shim chỉ chạy lại khi chạm phần liên quan hoặc cần compatibility. Báo số pass đúng, test skipped/fixture không tính live.

## 6. Bằng chứng và điều kiện dừng

Bàn giao:

- `apps/launcher/README.md`: lệnh chạy/build demo/live, cấu hình app data/profile tách biệt, cách đóng/cleanup.
- `apps/launcher/renderer/UI_NOTES.md`, `CONTRACT_REQUESTS.md` và attribution/license nếu có.
- `docs/evidence/g4-entry-status.md`, `g4-launcher-ipc-validation.md`, `g4-ui-validation.md`, `g4-live-validation.md`.
- ADR main/preload/runtime ownership/shutdown và changelog contract nếu đổi.
- README cập nhật đúng implementation/fixture/live và commands mới.

G4-A chỉ PASS khi launcher chạy được, IPC/main validation và backend commands được test trên đường gọi thật; các capability chưa có vẫn disabled/reject. Không coi renderer mock-only là G4-A desktop PASS.

G4-B chỉ PASS khi có native inference và Gemini Web live E2E đã kiểm chứng, gồm read/patch/test pass và fail qua executor IDE. Chưa đủ thì ghi BLOCKED/NOT_TESTED với nguồn/thời điểm evidence; hoàn thành các việc G4-A không phụ thuộc login, rồi báo blocker.

Không cần chờ người dùng login để làm UI/IPC. Nếu cần login để chạy phần live, hướng dẫn mở đúng profile và chờ thao tác thủ công; không làm auth thay người dùng. Không tự sửa IDE chính, không triển khai G5, không commit/push.

Kết thúc bằng danh sách file thay đổi, checks/timeouts/resources, trạng thái G4-A/G4-B riêng và việc còn thiếu. Đừng viết “Gemini Web đã tích hợp vào chat native” khi mới có launcher/launch hook/fixture.
