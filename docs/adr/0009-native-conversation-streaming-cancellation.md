# 0009: Native conversation, streaming và cancellation

Ngày 15–16/10/2026, tiếp tục G4. Người dùng chọn giữ **4 Argon**; effort đã quan sát và kiểm tra trên Web: **Low**.

## Năm cơ chế

1. Giữ canonical context trong RAM, tối đa 5 task; binding dựa trên sessionId/conversationId thật, caller và model policy. userPromptId đơn lẻ không đủ để dùng chung phiên.
2. Ban đầu chỉ gửi suffix khi full history là exact prefix và system/tools/config không đổi. **Revision 9 thay quy tắc này bằng [ADR 0010](0010-native-context-updates.md):** history/system/tools/config thay đổi được gửi bằng patch có phiên bản trong cùng tab; caller/task/model policy vẫn cách ly. Không truncate; cap full context vẫn được kiểm tra.
3. Browser MCP trả revisioned progress. Native chỉ stream trường text của final envelope mang nonce hiện tại. Không stream/thực thi tool arguments; functionCall phải qua đủ schema/policy validation. Rewrite sau khi đã stream là lỗi.
4. Chọn model/effort bằng UI và kiểm tra marker selected, rồi kiểm tra lại trước Send. Không dùng keyboard highlight hoặc generationConfig làm bằng chứng. Chờ cả model picker và đúng option/Thinking level mount sau composer trong budget 10 giây; không tự fallback model.
5. Idle mặc định 300.000 ms, hard limit 1.800.000 ms. Chỉ DOM progress gia hạn idle; polling/SSE heartbeat không gia hạn. Hai deadline đều abort được backend không hợp tác.

Revision 7 dùng aria-expanded của root picker, không coi thiếu model rows là bằng chứng menu đã đóng. Mỗi bước chọn/xác minh bảo đảm lại đúng menu trong cùng budget khi popover đóng giữa các lần đọc. Khi effort đã selected, xác minh ngay submenu hiện tại, không bấm root để mở lại. Trước Send phải xác nhận menu đã đóng; verifyOnly không tự sửa model/effort bị đổi. Chỉ tab bridge tạo được bật CDP focus emulation khi active/resume, tắt khi suspend; tab gốc không nhận override. Diagnostic model chỉ chứa stage allowlist và verificationOnly boolean qua schema strict.

## Ownership và hủy

Browser lease gắn exact target do bridge tạo và revision/base_revision. Resume kiểm tra URL/transcript/model fingerprint và composer rỗng. User edit hoặc target mất bị từ chối trước Send. Suspend khôi phục tab gốc/draft; cancel/error/release chỉ đóng tab sở hữu. Release giữ cùng browser mutation reservation. Receipt/result terminal bất biến, không tự replay.

Send chỉ chọn đúng nút Send message/Send và marker chuyên biệt; Send feedback không phải composer control. Click phải có DOM acceptance trong 5 giây (composer đã trống và generation/new response xuất hiện); mất acknowledgement trở thành OUTCOME_UNKNOWN, không click lại. Closure đợi Target.closeTarget ack và target thực sự biến mất.

Cancel socket cuối cùng hoặc owner cancel abort native generation và gửi browser Stop với cùng request ID. Poll có AbortSignal. Stop thất bại không được báo cancelled=true; owned target được retire và trả failed/outcome unknown. `/__native/cancel` xác thực owner riêng, chỉ báo cancelRequested, không giả browserStopConfirmed.

Native runtime revision 4 kiểm tra readiness trước SSE headers. Khi browser đóng, generation được phép gọi gemini_open_browser một lần rồi chờ composer signed_in trong startup budget 20 giây; status vẫn chỉ đọc. Nếu cần đăng nhập, trả HTTP 412 với Google error envelope và reason BROWSER_LOGIN_REQUIRED, chưa submit prompt. native:launch cũng mở browser và từ chối proxy cũ thay vì âm thầm dùng revision cũ.

Lỗi sau SSE headers dùng một candidate text ghi rõ `[Gemini Web error: CODE]` và finishReason STOP để kết thúc wire stream. STOP ở đây chỉ là ranh giới giao thức: diagnostic/receipt vẫn failed, completed không tăng, không phát functionCall. Cách gửi data error + OTHER ở revision 3 đã không kết thúc Working trong lần người dùng gặp BROWSER_NOT_READY; chưa có trace để quy riêng cho một trường wire. Revision 7 đã nghiệm thu trả lời, lượt tiếp nối và Cancel trong UI IDE thật; xem [bằng chứng](../evidence/g4-native-model-menu-validation.md). Kiểm thử HTTP/browser riêng vẫn không thay được UI acceptance.

Windows đóng cây Chrome sở hữu trước khi mất root. Driver attach chỉ đóng tab nó tạo. Nếu Chrome đang ở /usage, mở một owned /app target, không nhận nhầm quyền sở hữu từ launcher thoát nhanh. Fixture Chrome chạy lần lượt; các ca concurrency vẫn tạo thao tác song song tường minh.

## Tham khảo và giới hạn

Tham khảo [codex-chatgpt-web tại f137c2f](https://github.com/miuuyy/codex-chatgpt-web/tree/f137c2f84da5df214c1e228d74f5ff43e7641c48); attribution giữ tại THIRD_PARTY_NOTICES.md. Native executor vẫn ở Antigravity; functionResponse tiếp tục qua request kế tiếp. Không phụ thuộc Google reverse custom connector, không thay installer/binary/IDE chính, chưa G5. Pin UI không bảo đảm latency, quota hay context window của dịch vụ Google.
