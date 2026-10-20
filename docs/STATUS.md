# Trạng thái dự án

Mốc tài liệu: 20/10/2026, **native revision 45 / browser worker 27**.

## Đã có

- Ba màn hình light theme dùng chung trạng thái native owner.
- Tài khoản qua extension, metadata chat phân trang, nối chat ở lượt IDE mới.
- Xóa được tài khoản đang chọn và cuối cùng; giữ dấu chống gửi trùng.
- Runtime demo và giao diện cũ đã rời bản sản phẩm. Knowledge/ZIP không còn API hoặc màn hình vận hành.

## Kiểm thử chuẩn bị bản 0.1.0-beta.1

- Build và typecheck: PASS.
- **331/331 tests PASS**; gồm kiểm tra runtime đi kèm, đường dẫn và xử lý lỗi không lộ dữ liệu.
- Electron smoke ở 1280/800 px: PASS, không lỗi renderer; browser giả lập.
- Dependency audit: không phát hiện lỗ hổng tại lần kiểm tra.
- CI Windows chạy lại trên Node.js 22/24; chỉ công bố ZIP sau khi kiểm thử gói đã giải nén thành công. Trạng thái từng lần chạy xem tại [GitHub Actions](https://github.com/saberadonisft-wq/Antigravity-gemini-web/actions).

## Còn cần làm

- Nghiệm thu lại IDE + Gemini thật: đổi A ↔ B, giữ context, tool loop, streaming và cancel/disconnect.

Đây là mốc kiểm thử, không phải trạng thái kết nối trực tiếp hiện tại. Xem trạng thái mới nhất tại **Kết nối**.

[Chi tiết kiểm chứng revision 45](https://github.com/saberadonisft-wq/Antigravity-gemini-web/blob/main/docs/evidence/simplification-r45.md).
