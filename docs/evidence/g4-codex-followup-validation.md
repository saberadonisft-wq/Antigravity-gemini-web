# G4 — Codex followup validation

Ngày 15/10/2026. Snapshot remediation **146 tests** trước đợt acceptance tiếp theo. Trạng thái hiện tại đã chuyển sang **148 tests / G4-A launcher-control-fixture VERIFIED** theo [nghiệm thu mới](g4-acceptance-validation.md); nội dung bên dưới giữ để đối chiếu lịch sử. [Review](G4_CONTINUE_CODE_REVIEW.md). Số 133 trong báo cáo Gemini là baseline trước review.

| Check | Kết quả mới |
|---|---|
| npm run build | PASS; root và launcher artifacts |
| npm test | **146/146 PASS**, 0 fail/skip: contracts 8, browser 22, bridge 4, native 1, runtime 79, launcher 32 |
| npm run typecheck | PASS |
| npm run lint | PASS; vẫn tsc --noEmit |
| npm run test:desktop | PASS, Electron 44.7.2 thật, embedded Node 24.21.0 |
| Python | Không rerun; probes/shim source không đổi ở đợt này, không biến evidence cũ thành kết quả mới |

Watchdogs: build 60s, tests 90s, static 45s/command, desktop 90s + cleanup 5s. Chỉ cleanup owned runner/profile; không kill toàn bộ Node/Chrome. Sau checks không quan sát tiến trình Electron/Chrome khớp các prefix fixture/smoke còn sống; không audit mọi tiến trình trên máy.

## Những hành vi được đo

- ACK/operation receipt có trước khi blocked browser effect hoàn tất; duplicate chỉ dispatch một lần.
- Terminal ledger write thất bại sau settings effect → unknown, không báo success, không cho mutation tiếp. Shutdown/restart không resend.
- Cancel hai session khác nhau: callback chỉ kết thúc đúng operation; callback muộn không đổi terminal.
- Owned key bị external edit: restore reject và file byte-for-byte không đổi. Journal lỗi chặn write; deleted install target không tái tạo. Unsafe scope/TTL/schema/revision/confirmation bị từ chối.
- Persistent fixture file lock gây test failure; unowned directory không bị xóa.
- Renderer hung operation fetch có deadline, error copy theo locale không render raw payload.
- Unit focus handler dùng production helper; owned browser yêu cầu Page.bringToFront, racing external target detach. Không phải OS foreground/two-process proof.

CDP method đối chiếu với [primary protocol source](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json); method chỉ activate page/tab, không chứng minh Windows foreground behavior.

## Electron smoke thật

[JSON](g4-desktop-smoke/desktop-smoke.json), [English/light](g4-desktop-smoke/launcher-english-light.png), [1280×800](g4-desktop-smoke/launcher-1280x800.png), [1024×720](g4-desktop-smoke/launcher-1024x720.png), [800×600](g4-desktop-smoke/launcher-800x600.png). Đã xem ảnh English/light. Hidden compositor được chờ cập nhật trước capture; không dùng ảnh frame cũ làm proof.

- 6-method sandbox preload/IPC, typed rejection và subscriptions/unsubscribe.
- React Settings save/reload; draft tồn tại khi external revision đổi và Save conflict.
- UI lưu English, document.lang=en qua reload; đủ 5 view headings và lỗi CONFIG_CONFLICT bằng English.
- Native E2E button disabled khi route unverified; backend tiếp tục reject.
- 5 views × 3 logical viewports không horizontal viewport overflow; Tab focus.
- 18 CSS text/background pairs ở light/dark đạt ≥4.5:1. Primary trên primary: light 15.80:1, dark 16.02:1; secondary/tertiary thấp nhất light 4.92:1, dark 4.95:1. Không chứng nhận WCAG toàn bộ.

Có một smoke failure do harness khai báo selector lặp và một failure do contrast thực 4.499918:1; đã sửa harness/màu, giữ assertions rồi chạy lại thành công. Không sử dụng retry warning để bỏ qua cleanup lỗi, không tuyên bố “0 flaky”. Failure fixtures trước không đủ chứng minh nguyên nhân EPERM cho mọi trường hợp.

Smoke dùng app data temp và controlled closed browser; không account Google, prompt thật, native executor hoặc Save dialog thao tác tay.

## Gate

Desktop control verified trong phạm vi trên. **G4-A toàn bộ PARTIAL**, còn acceptance cases trong review. **G4-B BLOCKED/NOT_TESTED**; missing IDE handshake là giả thuyết, live account chưa refresh. Dừng G4, không G5.

[Prompt tiếp tục G4](../archive/prompts/GEMINI_G4_CONTINUE_PROMPT.md).
