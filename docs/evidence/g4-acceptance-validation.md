# G4-A — Desktop acceptance hoàn tất

Ngày 15/10/2026. Tiếp nối [review](G4_CONTINUE_CODE_REVIEW.md) và [bản vá trước](g4-codex-followup-validation.md). **G4-A VERIFIED trong phạm vi launcher control, UI và browser fixture dưới đây; G4-B BLOCKED / NOT_TESTED.** Đây chưa phải tích hợp chat native Antigravity với Gemini Web thật.

Cập nhật sau khi người dùng test: [bản vá startup cache](g4-electron-cache-validation.md), explicit userData/sessionData và thoát secondary process trước cache init. Build/148 tests/desktop regression đã rerun; có thêm `npm run test:desktop-cache`.

## Kiểm chứng mới

| Lệnh | Kết quả |
|---|---|
| `npm run build` | PASS, packages + renderer/preload + isolated acceptance bundle |
| `npm test` | **148/148 PASS**, 0 fail/skip: contracts 8, browser 22, bridge 4, native 1, runtime 80, launcher 33 |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS; hiện là `tsc --noEmit`, không có lint rules riêng |
| `npm run test:desktop` | PASS trên Electron 44.7.2 / embedded Node 24.21.0 / Chromium 152.0.7977.149 |
| Python probes/shim | Không rerun; source Python/C# không đổi trong đợt acceptance này |

Watchdogs giữ nguyên: build 60s, tests 90s, static 45s/command; desktop 90s + cleanup 5s. Owned Chrome test có timeout 45s, crash/CDP/process-exit có budget 5s, mỗi CIM query tối đa 2s. Không skip hay kéo dài timeout để biến failure thành PASS.

## Electron và Windows thật

[Lifecycle JSON](g4-desktop-smoke/desktop-lifecycle.json), [Save/Cancel JSON](g4-desktop-smoke/desktop-dialog.json), [core smoke JSON](g4-desktop-smoke/desktop-smoke.json).

- Khởi chạy hai Electron processes cùng owned temp userData. Process thứ hai exit 0; production handler restore cửa sổ đang minimized và focus cửa sổ thứ nhất. Runtime instance ID giữ nguyên.
- Reload webContents khi browser operation đang pending; navigation main-frame khi export đang pending. ACK có operation chạy thật, subscription được gỡ rồi tạo lại đúng một lần; host vẫn sở hữu operation.
- Đóng cửa sổ khi export chooser còn pending. Sau shutdown, receipt là `outcome_unknown`, subscriptions bằng 0, chooser trả muộn không ghi file.
- Hộp thoại Save của Windows thực tế: Save ghi JSON tại destination temp do main cấp; Cancel không ghi, terminal operation là `failed/CANCELLED`. Renderer và operation receipt không chứa destination.
- Helper chỉ thao tác dialog đúng PID/title; xác minh Win32 class, child HWND và PID trước `SendMessageTimeout`. Không điều khiển dialog của ứng dụng khác hoặc chạm recent-file list.

## Chrome thật trên DOM fixture sở hữu

[OwnedBrowserAdapter acceptance test](../../tools/archive/packages/runtime/src/owned-browser.fixture.test.ts) dùng Chrome headless, random CDP port và OS temp profile `g4-owned-browser-*`. Không tài khoản Google hay `gemini.google.com`.

Open lặp giữ nguyên owned page/marker; `Page.bringToFront` chạy qua adapter thật. Sau một fixture turn hoàn tất, kill đúng spawned root bằng `ChildProcess.kill("SIGKILL")`, quan sát exit/CDP disconnect, rồi mở lại với PID mới. Page marker cũ không tồn tại và số user-query bằng 0 trước prompt mới: không replay prompt cũ.

CIM chỉ trả PID + creation time của root/descendants hoặc profile fixture. Test kiểm tra những identities đó đã biến mất sau crash và cleanup; PID reuse không được coi là cùng process. Đây là page activation và crash/reconnect proof, **không phải Windows foreground proof cho Chrome**, cũng không phải native/live inference proof. Crash trong lúc host đang ghi file vẫn chưa được nghiệm thu native.

## UI thật với backend fixture có nhãn

[UI JSON](g4-desktop-smoke/desktop-ui.json), [tools light](g4-desktop-smoke/launcher-fixture-tools-light.png), [tools dark](g4-desktop-smoke/launcher-fixture-tools-dark.png), [live control English](g4-desktop-smoke/launcher-english-light.png). Các ảnh này đã được xem để đối chiếu.

