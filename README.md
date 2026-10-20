# Antigravity · Gemini Web

Dùng tài khoản Gemini Web của bạn trong chat **Antigravity IDE**, qua các hồ sơ Chrome đã đăng nhập.

[Tải bản Windows](https://github.com/saberadonisft-wq/Antigravity-gemini-web/releases) · [Hướng dẫn ghép tài khoản](docs/CHROME_PROFILE_CONNECTOR.md) · [Xử lý lỗi](docs/NATIVE_RECOVERY_RUNBOOK.md)

## Ba màn hình, đủ để quản lý

- **Tài khoản:** thêm nhiều hồ sơ Chrome, ghép extension, chọn, kiểm tra và xóa tài khoản.
- **Đoạn chat:** xem trạng thái hội thoại đã lưu, tài khoản đang dùng và thao tác nối tiếp.
- **Kết nối:** theo dõi runtime, connector và lượt IDE đang hoạt động.

Giao diện sáng, hỗ trợ tiếng Việt và tiếng Anh. Không cần nhập API key Gemini.

## Tải và chạy trên Windows

**Yêu cầu:** Windows 10/11 x64, Google Chrome và **Antigravity IDE 2.5.5** cài tại vị trí mặc định. Các bản IDE khác chưa được hỗ trợ; ứng dụng sẽ dừng kết nối nếu không khớp phiên bản đã kiểm chứng.

1. Vào [Releases](https://github.com/saberadonisft-wq/Antigravity-gemini-web/releases), tải `Antigravity-Gemini-Web-…-windows-x64.zip` và giải nén toàn bộ vào một thư mục cố định.
2. Mở **Antigravity Gemini Web.exe**. Runtime đi kèm sẽ khởi động; không cần cài Node.js hoặc npm.
3. Chọn **Tệp → Mở thư mục extension**, rồi [cài extension vào từng hồ sơ Chrome và ghép tài khoản](docs/CHROME_PROFILE_CONNECTOR.md).
4. Chọn **Tệp → Mở dự án trong IDE…**, chọn thư mục dự án. Đăng nhập IDE nếu được yêu cầu.
5. Trong chat IDE, chọn **Gemini Web (Local)** và gửi yêu cầu.

Bản đầu là **beta**, chưa ký số. Windows có thể hiển thị cảnh báo nhà phát hành. File `SHA256SUMS.txt` được cung cấp cùng bản tải về để kiểm tra tính toàn vẹn.

## Những điều cần biết

- Bạn tự đăng nhập Google và hoàn thành xác minh khi được yêu cầu. Mỗi hồ sơ Chrome cần cài extension và ghép mã riêng.
- Extension có quyền `debugger`, `tabs`, `storage` để điều khiển tab Gemini và kết nối loopback trên máy. Không chia sẻ mã ghép nối.
- Dữ liệu bridge được lưu trong `%USERPROFILE%\.gemini\antigravity-gemini-web-live`. Nội dung gửi từ IDE sẽ được chuyển đến Gemini Web; chỉ dùng với dữ liệu bạn có quyền gửi.
- Đóng launcher không dừng lượt IDE đang chạy. Dùng **Tệp → Dừng kết nối** khi không còn tác vụ; không xóa thư mục bản cũ khi runtime của bản đó còn hoạt động.
- Khi kết quả gửi chưa rõ, bridge giữ dấu chống gửi trùng và không tự phát lại yêu cầu. [Cách phục hồi](docs/NATIVE_RECOVERY_RUNBOOK.md).
- Chat, đổi tài khoản và tool loop trên Gemini thật cần được nghiệm thu riêng; CI dùng browser giả lập. Đây là dự án độc lập, không liên kết với Google.

## Chạy từ mã nguồn

Cần Node.js 22.13+ (22.x) hoặc 24+, npm 10+ và các ứng dụng nêu trên.

```powershell
git clone https://github.com/saberadonisft-wq/Antigravity-gemini-web.git
cd Antigravity-gemini-web
npm ci
npm run build
npm run native:launch
npm run launcher
```

## Kiểm thử và phát hành

```powershell
npm run build
npm run typecheck
npm test
npm run test:desktop
npm run release:windows
npm run test:package
```

GitHub Actions kiểm thử trên Windows với Node.js 22 và 24. Job Node 24 tạo ZIP, giải nén và kiểm tra chính ứng dụng đóng gói. Tag `v<version>` khớp `package.json` chỉ được phát hành sau khi tất cả job đạt yêu cầu. Bản có hậu tố beta được đánh dấu pre-release.

[Tài liệu sử dụng](docs/README.md) · [Trạng thái kiểm thử](docs/STATUS.md) · [Báo lỗi](https://github.com/saberadonisft-wq/Antigravity-gemini-web/issues)

## Giấy phép

[Apache 2.0](LICENSE). Các thành phần bên thứ ba giữ giấy phép và thông báo bản quyền đi kèm bản phân phối.
