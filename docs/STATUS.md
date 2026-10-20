# Trạng thái dự án

Mốc tài liệu: 20/10/2026, **native revision 45 / browser worker 27**.

## Đã có

- Ba màn hình light theme dùng chung trạng thái native owner.
- Tài khoản qua extension, metadata chat phân trang, nối chat ở lượt IDE mới.
- Xóa được tài khoản đang chọn và cuối cùng; giữ dấu chống gửi trùng.
- Runtime demo và giao diện cũ đã rời bản sản phẩm. Knowledge/ZIP không còn API hoặc màn hình vận hành.

## Đã kiểm thử ở đợt revision 45

- Build và typecheck: PASS.
- **330/330 tests PASS**.
- Electron smoke ở 1280/800 px: PASS, không lỗi renderer; browser giả lập.

## Còn cần làm

- Nghiệm thu lại IDE + Gemini thật: đổi A ↔ B, giữ context, tool loop, streaming và cancel/disconnect.
- Hoàn tất dọn thư mục tạm. Lệnh dọn hàng loạt trước đó bị cơ chế phê duyệt tự động chặn.

Đây là mốc kiểm thử, không phải trạng thái kết nối trực tiếp hiện tại. Xem trạng thái mới nhất tại **Kết nối**.

[Chi tiết kiểm chứng revision 45](evidence/simplification-r45.md) · [Lịch sử nghiên cứu](archive/README.md).
