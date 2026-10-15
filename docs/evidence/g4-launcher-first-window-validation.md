# G4 — Cửa sổ bị ẩn khi chạy launcher lần đầu

Ngày 15/10/2026. Sau bản vá cache, `npm run launcher` vẫn chạy nhưng không hiện cửa sổ.

## Tái hiện và nguyên nhân

- Process Electron của repo PID 25116 có renderer đang chạy nhưng không có cửa sổ targetable trong danh sách Windows.
- Chạy lại cùng lệnh tạo secondary instance; handler `second-instance` gọi `show()`/`focus()` khiến cửa sổ owner hiện ngay. Đọc UI thật xác nhận renderer đã tải và runtime ready; đây không phải chờ đăng nhập hoặc native inference.
- `apps/launcher/scripts/start.mjs` spawn GUI Electron với `windowsHide: true`. Thay bằng `false` để lần mở đầu tiên không bị Windows ẩn. Không sửa runtime, browser profile, sandbox hay cấu hình IDE.

## Kiểm chứng trực tiếp qua entry point người dùng

1. Đóng cửa sổ owner cũ bằng Alt+F4.
2. Chạy `npm run launcher` từ repo, không bật smoke hoặc demo.
3. Owner mới PID 5188 được tạo lúc 11:10:44; cửa sổ `Antigravity · Gemini Web` tự xuất hiện, HWND 329396, trước khi có thao tác activate/show hoặc chạy secondary instance.
4. Computer Use đọc cửa sổ thật: `Tổng quan hệ thống`, `Runtime: ready`, `Chế độ: Live Desktop`. Các nút điều hướng và nội dung được render. Không còn lỗi cache trong output khởi động.

Để cửa sổ mới mở cho người dùng test. Terminal tiếp tục chạy trong khi ứng dụng mở là bình thường.

## Giới hạn kiểm chứng

Smoke trước đây chạy entry point riêng và có thao tác `show()` ở phần kiểm tra UI/lifecycle, nên không chứng minh cửa sổ hiện ngay khi chạy `scripts/start.mjs`. Khi kiểm thử startup thủ công, phải đóng owner cũ, chạy chính `npm run launcher`, xác nhận cửa sổ hiện trước khi gọi activate/show hoặc mở instance thứ hai.

Bản sửa chỉ đổi tùy chọn spawn trong script JavaScript, không cần build lại. Đã kiểm tra cú pháp script; không chạy lại toàn bộ suite hay coi số lượng test trước đó là bằng chứng cho bản sửa này. Native inference vẫn `unverified`; bản sửa chỉ xác nhận launcher hiển thị bình thường.

Tham khảo API: [Node child_process spawn](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options), [Electron BrowserWindow show](https://www.electronjs.org/docs/latest/api/browser-window#winshow).
