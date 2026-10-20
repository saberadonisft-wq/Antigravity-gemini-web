# G4: Giữ phiên, stream và hủy native generation

Ngày 15–16/10/2026. Tiếp tục G4 theo yêu cầu triển khai 5 cơ chế và sửa lỗi Cancel không kết thúc Working. Chưa G5, chưa installer, chưa commit/push đợt thay đổi này. Thiết kế: [ADR 0009](../archive/adr/0009-native-conversation-streaming-cancellation.md).

## Kiểm thử local

`npm test`: **210/210 PASS**, 0 fail/skip. Contracts 8, browser 28, MCP 29, model bridge 4, native 28, runtime 80, launcher 33. Browser fixture chạy lần lượt; concurrency được kiểm tra bằng các yêu cầu song song trong test. Build, typecheck và lint: **PASS**; lint hiện vẫn là tsc --noEmit. Đã chạy lại sau bản sửa menu/focus và model diagnostic ở revision 7; log local `.tmp/g4-followup-{test,build,typecheck,lint}.log`.

Các regression mới xác minh exact-prefix delta, task/caller isolation, context/config rotation, bounded eviction, stale revision, checkpoint failure, model/effort selected marker, model picker và option mount lệch nhau, original tab/draft, code-block progress, partial Unicode, không stream tool args, không duplicate text, idle/hard deadline, HTTP disconnect, owner cancellation và không replay. Thêm 6 native tests kiểm tra readiness, startup budget/cancel và lỗi trước/sau SSE headers. Stop thất bại vẫn trả failed; lease close giải phóng browser mà không giả cancelled=true. Terminal và late progress không đổi kết quả đã chốt.

Đã sửa thêm dừng cây Chrome trên Windows trước khi root mất dấu; xác nhận tab thực sự biến mất sau close ack; không nhận nhầm browser ownership khi Chrome đang ở /usage. Runtime crash fixture dùng taskkill chính xác root cho ca crash, đợi exit thật, kiểm tra các descendant theo PID + creation time. CIM observation dùng PowerShell 7 nếu có và budget hữu hạn, không bỏ qua orphan hoặc cleanup failure.

## Kiểm thử Gemini Web thật

[Metadata đo trực tiếp revision 3](mcp/native-latency-live.json), chạy bằng `node tools/probes/native-stream-smoke.mjs --live` và đối chiếu thêm gemini_status/gemini_result sau cancel. Đây là snapshot lịch sử; error wire ở revision 4 đã thay đổi, xem dưới. Caller là client protocol loopback tổng hợp, không phải UI Antigravity. Chỉ gửi fixture text, không file người dùng, không native tool execution. Model/effort đã được browser xác minh **4 Argon / Low** trước Send.

| Ca | Kết quả | Đo trực tiếp |
| --- | --- | --- |
| Full context, final nonce-bound | PASS | 10.837 ký tự gửi; text đầu 10.054 ms; tổng 11.087 ms; STOP |
| Follow-up đúng retained target/revision | PASS | 1.523 ký tự gửi thay cho full 10.926; giảm khoảng 86,1%; text đầu 11.880 ms; tổng 13.096 ms; STOP |
| Hủy sau observable generation | PASS protocol/browser | SSE CANCELLED + terminal OTHER; proxy active=0 |
| Đối chiếu broker sau hủy | PASS | gemini_result.status=cancelled; activeRequestId=null; browser ready/signed_in; còn 1 retained task đã hoàn thành |

Text được phát trước completion; frame terminal không lặp lại prefix đã phát. Ca cancel có kết quả browser `cancelled` thật (khác với owner API chỉ báo cancelRequested). Bản thân thời gian tổng của lượt cancel gồm cả model selection/submission, không được gọi là latency của riêng nút Stop.

Lần thử trước bản vá cuối từng gặp MODEL_UNAVAILABLE do composer mount trước model picker; đã tái hiện trên fresh Gemini tab và sửa bằng positive waiting. Một follow-up trước đó không có response đến watchdog 90 giây và được abort, không resend. Đã thắt selector Send để loại Send feedback, yêu cầu DOM acceptance trong 5 giây và kiểm tra target close thực tế; lần đo sau PASS như bảng. Không đủ trace của lần lỗi trước để quy duy nhất cho một nguyên nhân DOM; không tuyên bố 0 flaky hoặc mọi lượt đều nhanh hơn. Lượt delta của lần đo này vẫn chậm hơn full, dù lượng dữ liệu gửi giảm.

## Browser đóng ở revision 4

Lượt `alo` sau đó thất bại BROWSER_NOT_READY trong 9 ms khi browser broker closed/unknown; proxy active=0 nhưng UI vẫn Working. Đã bổ sung readiness trước SSE, tự mở browser và lỗi login HTTP 412. Lỗi sau headers dùng một candidate ghi rõ Gemini Web error + STOP làm wire terminal; diagnostic vẫn failed, không tool call và không tính completed. Đã nạp proxy revision 4 và đo cold startup thật: browser CDP không reachable trước request → tự mở → trả đúng marker, tổng 9892 ms, text đầu 8611 ms. [Chi tiết và metadata](g4-native-autostart-validation.md).

## Giới hạn và tự test

**Revision 7 đã PASS trả lời, lượt tiếp nối và Cancel trực tiếp trong native UI.** Computer Use helper hoạt động trở lại ngày 16/10; [bằng chứng riêng](g4-native-model-menu-validation.md) có cả UI, proxy và broker browser. Những số đo revision 3/4 phía trên vẫn là snapshot protocol/browser, không được nâng thành UI acceptance hồi tố.

Trong Gemini Web Native Test chọn Gemini Web (Local), gửi một yêu cầu trả lời dài rồi bấm Cancel. Sau đó thử prompt mới, kiểm tra không xuất hiện phản hồi trễ của lượt trước. Nếu cần đường dừng dự phòng, chạy `npm run native:cancel`; xem `npm run native:status` và chờ active=0. Refresh MCP nếu client còn giữ discovery 5 browser tools; bản mới có 6.

Native sửa file/chạy test và compaction vẫn có phạm vi nghiệm thu riêng, chưa được ca protocol/browser này chứng nhận. Không sửa binary hay cấu hình IDE chính, không đổi model sang Flash, không thay bằng Gemini API và không deploy gateway public.

Snapshot cleanup sau phép đo full/delta revision 3: đã release owned test tabs bằng graceful shutdown, khởi động lại bridge, browser ready/signed_in, activeRequestId=null, retained test tasks=0. CLI native:cancel khi idle trả cancelRequested=0; không diễn giải đó là hủy một lượt đang chạy. Hiện proxy revision 7 giữ chạy, native UI đã kết thúc lượt Cancel, browser ready và activeRequestId=null; không tự gửi lại lượt `alo` đã lỗi.
