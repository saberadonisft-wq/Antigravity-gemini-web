# Chrome profile connector — Native 41 / browser worker 26

Ngày 19/10/2026, connector cho phép một hồ sơ Chrome thông thường được ghép với một account Native bridge riêng. Mỗi account có credential/worker riêng; extension giữ mã ghép trong storage của đúng Chrome profile. Connector điều khiển tab Gemini đã cho phép, từ chối trang đăng nhập/website khác và file upload, giữ tab có sẵn của người dùng, đồng thời không phát lại command sau khi mất kết nối.

## Kiểm chứng local

- `npm run build` — PASS.
- `npm run typecheck` — PASS.
- `npm run lint` — PASS.
- `npm test` — PASS, **449/449** tests trên bảy workspace: contracts 14, gemini-browser 54, mcp-server 53, model-bridge 4, native-antigravity 190, runtime 80, launcher 54.
- Connector tests bao gồm extension worker fixture, broker/WebSocket authentication, tách routing theo profile, chặn lệnh/tab không hỗ trợ, disconnect không replay, worker MCP được spawn thật trong fixture Native và xác minh account đổi trước thao tác input.
- Electron launcher smoke — PASS, runtime revision 41; account transport `extension` được tạo trong UI và hiện nút **Start connector**. Chụp giao diện ở 1280px và 800px; không tràn ngang, target tối thiểu 44px, không có lỗi renderer. Owner HTTP và preload IPC là tiến trình thật; browser/Google được giả lập; `realGoogleRequests=0`, executor IDE chưa kiểm tra. Kết quả và ảnh nằm trong [thư mục evidence](chrome-profile-connector-r41).
- `node --check` cho `background.js`/`popup.js`, `git diff --check` — PASS.

Lượt chạy workspace đầu tiên có một lỗi chập chờn ở test CDP import (`browser_unavailable`) khi test khác còn hoạt động. Test đó PASS khi chạy riêng và PASS trong lượt full suite cuối; lượt full suite cuối không có test lỗi.

## Chưa nghiệm thu

Extension **chưa được cài** vào các hồ sơ Chrome cá nhân và chưa ghép bất kỳ tài khoản Google thật nào. Chưa có bằng chứng gửi prompt qua Chrome extension thật, dùng chat native IDE, giữ context qua A → B → A, chạy tool loop, hoặc xử lý cancel/disconnect trong phiên người dùng. Vì vậy đây là implementation có kiểm chứng local, chưa phải xác nhận connector đã hoạt động trên sáu hồ sơ của người dùng.

Để cài và ghép thủ công từng profile, làm theo [hướng dẫn connector](../CHROME_PROFILE_CONNECTOR.md). Không nhập mật khẩu, OTP hoặc CAPTCHA vào bridge; đăng nhập Google vẫn do người dùng thực hiện trong profile đó.
