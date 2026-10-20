# Kiểm tra báo cáo G2 và đề xuất shim

Ngày: 14/10/2026. Phạm vi: báo cáo G2 mới, source hiện tại, metadata và đoạn JavaScript trong Antigravity IDE cài trên máy. Không sửa IDE, tạo/cài shim hoặc đổi cấu hình người dùng trong lượt review.

## Những gì được xác nhận

- Build 5 packages và 29 tests TypeScript đạt; 6 Python unit tests đạt. Các checks này là scaffold/mocks, không phải live acceptance.
- Runtime đã sửa fingerprint nested và reentrant success path; browser/account direct stub không còn fake opened/signed_in; terminal cancel được chặn.
- App metadata tại `D:\Antigravity IDE\resources\app\package.json` ghi version `1.107.0`; product commit `e0b7a2bcf575cfba10528c4e7c10bd3ce2d7769a`.
- Bundle `resources/app/extensions/antigravity/dist/extension.js` có literal `codeiumDev.languageServerBinaryPath` và `codeiumDev.externalLanguageServerAddress`.
- Tại byte/character offset 1620174 trong bundle đọc ngày review, có biểu thức `parseInt(e.slice(0,-1)[1],10)`. Với input `127.0.0.1:5555`, biểu thức tính port 2. Chưa patch hoặc thử route IDE thật trong review.
- Báo cáo end-to-end ghi NOT TESTED; hiện chưa có native IDE → Gemini Web → executor → final reply thật.

## Kết luận cần thu hẹp

Lỗi parse port chứng minh một đường external-server helper bị lỗi với dạng address đã thử. Nó không chứng minh mọi đường model integration của IDE đều đóng kín.

`languageServerBinaryPath` cho thấy một launch hook cần khảo sát thêm. Wrapper có thể khởi chạy language server gốc và bảo toàn hành vi của nó; vì vậy không mặc định mọi shim phải viết lại toàn bộ hơn 60 RPC. Nhưng launch hook cũng không tự trở thành inference hook. Cần chứng minh được nơi chuyển model request mà vẫn giữ executor, không coi “IDE chạy qua wrapper” là “Gemini Web đã làm model”.

G2-B.4/B.5/B.6 chưa có native prompt/stream/tool result nên nên ghi NOT TESTED hoặc route chưa được chứng minh, thay vì suy ra UNSUPPORTED toàn sản phẩm chỉ từ transport TLS/ConnectRPC.

G2-C.6 chỉ đạt **adapter contract/stub**, chưa đạt implementation live. `packages/gemini-browser/src/index.ts:52–65` vẫn trả browser closed, account unknown, opened false. submitPrompt phụ thuộc checkStatus này nên luôn throw LOGIN_REQUIRED; chưa có driver được ghép vào adapter. Login profile probe là việc cần làm, nhưng chưa đủ để adapter runtime hoạt động.

## Hai lỗi remediation còn thiếu

### A1 — [P1] Error path tạo unhandled rejection

Vị trí: `packages/runtime/src/fake-runtime.ts:140–157`.

Leader tạo deferred inFlightPromise, sau đó chạy processCommand và reject deferred khi lỗi. Nếu không có duplicate waiter, không ai xử lý rejection của deferred này, dù caller đã catch lỗi execute.

Repro in-process: processCommand ném synthetic error, caller catch được nhưng process vẫn nhận 1 unhandledRejection. Node mặc định có thể làm process dừng; không dùng lỗi này làm hành vi retry.

Sửa: leader và waiters cùng quan sát một Promise được quản lý; không tạo rejection mồ côi. Test leader-only failure, concurrent failure, cleanup map và semantics của lần retry.

### A2 — [P2] Resync chưa chờ snapshot bất đồng bộ

Vị trí: `packages/runtime/src/in-process-client.ts:156–176`, `:189–196`.

handleResync gọi callback rồi fan-out/reset buffer ngay. Callback async lấy snapshot chưa xong nhưng isResyncing đã false và event được giao. retiredInstances đã tốt hơn trước, nhưng chưa có asynchronous buffer/resync boundary như báo cáo khẳng định.

Repro: callback chờ setImmediate trước getSnapshot; trigger gap giao snapshot event khi loading=true, isResyncing=false. Chưa dùng network trong repro.

Sửa: resync do client quản lý có Promise/epoch, buffer cho đến authoritative snapshot rồi replay sequence phù hợp; error/timeout có kết quả rõ. Test delayed snapshot + new events, restart trong lúc resync và listener unsubscribe.

## Đề xuất bước tiếp theo

1. Sửa A1/A2 và sửa gate labels cho đúng phần đã đo.
2. Người dùng login profile probe; sau đó thử 3 lượt/cancel và ghép browser driver thật, ghi riêng probe và adapter acceptance.
3. Chuẩn bị transparent shim PoC trên workspace/profile IDE thử riêng. Chứng minh launch/stdio/port discovery/exit/cancel giữ nguyên trước; chưa thay IDE chính.
4. Chỉ gọi shim là phương án Gemini Web bridge sau khi có inference interception/mapping phù hợp đã thử, native fixture response và read-only tool round-trip.
5. Nếu chỉ chứng minh launch hook mà chưa có inference hook, tiếp tục ghi gate unresolved. Chưa kết luận bất khả thi toàn bộ, cũng chưa chuyển G3.

Prompt để người dùng giao việc: [GEMINI_G2_SHIM_SPIKE_PROMPT.md](../archive/prompts/GEMINI_G2_SHIM_SPIKE_PROMPT.md).
