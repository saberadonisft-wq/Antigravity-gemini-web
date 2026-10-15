# G4 — Review và remediation Codex

Ngày: 14/10/2026. Đối chiếu báo cáo Gemini với source, entry points và kiểm thử thật. Kết luận ban đầu “G4-A hoàn tất 100%” không được code ở thời điểm bàn giao chứng minh.

## Findings đã vá

| ID | Mức độ | Trước review | Sau bản vá |
|---|---|---|---|
| G4-R1 | Critical | Không dependency Electron, không main entry; package main trỏ file không tồn tại, build Vite được gọi là desktop PASS. | Main Electron, app protocol, script start, single-instance lock, bundle CJS preload; desktop smoke thật. |
| G4-R2 | High | App dùng mock khi thiếu preload; helper unit có throw nhưng App không gọi nhánh đó. | Demo chỉ khi explicit mode=demo; desktop live thiếu preload render PRELOAD_UNAVAILABLE, đã thử trong BrowserWindow không preload. |
| G4-R3 | Critical | Origin check startsWith cho phép host/port prefix spoof; isMainFrame là flag giả trong unit, không đăng ký sender thật. | Exact normalized origin, registry sender, main-frame identity lấy từ Electron event; validation input và output. |
| G4-R4 | High | Preload chỉ nghe event local, không gọi subscribe main; unsubscribe không giải phóng subscription backend; optional global require không chứng minh sandbox preload. | Bundle preload, IPC handshake trước snapshot, channel unsubscribe nội bộ, event/input/output schemas, structured error reply. |
| G4-R5 | High | Save dialog có destination nhưng bỏ qua; export không có writer thật. | Main-owned chooser → file export atomic; cancel/late dialog không ghi file; không báo thành công khi thiếu exporter. |
| G4-R6 | High | Settings chỉ ở RAM và UI báo thành công khi ack. | Settings store atomic có revision/external-change checks, restart test; UI chờ operation terminal. |
| G4-R7 | High | Facade start đánh ready trước recovery; stop bỏ qua timeout/browser cleanup và dừng khi một coordinator throw; default demo dùng cùng app-data live. | Lifecycle idempotent/fenced, cleanup vẫn chạy sau persistence lỗi, exit failure có mã lỗi; paths demo/live tách biệt. |
| G4-R8 | High | Facade chỉ tạo coordinator, không có integration path sử dụng context/journal/driver; key workspace::session có collision. | Composite canonical key, registry bounded; runFixtureTurn host-only compose preflight/journal/driver và test Send count/late outcome. Không expose API này cho renderer. |
| G4-R9 | High | Redaction chỉ blacklist summary ở getActivity; snapshot, operation, events và lỗi raw đi qua. | Validate và sanitize mọi outgoing surface, mask account labels; error wire không gửi raw exception/schema payload/stack. |
| G4-R10 | High | Renderer không lọc stale/duplicate/gap/retired events, getSnapshot lỗi có thể spinner mãi; ack được coi là success. | LauncherStore có watermark, retired-instance guard, coalesced refresh, bounded buffer/deadline; executeAndWait chỉ success ở terminal succeeded. |
| G4-R11 | Medium | Mock runtime.check/export result sai shared schema, operation IDs Date.now collision; model catalog unknown hiện “0 models”; language English chưa implement nhưng như đã hỗ trợ. | Typed mock results, UUID command IDs, settings demo đúng revision; unknown catalog hiển thị unknown, English disabled và UI lang=vi. |
| G4-R12 | High | Default app có thể tự attach Gemini target trên port chung, chưa chứng minh profile là của app. | OwnedBrowserAdapter không inspect/attach khi chưa có owned connection; occupied/uncertain port bị từ chối. Base G2 adapter và 13 concurrency regressions không bị viết lại. |
| G4-R13 | Medium | Activity failure bị coi như empty, query cũ có thể ghi đè filter mới, không có pagination; clipboard rejection unhandled. | Error/loading/pagination, query epoch và filter sync; scoped clipboard-write permission và catch failure. |

## Source và proof

- [Main entry](../../apps/launcher/src/main/index.ts), [IPC bridge](../../apps/launcher/src/main/ipc-bridge.ts), [preload client](../../apps/launcher/src/preload/client.ts).
- [Runtime facade](../../packages/runtime/src/runtime-facade.ts), [local store](../../packages/runtime/src/local-store.ts), [owned browser](../../packages/runtime/src/owned-browser.ts).
- [G4 runtime regressions](../../packages/runtime/src/g4-remediation.test.ts), [IPC boundaries](../../apps/launcher/src/main/g4-boundaries.test.ts), [renderer behaviors](../../apps/launcher/src/renderer/g4-behavior.test.ts).
- [Kiểm chứng sau bản vá](g4-codex-remediation-validation.md), [desktop evidence](g4-desktop-smoke/desktop-smoke.json).

## G4 còn chưa hoàn tất

1. Command dài vẫn chờ backend xong mới trả ack; cần operation owner/ID được commit và trả sớm, progress từ event thật, terminal bền vững. Renderer đã biết chờ operation, không còn coi ack là success.
2. English UI copy chưa triển khai; option đã khóa để không hứa sai. Cần hoàn thiện locale layer và UI behavior tests.
3. Chưa có fixture transaction preview/apply/restore cho config; native route thực tế vẫn locked, không được install shim rồi gọi là inference connected.
4. Browser focus/reconnect sau crash, toàn bộ keyboard/modal/contrast và Windows native Save dialog chưa được nghiệm thu đầy đủ. Desktop smoke kiểm tra một số flow cụ thể, không chứng nhận mọi accessibility case.
5. Native inference, Google chat/account thật, native approvals/tool loop và G4-B vẫn NOT_TESTED. Missing parent handshake là giả thuyết từ no-port probes, không phải nguyên nhân đã chứng minh.

**G4 desktop control core: VERIFIED. G4-A toàn bộ: PARTIAL / NEEDS_WORK. G4-B: BLOCKED / NOT_TESTED.** Chưa chuyển G5.
