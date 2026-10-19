# Dùng mỗi hồ sơ Chrome làm một account

Source Native **42 / browser worker 26**, triển khai trực tiếp trên `main` theo yêu cầu. Extension ở `extensions/chrome-profile-connector`. Test fixture chưa chứng nhận các hồ sơ Google thật đã được ghép hoặc chat IDE đã chạy qua chúng.

## Cách hoạt động

Mỗi hồ sơ Chrome cài extension và lưu riêng mã ghép nối trong `chrome.storage.local`. Mỗi account bridge có credential, cổng loopback và MCP state riêng. Thư mục `profilePath` của account extension chứa metadata bridge, không phải thư mục hồ sơ Chrome cá nhân. Không sao chép cookie hoặc yêu cầu Chrome mở với cổng debug.

Extension dùng API `chrome.debugger` để phục vụ driver hiện có. Quyền này có phạm vi rộng và Chrome có thể hiển thị thông báo debugger; code connector giới hạn thao tác vào trang `https://gemini.google.com`, từ chối trang đăng nhập Google, website khác, ẩn danh và truyền file từ đường dẫn trên máy. Nó chỉ đóng tab do connector tạo, giữ tab có sẵn. [API chính thức](https://developer.chrome.com/docs/extensions/reference/api/debugger).

Mã ghép nối cho phép kết nối account bridge trên máy, cần giữ riêng như credential. Chỉ dán vào extension của đúng hồ sơ; không gửi vào Gemini hoặc log chia sẻ. Kết nối thành công chưa xác minh tài khoản Google. Bridge vẫn kiểm tra fingerprint trước Send; đổi tài khoản Gemini trong hồ sơ sẽ bị chặn nếu không khớp identity đã đăng ký.

## Chuẩn bị một lần

1. Chạy `npm run build`. Chờ lượt đang chạy kết thúc, dừng owner cũ bằng `npm run native:stop`, rồi chạy `npm run native:launch`. `npm run native:status` cần báo revision **42**. Worker cấu hình cũ cần xử lý theo [runbook](NATIVE_RECOVERY_RUNBOOK.md); không kill browser hoặc xóa fence để bỏ qua xung đột.
2. Trong **từng hồ sơ Chrome cần dùng**, tự mở `chrome://extensions`, bật Developer mode và chọn **Load unpacked / Tải tiện ích đã giải nén**. Chọn thư mục `D:\Antigravity-gemini-web\extensions\chrome-profile-connector`. Xem quyền extension trước khi cài. [Hướng dẫn Chrome](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked).
3. Mở Gemini trong từng hồ sơ, tự đăng nhập/xác minh nếu cần. Connector không thực hiện mật khẩu, OTP, CAPTCHA hoặc đăng nhập Google và không bảo đảm tránh được Google challenge.

Extension phải được cài riêng trong mỗi hồ sơ. Chuyển hồ sơ qua menu Chrome không thay cho việc ghép nối từng account.

## Ghép hồ sơ với account bridge

Ví dụ hồ sơ Chrome “Profile A”:

1. Trong launcher, thêm tài khoản **Profile A**, chọn **Hồ sơ Chrome có sẵn (extension)**. Hoặc dùng:

   ```powershell
   npm run native -- account:add "Profile A" --transport extension
   ```

2. Tại dòng account mới, chọn **Khởi động connector**. Thao tác khởi động worker của account, không mở Chrome hoặc gửi prompt.
3. Chọn **Sao chép mã ghép nối** ở dòng Profile A. Mã được chép vào clipboard của máy; launcher không hiển thị mã trong giao diện.
4. Trong Chrome của **đúng Profile A**, mở extension, dán mã và chọn **Lưu mã ghép nối**, rồi **Kết nối**. Mã được xóa khỏi ô nhập sau khi lưu. Chờ badge **ON**, mở lại popup để kiểm tra. Một mã chỉ có một extension kết nối cùng lúc; kết nối thứ hai bị từ chối.
5. Trong launcher, chọn **Kiểm tra danh tính** cho Profile A. Sau khi đúng account được ghi nhận, chọn **Chọn cho lượt sau** trong chế độ định tuyến manual.
6. Lặp lại cho Profile B, C… bằng mã riêng. Không dùng lại mã Profile A cho hồ sơ khác. Tên Chrome/bridge là nhãn, không phải bằng chứng danh tính Google.

## Chọn account cho chat IDE

Ở mục **Tài khoản Web**, chọn policy **Thủ công** hoặc **Ghim theo chat**. Thủ công dùng account đang chọn cho mỗi lượt mới. Ghim theo chat gắn chat IDE vào account phục vụ lượt đầu tiên; các lượt sau trong chat đó tiếp tục dùng account đã ghim. Đổi account mặc định chỉ áp dụng với chat IDE mới. Có thể xem binding và bỏ ghim ở mục khôi phục trong cùng trang. Đổi policy chỉ thực hiện khi không có lượt Native đang chạy.

Policy này chỉ định account/profile; model vẫn do lựa chọn Gemini Web và model native của IDE quyết định. Nếu launcher báo `NATIVE_MODEL_NOT_SELECTED`, bridge đã chặn lượt trước khi gửi tới Gemini Web: chọn **Gemini Web (Local)** trong IDE, rồi mở chat mới hoặc khởi động lại IDE để nạp lại catalog model. Không đổi sang một model Google/API khác để vượt chốt này.

## Xóa account khỏi bridge

Trong dòng tài khoản, chọn **Xóa khỏi bridge** rồi xác nhận. Thao tác chỉ gỡ account khỏi registry Native; không xóa thư mục hồ sơ Chrome, dữ liệu đăng nhập hay file hồ sơ. Không thể xóa account đang chọn, account cuối cùng, account còn chat được ghim hoặc account còn giữ phiên chat/dọn dẹp. Hãy chuyển account đang chọn, bỏ ghim chat và xóa account khỏi thứ tự ưu tiên định tuyến trước khi thử lại.

Sau khi đóng Chrome, restart worker hoặc ngắt kết nối: mở lại đúng hồ sơ, mở Gemini, khởi động connector của account nếu cần rồi bấm **Kết nối** trong extension. Phiên bản này không tự kết nối lại hoặc tự phát lại command. Không cần đăng nhập lại nếu phiên của hồ sơ còn hợp lệ.

## Kiểm tra và giới hạn

- Badge ON xác nhận ghép nối, chưa chứng minh Google identity, quota hoặc khả năng model. Hoàn tất kiểm tra danh tính ở launcher trước khi dùng chat native.
- Nếu chưa kết nối: kiểm tra revision, account đã khởi động connector chưa, Gemini đang mở trong đúng hồ sơ và mã có đúng account không. Sau đó tự bấm Kết nối; không tự gửi lại lượt IDE bị lỗi.
- Nếu Chrome báo `Service worker registration failed. Status code: 3` cùng `Top-level await is disallowed in service workers`, hãy tải lại extension trong `chrome://extensions` sau khi cập nhật thư mục extension. Bản 0.1.1 đã chuyển khởi tạo bất đồng bộ vào hàm service worker; sau khi tải lại, popup phải hiện `Chưa ghép nối` thay vì kẹt ở `Đang kiểm tra…`.
- Hủy debugger hoặc tab chuyển sang website khác sẽ ngắt connector. Kết quả sau Send có thể unknown; kiểm tra Web/receipt theo runbook trước khi tạo lượt mới.
- **Ngắt kết nối** ở popup dừng đường điều khiển; tab người dùng được giữ. Không xóa dữ liệu Chrome hay Native receipt để sửa kết nối.
- Bản này hỗ trợ context **văn bản**, fragment/ACK và model staging hiện có. Attachment từ file và probe trang import qua connector chưa được hỗ trợ. Attachment experiment sẽ bị từ chối thay vì tự truyền file.

Gate thực tế còn mở: hai hồ sơ Google riêng, chat native A → B → A trong cùng chat IDE, giữ context và công cụ IDE, cancel/disconnect và xác nhận không gửi trùng. Chỉ ghi nghiệm thu sau khi có bằng chứng thực tế.
