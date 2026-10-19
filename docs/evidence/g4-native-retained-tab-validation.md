# G4: Giữ kết quả khi tab Gemini ban đầu bị đóng

Ngày 16/10/2026 (Asia/Saigon), tiếp tục G4. Giữ 4 Argon / Low; không commit/push, chưa G5.

## Lỗi và bản sửa

Phiên người dùng báo `BROWSER_TURN_FAILED` ở runtime 7: Gemini Web hiển thị JSON `tool_call`, nhưng broker trả failed trước khi IDE nhận functionCall. Kiểm tra phiên còn đúng một page target Gemini; broker không còn phục vụ status bình thường.

Đã tái hiện độc lập bằng Chrome fixture thật: đóng tab gốc trong khi giữ tab task, nhận câu trả lời hoàn chỉnh rồi gọi `lease.suspend()`. Mã cũ cố nối lại WebSocket của tab đã đóng, ném lỗi CDP. Đường cleanup cũng phụ thuộc tab gốc nên không thể đóng tab task. Regression thất bại trên mã cũ và qua sau bản vá.

- Checkpoint vẫn kiểm tra đúng transcript, model, phiên đăng nhập, composer rỗng và không còn generation.
- Khôi phục tab gốc chỉ thực hiện nếu đúng target đó còn tồn tại. Tab gốc biến mất không làm mất kết quả đã nhận; không chọn thay một tab không liên quan.
- Kết nối CDP mới phải mở thành công trước khi thay kết nối hiện tại. Attach thất bại giữ nguyên kết nối task.
- Đóng tab task dùng browser control endpoint loopback, đúng target ID đã tạo, có xác nhận target biến mất và ngân sách hữu hạn. Không phụ thuộc một page khác còn mở; không gọi Browser.close hoặc đóng tab khác trong lease cleanup.
- Native runtimeRevision 8, browser fingerprint version 7; không tự replay lượt lỗi cũ.

## Kiểm thử local

Build, typecheck, lint PASS. `npm test`: **211/211 PASS**, 0 fail/skip: contracts 8, browser 29, MCP 29, model bridge 4, native 28, runtime 80, launcher 33. Lint hiện là TypeScript noEmit.

Regression mới kiểm tra hai lượt trong tab task sau khi tab gốc bị đóng, attach thất bại không mất kết nối hiện tại, draft ở tab không liên quan giữ nguyên, chỉnh sửa ngoài vẫn vô hiệu hóa checkpoint, cleanup chỉ đóng task, và cleanup được cả tab task cuối cùng khi tab gốc không còn. Phần kiểm tra tab cuối được chạy lại riêng sau bộ đầy đủ và PASS.

## Nghiệm thu live

[Metadata nghiệm thu](mcp/native-retained-tab-ui-live.json). Dùng Computer Use / `@oai/sky` trong **Gemini Web Native Test**, model **Gemini Web (Local)**; native runtime 8, browser fingerprint 7. Người kiểm tra không cung cấp nội dung file trong prompt: hai marker tổng hợp chỉ nằm trong file trên đĩa.

| Ca | Quan sát trên IDE và broker | Kết quả |
| --- | --- | --- |
| Đọc file đầu | Native `view_file`, receipt `read-a.txt#L1-2`; sau tool result, IDE trả đúng `NATIVE_FILE_READ_A_7C914E` | PASS |
| Đóng tab gốc | Chọn tab Gemini `/app` đang rỗng rồi đóng bằng Ctrl+W; xác nhận còn một page target của task | PASS |
| Đọc file thứ hai trong cùng chat | Native `view_file`, receipt `read-b.txt#L1-2`; IDE trả đúng `NATIVE_FILE_READ_B_85D2AF`, hết Working/Cancel, không có Gemini Web error | PASS |
| Đối chiếu sau hai vòng | Broker có 2 tool_call/view_file + 2 final, đều completed và xác minh Argon/Low; native counters completed=4, failed=0, active=0; browser ready, activeRequestId=null | PASS |

Tool call thứ hai dùng retained context (1.844 ký tự thay full 72.112) khi tab gốc không còn. Sau functionResponse, final thứ hai dùng một full-context binding mới (73.153 ký tự), đúng chính sách không dùng delta khi context không còn là prefix đã chứng minh. Không coi cả vòng thứ hai là delta hay cam kết giảm latency.

Đây là vòng native IDE → Gemini Web → native executor đọc file → functionResponse → câu trả lời hiển thị trong IDE thật. Không chứng nhận sửa file/chạy shell, compaction hay installer. Không tự gửi lại lượt lỗi của người dùng, không đổi model, không sửa binary/profile IDE chính, không mở gateway public. Runtime 8 và IDE thử nghiệm được để chạy idle để người dùng test tiếp.