Isolated fixture bundle mount chính React App; không preload, không sender được cấp quyền IPC. Protocol chỉ phục vụ bundle này khi smoke chạy trong owned temp sandbox. Production renderer không có fixture controls/global và public LauncherClient vẫn 6 methods.

| Scenario | Bằng chứng trên rendered DOM |
|---|---|
| `first_run` | Chưa đăng nhập, native E2E disabled |
| `login_required` | Action Required |
| `signed_in_route_unsupported` | Signed in và unsupported đồng thời; native E2E vẫn disabled |
| `connection_ready_no_sessions` | Empty sessions |
| `turn_generating_tools` | Cancel requested → confirmed; failure giữ typed error và cho hủy lại |
| `cancel_requested` | Pending cancellation, không gửi cancel lần hai |
| `config_conflict_or_model_unavailable` | Conflict, model picker disabled |
| `runtime_disconnected` | Mutations disabled; nút Reconnect lấy snapshot instance mới |
| `browser_ui_changed_context_too_large` | Browser failed, lỗi CONTEXT_TOO_LARGE hiển thị |
| `outcome_unknown_write` | Không Retry All; View Activity bind đúng session |

Các flow thêm: Settings write failure giữ draft; conflict/reconcile và locale save/reload trên production IPC; Activity 50→60 rows, severity/session filters, request slow đã phát trước request fast và late response không overwrite; reload sau failure; clipboard failure và typed export cancellation.

Picker đủ 10 nhãn VI/EN theo settings language; technical identifiers và source diagnostics vẫn là dữ liệu nguồn. Không giả dịch chẩn đoán thành kết quả khác. Native Save title cũng theo locale, nội dung nút hệ điều hành theo Windows locale.

## Accessibility và layout được đo

- 5 production views tại **1280×800, 1024×720, 800×600**; long workspace fixture tại ba kích thước tương tự. Harness chờ `innerWidth/innerHeight` đúng trước lấy số đo, không tính hai mẫu 1024 là mẫu 800.
- Light/dark: **576** computed contrast measurements trên 32 theme/scenario/view combinations, gồm hover Cancel. Minimum **4.5166:1**. Demo subtitle đã bỏ opacity 0.85 (trước 3.4613:1); dark Cancel đổi nền #f85149 (trước 3.3522:1) thành #b62324 (sau 6.4518:1). Nút danger dùng chữ trắng/nền đỏ đậm ở cả normal và hover, tránh cặp màu trung gian thiếu contrast; badges danger vẫn dùng palette riêng.
- System theme theo emulated dark preference. Reduced-motion áp dụng trên 12 controls: computed animation/transition duration 0.01ms.
- Cửa sổ thật có focus: Tab từ Overview sang Onboarding, `:focus-visible` và box-shadow 3px; Enter kích hoạt navigation bằng Chromium key events. Kiểm tra labels liên kết controls trong Settings và scenario picker.

Các phép đo trên không chứng nhận WCAG toàn ứng dụng, screen-reader audit hay hết flaky. Disabled controls bị loại khỏi contrast scan; không tuyên bố đã đo mọi pixel, mọi trạng thái hover hoặc mọi chuỗi diagnostics.

## Failure đã xử lý và ranh giới bàn giao

Trong quá trình kiểm chứng có failure do contrast thật, locator UIA của Windows expose Edit/Button thành Pane, thao tác keyboard trên hidden window, resize chưa đến viewport yêu cầu, và taskkill `/T` race khi sandbox child đang thoát. Đã sửa màu, helper, harness focus/key-char/viewport waits và crash observation; giữ assertions, cleanup và deadlines. Không dùng rerun xanh để tuyên bố “0 flaky”.

Sau kiểm chứng không quan sát process Electron/Chrome khớp owned fixture/smoke prefixes còn sống; không audit toàn bộ tiến trình trên máy. **Native inference UNRESOLVED / NOT_TESTED**, Google account chưa refresh, host read/patch/test PASS+FAIL/approvals chưa có trace end-to-end. Native capabilities vẫn gated. Không sửa IDE chính, copy cookie, G5/installer hay commit/push.

Để người dùng thử bản hiện tại: [G4 user test guide](../archive/guides/G4_USER_TEST_GUIDE.md).
