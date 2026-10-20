# ADR 0011 — Nguồn tham chiếu theo task/account, không cấp quyền thực thi

Trạng thái: P6a source 34 và P6b UI trong source 35; P6 còn gate live/adapter/chất lượng.

## Quyết định

Native owner giữ registry metadata có schema strict, revision CAS và ghi atomic/private. CLI và launcher gọi owner có xác thực, không có pool hay profile dùng chung mới. Launcher main cấp file paths từ OS chooser; renderer chỉ được gửi label/authority, chọn binding, kiểm tra/refresh hoặc xóa metadata. Import source paths và đăng ký integration URL không nằm trong renderer command allowlist. Response chỉ có selected relative filenames; root/token/source contents không được chuyển qua IPC.

File selection tường minh, provenance commit/hash và local overlay tạo nguồn bất biến theo revision. Binding chứa task scope, account ID và identity epoch. Account mới phải được người dùng chọn nguồn riêng. Quyền Web của Gem/Notebook/Drive là capability khác, chưa suy ra từ local binding hoặc trạng thái đăng nhập.

Request ID vẫn tính từ native context/caller/scope ban đầu. Dữ liệu tham chiếu chỉ được bổ sung sau admission vào conversation context và cùng cơ chế revision/patch. Thêm/bỏ nguồn không tạo request ID khác để vượt dedup hoặc hàng rào không replay. Lease kiểm tra registry/source tại physical submission và trước reply; stale cached replies bị thu hồi mà không Send lại.

Snapshot knowledge không thay system/tool inventory, nonce, approvals hay function policy của native request. Thiếu hoặc quá lớn có thể bỏ nguồn bổ trợ kèm diagnostic; không cắt context IDE. Nếu nguồn đổi sau Send, lỗi không tự động trở thành bằng chứng not_sent. Failover hữu hạn lấy lại binding của account đích, không mang nguồn của A sang B.

Gem/Notebook/Drive/GitHub Web đăng ký metadata độc lập và luôn not_verified cho đến khi có adapter/capability/live evidence tương ứng. Không mở rộng origin prompt, tự chia sẻ nguồn hoặc coi nút Web là chứng nhận quyền.

## Hệ quả và giới hạn

Registry không lưu bytes nguồn; root/path là metadata riêng tư. Transport P3 có cơ chế file snapshot tạm riêng nếu được bật. Kiểm tra local hash/commit không chứng minh model hiểu nguồn hoặc IDE đã đọc bytes mới trước sửa; gate đó vẫn mở. CLI P6a và kiểm thử tổng hợp không thay cho nghiệm thu nguồn Web, hai account Google, chat dài và executor IDE thật.

Xem [câu lệnh và rollback](../guides/NATIVE_KNOWLEDGE.md), [evidence P6a](../../evidence/g4-native-p6a-project-knowledge.md), [P6b UI](../../evidence/g4-native-p6b-project-knowledge-ui.md), [ADR context](0010-native-context-updates.md).
