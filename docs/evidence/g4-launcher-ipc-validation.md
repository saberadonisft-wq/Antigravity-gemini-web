# G4 — IPC và runtime control

Cập nhật 15/10/2026. [Review trước](G4_CONTINUE_CODE_REVIEW.md), [validation hiện tại](g4-acceptance-validation.md). **148 tests PASS**; runtime 80, launcher 33. G4-A launcher/control/fixture VERIFIED.

Sandbox preload expose 6 methods; main derive actual frame/sender/origin, exact allowlist, validate input/output và redact diagnostic data. SDK smoke xác nhận typed rejection, event subscribe/unsubscribe, settings save/reload và locale. Engine và facade dùng một operation ID từ requestId; fingerprint kiểm tra full command.

Browser/check/export/cancel reserve queued receipt bền vững rồi ACK trước external wait. Accepted không phải success. Terminal operation được commit trước publication; lỗi persistence → unknown và block mutation. Settings sync còn trả known rejection. Export dialog Cancel được quan sát là terminal failed/CANCELLED, không báo xuất thành công.

Cancellation binding session/turn/operation, terminal/stopped guards; stop vẫn cleanup-owned-adapter khi state publication lỗi. Default OwnedBrowserAdapter gọi Page.bringToFront chỉ trên owned target, port race target ngoài chỉ detach.

ConfigTransactionService yêu cầu fixtureRoot trong OS temp, paths/link/TTL/schema/revision checks, journal trước write, confirmation và owned-key conflict trước restore. Không expose installer/native API.

Source proof: [runtime regressions](../../tools/archive/packages/runtime/src/g4-followup.test.ts), [IPC boundaries](../../tools/archive/launcher-r44/main/g4-boundaries.test.ts), [desktop smoke](g4-desktop-smoke/desktop-smoke.json). [Lifecycle acceptance](g4-desktop-smoke/desktop-lifecycle.json) đã chạy hai SDK processes, restore/focus cửa sổ thật, một runtime owner, reload/navigation pending với một subscription và đóng cửa sổ không ghi file muộn. [Save/Cancel dialog](g4-desktop-smoke/desktop-dialog.json) của Windows thật ghi/không ghi đúng destination main-owned. Fixture bundle không preload, không registered sender, chỉ được serve khi smoke. Native/Google live vẫn chưa kiểm chứng.

