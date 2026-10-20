# Kiểm tra archive trước khi nhập lịch sử chat

P7a/P7b/P7c, ngày 19/10/2026, Native source 39 / browser worker 25. Có **kiểm tra ZIP cục bộ** qua CLI hoặc màn hình Nhập lịch sử của launcher, và lệnh quan sát trang import đang mở. Các bước này không upload. Upload và theo dõi kết quả trên Gemini vẫn đang phát triển.

## Dùng launcher thử nghiệm

Sau build, cấu hình `AG_NATIVE_IMPORTS_EXPERIMENTAL=1` trong môi trường của Native owner trước khi khởi động, rồi mở launcher bằng `npm run launcher`. Màn hình **Nhập lịch sử** đọc owner đang có, không tự khởi động/restart proxy. Nếu owner cũ/offline hoặc chưa bật tính năng, màn hình khóa chọn file. Không restart browser/proxy đang chờ xác minh hay có lượt chưa rõ kết quả chỉ để bật cờ này.

Chọn tài khoản đích có identity đã đăng ký và provider xuất dữ liệu, rồi bấm **Chọn ZIP và kiểm tra**. File được chọn bằng hộp thoại OS ở main; renderer không được đưa đường dẫn, nội dung hoặc URL vào lệnh. Một hộp thoại dùng chung với phần Nguồn dự án. Hủy chọn file không tạo job. Đăng ký identity chỉ ràng buộc preview với tài khoản, chưa xác nhận quyền import trên Google.

Worker thread riêng đọc file, trả tiến độ hash và thống kê. Chỉ công bố `ready` sau khi worker đã thoát thành công và tài khoản/epoch/cấu hình vẫn khớp. Đổi account registry hoặc epoch làm preview cũ mất hiệu lực; không chuyển preview sang account khác. Lúc Native bận không bắt đầu kiểm tra mới, nhưng vẫn có thể hủy job đang chạy.

Tối đa một worker và tám preview trong RAM, TTL 15 phút tính bằng đồng hồ monotonic, thu hồi khi đọc trạng thái. Hủy/expiry/đổi target giữ slot tới khi worker thật thoát. Preview không lưu qua proxy restart; cần chọn file lại. **Bỏ bản kiểm tra cục bộ** chỉ xóa metadata trong RAM, giữ ZIP gốc. Đường dẫn đầy đủ được giữ riêng trong owner để có thể xác minh lại ở bước upload tương lai, không xuất ra IPC/status/log. Không có upload API hoặc thao tác Google trong mốc này.

[Kiểm thử P7b](../../evidence/g4-native-p7b-chat-import-preview.md) dùng Electron, preload sandbox, HTTP và worker thật, nhưng account identity và grant từ chooser là tổng hợp. Chưa nghiệm thu người dùng chọn ZIP bằng OS dialog thật hay upload Google.

## Dùng CLI

Sau khi build:

```powershell
npm run native:imports:inspect -- --provider chatgpt --file "D:\Exports\export.zip"
```

Đổi `chatgpt` thành `claude` khi kiểm tra bản export tương ứng. `declaredProvider` trong kết quả là lựa chọn của người dùng, không phải provider được tự phát hiện từ nội dung.

Kết quả có tên file, số byte, SHA-256, thời điểm kiểm tra và thống kê thư mục ZIP: số file/thư mục, file mã hóa, tổng compressed/uncompressed bytes. Các tổng được biểu diễn bằng chuỗi thập phân để giữ chính xác số lớn. Không trả đường dẫn đầy đủ, tên entry bên trong hoặc nội dung chat.

Các trường trạng thái luôn là:

```json
{
  "inspection": "directory_metadata_only",
  "contentsCrcVerified": false,
  "googleSubmission": "not_submitted",
  "googleCompatibility": "requires_live_validation"
}
```

Inspector đọc theo từng khối và duyệt danh mục ZIP/ZIP64 tuần tự; không giải nén hoặc thực thi nội dung. Chuỗi giống nonce/tool call trong archive không được chuyển thành yêu cầu công cụ IDE. Hash và danh mục dùng một file handle được giữ suốt lượt kiểm tra; thay đổi identity/size/timestamps trong khi đọc khiến kết quả bị từ chối. Điều này chưa bảo đảm file không đổi sau khi kiểm tra.

