# Tinh gọn native revision 45 / browser worker 27

Ngày thực hiện: 20/10/2026. Triển khai trên working tree hiện có. Xem Git log để xác định commit của đợt thay đổi; không reset các thay đổi trước đó.

## Kết quả sản phẩm

- Launcher có đúng ba route: Tài khoản, Đoạn chat, Kết nối; luôn dùng light theme.
- Cả ba dùng cùng một `NativeAccountStore` và native owner. Production launcher không còn tạo `RuntimeFacade`, `FakeRuntimeEngine` hoặc `OwnedBrowserAdapter`.
- Bỏ năm view phụ khỏi build, điều hướng ẩn, 11 icon không dùng, i18n cũ và 55 rule CSS không còn consumer. CSS renderer sau build: 11,88 kB; đây không phải phép đo tốc độ Gemini.
- Chuyển runtime demo/model-bridge sang `tools/archive/packages`; workspace đang build giảm từ 7 xuống 5. Mã lịch sử không được nhập vào entry production.
- Production preload chỉ có ba thao tác: đọc snapshot, gửi account command và sao chép pairing vào clipboard của main process. Không đưa owner token/pairing secret vào renderer.
- Form và CLI chỉ thêm tài khoản extension. Registry có thể rỗng; bỏ tự tạo Default Account. Native pool chặn việc mở hồ sơ CDP legacy nhưng giữ nguyên dữ liệu để xóa/phục hồi thủ công.
- Có thể xóa tài khoản đang chọn và tài khoản cuối cùng. Nếu có trạng thái chat đang giữ, vẫn cần xác nhận retire; active turns/bindings/authority vẫn được kiểm tra.
- Đoạn chat đọc metadata phân trang 50 mục từ `NativeConversationState`: task scope, account/epoch, URL, trạng thái và thời gian. Không gửi prompt, nonce hoặc canonical context ra UI. Retired replay fences được giữ trong store và không hiện thành chat còn tiếp tục được.
- Kết nối đọc trạng thái socket và số tab Gemini qua endpoint connector đã xác thực. Không dùng thời hạn xác minh email để suy ra connector có nối hay không. Lượt IDE đang chạy và kết quả gần nhất được hiển thị theo quan sát, không gán trạng thái connected chung khi chưa có bằng chứng.
- Ghim/resume/cancel nằm tại Đoạn chat. Resume chỉ đánh dấu cho lượt IDE mới; không tự phát lại yêu cầu cũ.
- Rút knowledge/ZIP handlers và CLI khỏi API sản phẩm. Khi xóa account có knowledge binding cũ, lưu bản backup rồi gỡ metadata liên kết; tệp nguồn không bị xóa. Standalone parser/registry tests còn giữ để bảo vệ dữ liệu/migration.
- Tách model catalog/selector sang `native-catalog.ts`; giữ nguyên giao thức và thứ tự admission/receipt của inference.
- Vô hiệu hóa hai MCP entry độc lập thuộc checkout trong workspace và `~/.gemini/config/mcp_config.json`, có backup. Browser MCP nội bộ vẫn do native owner quản lý. Host/gateway source còn giữ để tương thích nghiên cứu, không nằm trong launcher hoặc startup mặc định.
- Build sạch trước khi test để tránh chạy `dist` của feature đã bỏ. Loại alias lint trùng typecheck và acceptance fixture build không dùng; README hiện hành đã viết lại, README/setup cũ nằm trong `docs/archive`.

## Kiểm chứng

1. Build sạch toàn bộ workspace: PASS.
2. Typecheck toàn bộ workspace: PASS.
3. Toàn bộ suite còn hoạt động: **330/330 PASS**, gồm contracts 14, gemini-browser 59, mcp-server 54, native-antigravity 192, launcher 11.
4. Sau lần dọn copy/icon/CSS cuối: build launcher, typecheck launcher và Electron desktop smoke PASS.
5. Desktop smoke dùng Electron/preload sandbox/loopback owner thật, browser giả lập. Thao tác qua nút hiển thị bằng mouse events; không click route ẩn.
6. Smoke xác nhận ba tab, metadata chat được giữ, mất owner khóa thao tác, sao chép mã không lộ secret, thêm extension, xóa tài khoản đang chọn/cuối cùng và tạo lại tài khoản mới. Kiểm tra 1280/800 px, không tràn ngang, nút tối thiểu 44 px, không có renderer error.
7. Browser suite kiểm tra CDP trên DOM fixture, retained tab, streaming, cancel, identity và connector authentication. Không thay cho Google live.

Artifacts local: `.tmp/simplification-tests-final.log`, `.tmp/desktop-simplification/`. Báo cáo smoke và ảnh nằm cùng thư mục. Những artifact này được ignore, không phải dữ liệu Google.

## Runtime và dữ liệu thật

Native owner hiện chạy revision 45; launcher mới được mở lại. Đọc trực tiếp qua `NativeOwnerClient` xác nhận hai tài khoản `gemini1` và `gemini2` đều giữ transport extension, không có lượt đang chạy, và hiển thị 21 metadata hội thoại chưa retire. Inventory trước thay đổi có 30 entries tổng cộng, bao gồm các fence/entry đã retire; không lấy chênh lệch hai số này làm số chat bị mất.

Đã khởi động hai connector worker mà không gửi prompt. Lúc kiểm tra, cả hai socket extension đang **disconnected**; người dùng cần bấm Kết nối trong extension ở đúng hồ sơ Chrome rồi xác minh danh tính. Không tự đăng nhập Google, không gửi lượt inference hoặc tool loop live để tuyên bố nghiệm thu.

## Dọn đĩa còn dang dở

Đã giữ bản đối chiếu working tree trong `.tmp/simplification-baseline`. Một lần `git worktree remove` đã bỏ đăng ký baseline cũ nhưng Windows để lại một phần thư mục. Các worktree còn lại và các tệp chưa theo dõi vẫn còn.

Lệnh dọn hàng loạt `.tmp` bị cơ chế phê duyệt tự động chặn; đã dừng phần xóa, không thử lại bằng công cụ khác. Đo sau lần dọn dở: `.tmp` khoảng **768,83 MiB**, so với **808,13 MiB** lúc review. Số đo chịu ảnh hưởng của log/build evidence mới; không coi toàn bộ phần còn lại là rác hoặc báo đã thu hồi đủ 808 MiB.

P0–P2 và phần tinh gọn đường chạy sản phẩm của P3 đã thực hiện. P4 đã cập nhật build/tài liệu; dọn đĩa hoàn toàn và nghiệm thu IDE + Gemini thật còn mở. Host/gateway và tiện ích offline được giữ ngoài luồng mặc định để tương thích, chưa xóa vật lý mọi nguồn nghiên cứu.
