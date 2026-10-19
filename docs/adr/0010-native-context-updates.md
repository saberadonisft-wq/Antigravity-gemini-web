# 0010: Gửi cập nhật context trong cùng phiên Gemini Web

Ngày 16/10/2026. Tiếp tục G4, native runtime revision 9. Thay thế quy tắc rotate tab khi history/system/tools thay đổi tại mục 2 của ADR 0009.

## Quyết định

Proxy giữ snapshot đầy đủ trong RAM, gắn đúng caller, native session/conversation và model policy. Lần đầu gửi toàn bộ context cùng hướng dẫn giao thức. Các lượt sau giữ owned Web tab và gửi header ngắn với nonce hiện tại:

- `append`: chỉ tin nhắn/functionResponse mới khi lịch sử trước là prefix chính xác và các trường còn lại không đổi.
- `patch`: cập nhật chính xác trường, đoạn văn bản hoặc mảng bị thay đổi; có thao tác xóa rõ ràng. Dùng literal text có anchor duy nhất, không yêu cầu model đếm offset UTF-16.
- `replace`: thay toàn bộ canonical context trong cùng tab nếu patch còn dài hơn dữ liệu thay thế.

Mỗi update có baseRevision/revision. Patch được áp dụng lại ở local và so sánh với toàn bộ snapshot IDE trước Send. Không tóm tắt, không tự bỏ lịch sử, không bỏ qua system instruction/tool schema mới. Phần history IDE đã xóa được đánh dấu xóa trong update; đây là đồng bộ snapshot host, không phải proxy tự truncate.

Snapshot chỉ được commit sau phản hồi hợp lệ. Reservation riêng cho từng lần prepare ngăn callback trễ hoàn tất hoặc hủy lượt mới, kể cả context hash giống nhau. Lỗi trước Send giải phóng reservation; lỗi/cancel/mất kết quả sau Send làm invalidation và không tự replay. Full-context transport cap vẫn áp dụng ngay cả khi phần delta nhỏ. Prompt có revision cũng được kiểm tra cap trước browser.

## Quyền và giới hạn

Model có thể nhớ context cũ trong hội thoại Web, nhưng quyền thực thi luôn được kiểm tra bằng tool inventory, schema, policy và nonce của request IDE hiện tại. Tool đã thu hồi không thể được thực thi dù model còn nhớ schema cũ. Broker vẫn kiểm tra owned target/transcript/revision/model khi resume. Không chia sẻ phiên giữa caller/task/model policy khác nhau. Thiếu task ID, restart, eviction hoặc mất snapshot cần bootstrap đầy đủ ở yêu cầu mới; không tự gửi lại yêu cầu không rõ kết quả.

Local reconstruction chứng minh nội dung cập nhật không mất dữ liệu; nó **không chứng minh model trên Web đã diễn giải patch chính xác hoặc nhớ lịch sử vô hạn**. Hướng dẫn yêu cầu model dừng và đề nghị phiên mới nếu không còn base. Đây là giao thức prompt, không phải API context cache của Google. Lịch sử Web vẫn tồn tại; lượng chữ giảm trên wire không suy ra tỷ lệ giảm token/quota hay latency Google.

Giữ 4 Argon / Low. Không có live prompt trong đợt này vì người dùng đã hết quota. [Bằng chứng offline](../evidence/g4-native-context-optimization.md).

Revision 11 bổ sung rebind tường minh bằng `native:resume`: khi mất snapshot vẫn bootstrap đầy đủ, nhưng được gửi trong cuộc trò chuyện Web hiện có mà người dùng chỉ định bằng URL. Không đoán tab, không tự replay; cập nhật kế tiếp lại dùng delta. [Cơ chế và kiểm chứng](../evidence/g4-native-existing-conversation-validation.md).