Giới hạn kiểm tra: 5.000.000.000 byte/file, một triệu entry và ngân sách mười phút. Có callback tiến độ đọc hash và AbortSignal cho ứng dụng gọi thư viện. Windows nhận đường dẫn dạng ký tự ổ đĩa; link/junction/hardlink, UNC/device/ADS và alias không an toàn bị từ chối. Các tên traversal trong ZIP cũng bị từ chối. Archive quá nhỏ, rỗng hoặc không đọc được không được coi là kết quả hợp lệ.

Inspector không kiểm CRC/decompress từng entry, không xác nhận schema hội thoại theo provider, không đếm số cuộc chat và không chứng nhận Google sẽ chấp nhận archive. File mã hóa chỉ được thống kê; chưa có luồng nhập mật khẩu hay chứng nhận tương thích.

## Gemini hỗ trợ gì

### Quan sát trang import theo account (P7c)

Khi owner source 39 đã bật `AG_NATIVE_IMPORTS_EXPERIMENTAL=1`, tự mở trang import trong đúng profile đã đăng ký identity, rồi chạy `npm run native:imports:check -- ACCOUNT_ID`. Account ID có trong `npm run native:accounts`. Lệnh CLI đọc qua Native owner và browser MCP owner, không tạo browser controller khác.

Probe chỉ đọc các tab hiện có trong đúng profile; không mở/navigate/activate/đóng tab, bấm Add, ghi file input, dán memory hoặc Send. Nó xác minh profile CDP, nhận dạng trang bằng heading/control nhìn thấy, kiểm identity khớp và trả metadata. Tab hội thoại canonical và DOM có composer/model response bị loại. Kết quả không chứa email, URL, nội dung chat hoặc đường dẫn. Số tab và thời gian quan sát có giới hạn; control ẩn, trùng, account khác hoặc nhiều trang import hợp lệ không được coi là bằng chứng duy nhất.

`controls_observed` chỉ có nghĩa controls nhìn thấy và identity khớp trong lần quan sát này; `surfaceId` là hash tạm của target, không phải receipt hoặc quyền upload. Các trạng thái khác gồm `not_observed`, `ambiguous`, `identity_changed`, `identity_unverified`, `browser_unavailable`, `user_action_required`. `not_observed` không chứng minh account thiếu quyền. Recognition tiếng Anh đã có fixture; pattern tiếng Việt vẫn cần đối chiếu UI thật. Chưa có nút probe trong launcher hay capability cache dùng để cấp quyền truyền dữ liệu. Browser cũ không advertise hỗ trợ sẽ bị từ chối.

### Hướng dẫn nền tảng

Tài liệu Google hiện hướng dẫn import chat từ export ChatGPT/Claude dưới dạng ZIP, giới hạn ghi là 5 GB và tối đa năm ZIP/ngày. Tính năng yêu cầu tài khoản cá nhân đủ điều kiện; chưa khả dụng cho work/school/supervised hoặc một số khu vực. Reupload có thể ghi đè các cuộc chat đã nhập; import gián đoạn có thể chỉ hoàn tất một phần. Dữ liệu đã nhập nằm trong Activity và chịu cơ chế sử dụng dữ liệu của Gemini, gồm cải thiện dịch vụ/huấn luyện. [Hướng dẫn chính thức, đối chiếu 19/10/2026](https://support.google.com/gemini/answer/16868299?hl=en).

Các thông tin này không chứng minh Gemini A → B được hỗ trợ, không chứng nhận quyền của account đang chọn và không thay cho quan sát UI thật. Kiểm tra cục bộ không tiêu thụ lượt upload Google.

## Phần tiếp theo của P7

Workflow tiếp theo cần nghiệm thu OS chooser thật, kiểm tra capability import trên account, hiển thị dữ liệu sẽ truyền, xác minh lại file trước upload và theo dõi trạng thái nhập. Mỗi lần truyền phải có receipt/fence riêng; partial/outcome_unknown không được tự upload lại. Hoàn thành trên Web, phạm vi history/attachment giữ được và memory-text import vẫn cần nghiệm thu riêng.

Không dùng memory/imported history làm nơi chứa active tool policy, nonce hoặc chứng cứ bytes hiện tại của workspace. [Kế hoạch đầy đủ](../plans/NATIVE_UPGRADE_PLAN.md).
