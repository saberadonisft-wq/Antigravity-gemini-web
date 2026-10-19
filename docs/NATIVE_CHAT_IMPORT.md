# Kiểm tra archive trước khi nhập lịch sử chat

P7a/P7b, ngày 19/10/2026, Native source 38 / browser worker 24. Có **kiểm tra ZIP cục bộ** qua CLI hoặc màn hình Nhập lịch sử của launcher. Cả hai chỉ kiểm tra file trên máy. Upload và theo dõi kết quả trên Gemini vẫn đang phát triển.

## Dùng launcher thử nghiệm

Sau build, cấu hình `AG_NATIVE_IMPORTS_EXPERIMENTAL=1` trong môi trường của Native owner trước khi khởi động, rồi mở launcher bằng `npm run launcher`. Màn hình **Nhập lịch sử** đọc owner đang có, không tự khởi động/restart proxy. Nếu owner cũ/offline hoặc chưa bật tính năng, màn hình khóa chọn file. Không restart browser/proxy đang chờ xác minh hay có lượt chưa rõ kết quả chỉ để bật cờ này.

Chọn tài khoản đích có identity đã đăng ký và provider xuất dữ liệu, rồi bấm **Chọn ZIP và kiểm tra**. File được chọn bằng hộp thoại OS ở main; renderer không được đưa đường dẫn, nội dung hoặc URL vào lệnh. Một hộp thoại dùng chung với phần Nguồn dự án. Hủy chọn file không tạo job. Đăng ký identity chỉ ràng buộc preview với tài khoản, chưa xác nhận quyền import trên Google.

Worker thread riêng đọc file, trả tiến độ hash và thống kê. Chỉ công bố `ready` sau khi worker đã thoát thành công và tài khoản/epoch/cấu hình vẫn khớp. Đổi account registry hoặc epoch làm preview cũ mất hiệu lực; không chuyển preview sang account khác. Lúc Native bận không bắt đầu kiểm tra mới, nhưng vẫn có thể hủy job đang chạy.

Tối đa một worker và tám preview trong RAM, TTL 15 phút tính bằng đồng hồ monotonic, thu hồi khi đọc trạng thái. Hủy/expiry/đổi target giữ slot tới khi worker thật thoát. Preview không lưu qua proxy restart; cần chọn file lại. **Bỏ bản kiểm tra cục bộ** chỉ xóa metadata trong RAM, giữ ZIP gốc. Đường dẫn đầy đủ được giữ riêng trong owner để có thể xác minh lại ở bước upload tương lai, không xuất ra IPC/status/log. Không có upload API hoặc thao tác Google trong mốc này.

[Kiểm thử P7b](evidence/g4-native-p7b-chat-import-preview.md) dùng Electron, preload sandbox, HTTP và worker thật, nhưng account identity và grant từ chooser là tổng hợp. Chưa nghiệm thu người dùng chọn ZIP bằng OS dialog thật hay upload Google.

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

Tài liệu Google hiện hướng dẫn import chat từ export ChatGPT/Claude dưới dạng ZIP, giới hạn ghi là 5 GB và tối đa năm ZIP/ngày. Tính năng yêu cầu tài khoản cá nhân đủ điều kiện; chưa khả dụng cho work/school/supervised hoặc một số khu vực. Reupload có thể ghi đè các cuộc chat đã nhập; import gián đoạn có thể chỉ hoàn tất một phần. Dữ liệu đã nhập nằm trong Activity và chịu cơ chế sử dụng dữ liệu của Gemini, gồm cải thiện dịch vụ/huấn luyện. [Hướng dẫn chính thức, đối chiếu 19/10/2026](https://support.google.com/gemini/answer/16868299?hl=en).

Các thông tin này không chứng minh Gemini A → B được hỗ trợ, không chứng nhận quyền của account đang chọn và không thay cho quan sát UI thật. Kiểm tra cục bộ không tiêu thụ lượt upload Google.

## Phần tiếp theo của P7

Workflow tiếp theo cần nghiệm thu OS chooser thật, kiểm tra capability import trên account, hiển thị dữ liệu sẽ truyền, xác minh lại file trước upload và theo dõi trạng thái nhập. Mỗi lần truyền phải có receipt/fence riêng; partial/outcome_unknown không được tự upload lại. Hoàn thành trên Web, phạm vi history/attachment giữ được và memory-text import vẫn cần nghiệm thu riêng.

Không dùng memory/imported history làm nơi chứa active tool policy, nonce hoặc chứng cứ bytes hiện tại của workspace. [Kế hoạch đầy đủ](NATIVE_UPGRADE_PLAN.md).
