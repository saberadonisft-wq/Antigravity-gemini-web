# Antigravity · Gemini Web

Dùng Gemini Web trong chat native Antigravity IDE, qua các hồ sơ Chrome đã ghép extension.

**Launcher chỉ có 3 màn hình:** Tài khoản · Đoạn chat · Kết nối.

## Cài đặt và chạy

Cần Windows, Chrome, Antigravity IDE, Node.js 22.13+ (22.x) hoặc 24+, npm 10+.

```powershell
cd D:\Antigravity-gemini-web
npm install
npm run build
npm run native:launch
npm run launcher
```

Lần đầu: [cài extension và ghép từng tài khoản](docs/CHROME_PROFILE_CONNECTOR.md). Trong IDE chọn **Gemini Web (Local)**.

## Tài liệu

- [Cách dùng và kiểm thử](docs/README.md).
- [Ghép hồ sơ Chrome](docs/CHROME_PROFILE_CONNECTOR.md).
- [Xử lý lỗi và nối chat](docs/NATIVE_RECOVERY_RUNBOOK.md).
- [Trạng thái và phần còn lại](docs/STATUS.md).

Lịch sử nghiên cứu nằm trong [archive](docs/archive/README.md); [thông báo bên thứ ba](THIRD_PARTY_NOTICES.md) được giữ cùng mã nguồn.
