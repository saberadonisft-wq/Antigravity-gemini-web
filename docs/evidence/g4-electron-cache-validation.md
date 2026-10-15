# G4 — Sửa lỗi cache khi khởi động Electron

Ngày 15/10/2026. Trigger: mở `npm run launcher`, terminal báo `Unable to move the cache: Access is denied (0x5)`, `Unable to create cache` và `Gpu Cache Creation failed: -2`.

## Chẩn đoán và bản vá

Launcher cũ dùng shell profile mặc định `%APPDATA%\Antigravity Gemini Web`. Owner có FullControl và phép thử tạo/xóa file do probe sở hữu trong các cache directories đều thành công; chưa có bằng chứng ACL bị sai hoặc cần chạy Administrator. Không xác định lock holder/corrupt index cụ thể từ ảnh lỗi.

Probe Electron tái hiện `Unable to move the cache` khi mở process thứ hai cùng profile, dù process đó đi vào nhánh `app.quit()` và exit 0. Đổi nhánh không lấy được single-instance lock sang `app.exit(0)` loại bỏ lỗi trong ca tái hiện. Process phụ chưa tạo runtime/window nên không có lifecycle công việc cần shutdown.

`configureElectronStorage` đặt rõ hai paths trước app ready và trước instance locking:

- Live `userData`: `%USERPROFILE%\.gemini\antigravity-gemini-web-live\electron`.
- Demo `userData`: `%USERPROFILE%\.gemini\antigravity-gemini-web-demo\electron`.
- `sessionData`: thư mục `session` bên trong `userData` tương ứng.
- Smoke: `electron/session` nằm trong owned OS temp sandbox.

Helper tạo thư mục trước `setPath` và từ chối cấu hình muộn sau ready. Yêu cầu thời điểm API theo [Electron setPath](https://www.electronjs.org/docs/latest/api/app#appsetpathname-path) và [ESM startup](https://www.electronjs.org/docs/latest/tutorial/esm#you-must-use-await-generously-before-the-apps-ready-event).

Runtime settings/receipts/journal và Chrome profile Gemini không đổi. Không xóa/chuyển cache cũ, đổi ACL, tắt GPU cache hoặc tắt sandbox. Shell cache Demo persistent và tách Live; runtime Demo vẫn dùng dữ liệu temp theo mỗi instance.

## Kiểm chứng

| Kiểm tra | Kết quả |
|---|---|
| `npm run build` | PASS |
| `npm run test:desktop-cache` | PASS: actual Electron renderer first launch, concurrent second process, restart cùng profile; không cache-error lines |
| `npm test` | 148/148 PASS, không thêm unit test chỉ kiểm tra literal path |
| `npm run typecheck` / `npm run lint` | PASS |
| `npm run test:desktop` | PASS: production bootstrap dùng explicit paths, actual two-process handler, IPC/window/dialog/UI acceptance; cache-error output làm suite fail |

Cache probe dùng helper production với home giả trong owned OS temp, không Google account hoặc app data live. Chờ process `close`, exit code và quan sát stderr; giữ startup/exit watchdog và cleanup failure. Failure probe đầu gồm capture trước compositor frame sẵn sàng và cleanup bị lock; probe cache hiện kiểm DOM renderer readiness (không pixel screenshot), đợi stdio/process close và cleanup async có budget. Không che cache failure hoặc bỏ qua failed cleanup.

Thư mục từ lần probe lỗi `launcher-cache-check-HTLJnh` được giữ lại: automatic approval review chặn thao tác xóa với thông báo `blocked by policy`, không có lý do chi tiết. Không thử cách xóa khác. Các lần probe thành công mới cleanup riêng của chúng; không quan sát process fixture/smoke còn chạy. Instance launcher cũ của người dùng không bị dừng tự động.

Source: [storage helper](../../apps/launcher/src/main/electron-storage.ts), [bootstrap](../../apps/launcher/src/main/index.ts), [cache fixture](../../apps/launcher/src/main/cache-smoke-main.ts), [probe runner](../../apps/launcher/scripts/cache-smoke.mjs).

Để áp dụng trên instance người dùng đang chạy: đóng launcher cũ, `Ctrl+C` terminal cũ, chạy lại `npm run launcher`. Cần đóng bản cũ trước vì profile/single-instance key đã đổi; không chạy đồng thời bản cũ và mới trên cùng runtime data. [Hướng dẫn test](../G4_USER_TEST_GUIDE.md). Native/live G4-B vẫn chưa nghiệm thu.
