# Gemini Web trong chat native Antigravity IDE

Adapter dùng cấu hình jetski.cloudCodeUrl trên **Antigravity IDE 2.5.5 / VS Code 1.107.0**, commit ecfbad74d93962fc8ca485d93ab9b4f3d4cb6cf8. Native chat và một vòng view_file đã được kiểm chứng trên IDE và Gemini Web thật ngày 15/10/2026. [Bằng chứng](evidence/g4-native-provider-validation.md).

## Chạy trên máy này

~~~powershell
cd D:\Antigravity-gemini-web
npm run build
npm run native:check
npm run native:launch
npm run native:browser
~~~

Lệnh launch khởi động proxy 127.0.0.1:9236 và mở **Gemini Web Native Test**. Profile IDE riêng: %USERPROFILE%\.gemini\antigravity-gemini-web-live\app_data\native-route\ide-profile. Lần đầu người dùng tự xác nhận workspace và đăng nhập Google. Thông tin đăng nhập không được sao chép từ IDE chính.

Lệnh browser mở/attach phiên Gemini Web của browser MCP bằng profile đã có. Người dùng tự đăng nhập nếu cần. Account signed_in nhưng composer đang tải có thể tạm báo needs_user_action.

Trong cửa sổ **Gemini Web Native Test**, chọn **Gemini Web (Local)** ở menu model rồi gõ yêu cầu bình thường. Không cần yêu cầu agent gọi gemini_submit. IDE chính giữ cấu hình/model cũ.

## Tự kiểm tra tiếp trên máy này

Fixture đã chuẩn bị tại D:/Antigravity-gemini-web/.tmp/native-tool-acceptance. Để kiểm tra sửa file và executor thật, người dùng tự dán prompt sau vào native chat, rồi xử lý approval mà IDE hiển thị:

~~~text
Chỉ thao tác trong D:/Antigravity-gemini-web/.tmp/native-tool-acceptance.
Đọc read-me.txt bằng native tool.
Tạo result.txt chứa nguyên nội dung đó nối thêm _PATCHED, không thêm nội dung khác.
Sau đó dùng native run_command chạy:
node D:/Antigravity-gemini-web/.tmp/native-tool-acceptance/check.mjs
Báo nguyên văn kết quả test thực tế.
Không dùng công cụ MCP browser để gửi hộ và không sửa file ngoài thư mục fixture.
~~~

Mong đợi native tool thực sự tạo result.txt và command stdout có AG_NATIVE_TEST_PASS. Chỉ câu trả lời của model ghi PASS chưa đủ; cần tool receipt và file thực tế. Ca này hiện chưa nghiệm thu. Fixture là dữ liệu tổng hợp dành riêng cho kiểm tra.

Nếu browser broker còn chạy bản cũ, Refresh MCP trong IDE chính. Native backend cần status có maxPromptChars=262144 và freshConversationSupported=true. Các client được phép chia sẻ một runtime owner.

## Luồng

~~~text
Chat native / executor IDE
 → proxy local nhận Cloud Code request
 → toàn bộ system/context/history/tool declarations
 → browser MCP, tab Gemini mới cho mỗi lượt
 → JSON phản hồi có nonce riêng
 → native candidate text hoặc functionCall
 → IDE thực thi công cụ theo quyền hiện hành
 → functionResponse trong request kế tiếp
 → Gemini Web tiếp tục trả lời
~~~

Proxy chỉ phát functionCall cho tool và schema được IDE cấp trong request hiện tại. Native executor đọc/sửa file và chạy công cụ; proxy không có executor filesystem/shell riêng.

## Trạng thái và khôi phục

~~~powershell
npm run native:status
npm run native:stop
npm run native:restore
~~~

Status trả counters/tên route, không trả credential hoặc prompt. Stop từ chối khi generation còn active và xác thực owner riêng. Restore gỡ giá trị adapter quản lý trong profile riêng, giữ sửa đổi không liên quan; endpoint bị sửa ngoài service gây CONFIG_CONFLICT.

## Ranh giới

- Adapter thử nghiệm cho đúng build IDE đã kiểm tra, chưa installer/G5. Gate native tổng quát trong launcher/MCP cũ vẫn thận trọng; xem bằng chứng native riêng.
- Nhận text và lịch sử native function. Attachments/image/file URI bị từ chối, không cắt ngầm context. Cap local là 262144 ký tự prompt đầy đủ, không phải cam kết context window Google.
- Catalog dùng 100000 làm giá trị tương thích bộ kiểm tra checkpoint IDE 2.5.5. Model/effort thực tế là lựa chọn đang có trên Gemini Web; chưa pin/đo model family, quota, context window hoặc compaction live.
- Browser hoàn tất phản hồi rồi proxy trả qua SSE; chưa stream từng token từ DOM.
- Chỉ model Gemini Web (Local) được xử lý generation. Model khác, kể cả tác vụ phụ đặt tên chat của IDE, bị từ chối thay vì fallback sang Google API. Metadata ngoài allowlist có thể báo 404, gồm ACL/analytics chưa hỗ trợ.
- Sign-in và metadata đi tới Cloud Code chính thức bằng credential IDE. Credential không đi vào prompt Gemini Web hoặc endpoint tùy ý.
- Tab mới được đóng sau lượt, tab gốc/draft được giữ. Retry gắn với context/session; restart hoặc mất kết quả không tự gửi lại.
- Reverse custom MCP connector của Google vẫn độc lập và chưa kết nối. Đường native này trả functionCall trực tiếp cho executor, không phụ thuộc connector đó.

Tham khảo: [antigravity-add-model, fc5b91a](https://github.com/vahapogut/antigravity-add-model/tree/fc5b91a17125bf91bd59f3c1ab065aa58e6c0829), [license](../THIRD_PARTY_NOTICES.md).
