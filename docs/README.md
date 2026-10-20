# Tài liệu sử dụng

| Bạn cần | Đọc |
|---|---|
| Cài và ghép các tài khoản | [Hồ sơ Chrome](CHROME_PROFILE_CONNECTOR.md) |
| Mất kết nối, lỗi gửi hoặc nối chat | [Xử lý lỗi](NATIVE_RECOVERY_RUNBOOK.md) |
| Biết đã kiểm thử gì, còn thiếu gì | [Trạng thái dự án](STATUS.md) |

## Ba màn hình

- **Tài khoản:** thêm, ghép, kiểm tra danh tính, chọn, tạm ngưng và xóa.
- **Đoạn chat:** xem trạng thái đã lưu, ghim tài khoản, hủy lượt và đánh dấu nối hội thoại.
- **Kết nối:** xem native owner, connector và hoạt động IDE quan sát được.

Chọn tài khoản và gửi yêu cầu trong **Antigravity IDE**, với model **Gemini Web (Local)**. Launcher dùng light theme; các màn hình cùng đọc trạng thái từ native owner.

## Kiểm thử khi sửa mã

Chạy tại thư mục dự án:

```powershell
npm run build
npm run typecheck
npm test
npm run test:desktop
```

Build tạo lại output trước khi chạy test. Desktop smoke dùng Electron thật và browser giả lập; cần kiểm tra riêng chat và tool loop trên IDE + Gemini thật.

[Lịch sử và thiết kế cũ](https://github.com/saberadonisft-wq/Antigravity-gemini-web/tree/main/docs/archive) dành cho tra cứu, không phải hướng dẫn vận hành hiện tại.
