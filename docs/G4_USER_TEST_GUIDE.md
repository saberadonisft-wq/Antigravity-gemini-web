# Test thủ công bản G4

Bản hiện tại đã nghiệm thu **G4-A launcher/desktop/fixture**, chưa tích hợp chat native Antigravity qua Gemini Web thật. [Bằng chứng](evidence/g4-acceptance-validation.md).

**Nếu bạn đang chạy bản trước sửa cache:** đóng cửa sổ launcher cũ và `Ctrl+C` terminal cũ, rồi chạy lại các lệnh bên dưới. [Bản vá cache](evidence/g4-electron-cache-validation.md) dùng shell profile mới; không chạy bản cũ và mới đồng thời trên cùng runtime data.

## Mở giao diện Demo

Trong PowerShell:

```powershell
Set-Location "D:\Antigravity-gemini-web"
npm run launcher:demo
```

Artifacts đã build trong workspace này. Nếu bạn sửa source trước khi thử, chạy `npm run build` rồi mở lại. Không cần API key hay tài khoản Google để thử Demo.

1. Dùng picker **Kịch bản / Scenario** trên banner Demo để thử đủ 10 trạng thái. Demo luôn có nhãn mô phỏng.
2. Vào Settings, đổi vi/en và light/dark/system rồi Save. Nhãn picker phải đổi theo ngôn ngữ; cài đặt đã lưu còn sau reload trong cùng instance.
3. Chọn scenario “Đang xử lý”, vào Sessions và thử Cancel. Demo giữ yêu cầu đang chờ xác nhận; có thể chọn scenario “Yêu cầu hủy” để xem pending state. Không có host tool thật trong Demo.
4. Chọn mất kết nối, kiểm tra form bị khóa; đổi scenario qua picker để thử trạng thái khác. Automatic reconnect/cancel success/failure đã được kiểm tra bằng fixture control trong suite, không có nút giả xác nhận host trên bản Demo.
5. Thử Activity filters và nút export; co cửa sổ xuống 800×600, dùng Tab/Enter. Native install/model/E2E vẫn khóa theo capability.

Demo dùng temp data riêng cho mỗi lần khởi động; không dùng nó để kiểm tra persistence giữa hai lần mở app.

Temp ở đây là runtime data. Electron shell/cache Demo được giữ riêng tại `%USERPROFILE%\.gemini\antigravity-gemini-web-demo\electron\session`, tách Live.

## Mở launcher Live control

Đóng Demo, rồi chạy:

```powershell
npm run launcher
```

Live control dùng data riêng tại `%USERPROFILE%\.gemini\antigravity-gemini-web-live\app_data`. Bạn có thể thử Settings persistence qua restart, Save/Cancel export và khởi chạy launcher lần hai: cửa sổ cũ được focus, không tạo runtime owner thứ hai.

Electron shell nằm tại `%USERPROFILE%\.gemini\antigravity-gemini-web-live\electron`, cache/session nằm trong `electron\session`. Runtime settings và Chrome Gemini profile không đổi sau bản vá cache.

Nếu bấm **Mở đăng nhập / Open Login**, launcher mở Chrome/profile do ứng dụng sở hữu ở port 9223. Bạn tự đăng nhập Google/MFA trên cửa sổ đó nếu muốn tiếp tục kiểm chứng G4-B. Port bận bị từ chối; không dùng Chrome cá nhân hoặc profile probe port 9222. Account ready chỉ là browser gate, **không mở native inference hoặc host tool E2E**.

## Chạy kiểm tra tự động

```powershell
npm test
npm run test:desktop
npm run test:desktop-cache
```

Kết quả hiện tại: 148 TS tests PASS; desktop suite chạy actual Electron/Windows dialogs cùng DOM fixture, không Google account. Desktop suite có thể mở/focus cửa sổ và Save dialog ngắn trong quá trình test; dữ liệu chỉ nằm trong temp.

Khi báo lỗi, ghi view/scenario, thao tác vừa bấm, error code và hành vi mong đợi. Không gửi cookie, Google credential hoặc nội dung riêng tư. Dừng G4; chưa G5/installer.
