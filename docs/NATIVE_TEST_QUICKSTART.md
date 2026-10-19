# Chạy bản để tự test

Source Native **40 / browser worker 25**. Đây là bản thử nghiệm; các test fixture không thay cho nghiệm thu tài khoản Google và executor IDE thật. Chỉ dùng một Native owner cho cùng bộ profile/state.

## Chạy

Trong PowerShell tại thư mục dự án, sau build:

```powershell
cd D:\Antigravity-gemini-web
npm run native:launch
```

Mở terminal khác nếu muốn dùng màn hình quản lý:

```powershell
cd D:\Antigravity-gemini-web
npm run launcher
```

Chạy `npm run native:status` để kiểm tra owner đang chạy có `runtimeRevision: 40`. Nếu còn bản cũ, chờ hết lượt rồi dừng owner bằng `npm run native:stop` trước khi chạy lại. Không xóa profile, receipt hoặc fence để vượt lỗi. Worker cũ có cấu hình khác phải được dừng theo [runbook](NATIVE_RECOVERY_RUNBOOK.md); không dùng chung một profile giữa hai owner.

Đăng nhập/xác minh Google trong cửa sổ profile được mở. Giữ model chính bạn muốn dùng trên Web. Context đầu mặc định chọn `3.8 Flash`, rồi khôi phục model chính trước COMMIT; nếu account không có lựa chọn đó thì trả lỗi, không âm thầm thay model. Luồng hai model vẫn cần bạn nghiệm thu thật. Các lượt lỗi/unknown cũ không tự chạy lại.

Bản 40 sửa lỗi lượt append vẫn bị chuyển sang staging 3.8 và yêu cầu ACK dù prompt ngắn. Append/patch/replace dùng model chính; cập nhật dài vẫn có thể cần chia fragment và ACK. [Bằng chứng](evidence/g4-native-r40-context-model-scope.md). Khi Secondary bị Google từ chối đăng nhập, giữ nguyên Default và chỉ chọn Default để smoke test nếu vẫn đăng nhập được. Không coi Secondary đã sẵn sàng cho test A ↔ B.

## Test nhanh trong chat native của IDE

1. Gửi `Chỉ trả lời NATIVE_READY`. Kiểm tra IDE nhận câu trả lời và lượt kết thúc.
2. Gửi `Dùng công cụ IDE đọc README.md, cho biết dòng đầu tiên; không sửa file.` Kiểm tra có lời gọi đọc file và kết quả công cụ thực tế trong IDE.
3. Gửi một câu tiếp nối yêu cầu nhắc lại thông tin vừa đọc. Quan sát đúng chat, không mất ngữ cảnh hoặc tạo thêm lượt tự gửi.
4. Thử Stop trên một lượt mới đang sinh. Nếu không xác nhận dừng hoặc báo outcome_unknown, kiểm tra Web/receipt theo runbook trước khi gửi yêu cầu mới.
5. Nếu đã đăng nhập hai profile riêng, chuyển account tại launcher rồi gửi một câu tiếp nối trong cùng chat IDE. Xác nhận đúng account phục vụ; khả năng giữ ngữ cảnh A ↔ B là gate cần thử thật.

Đọc README chỉ là smoke test. Gate đọc → sửa → chạy checker cần fixture riêng, kết quả file thật và receipt executor; xem [hướng dẫn G4](NATIVE_SETUP.md), không ghi PASS chỉ từ câu trả lời của model.

## Preview ZIP và kiểm tra trang import

Để bật nhánh thử nghiệm, đặt `$env:AG_NATIVE_IMPORTS_EXPERIMENTAL='1'` trước khi khởi động Native owner, sau đó mở **Nhập lịch sử** trong launcher. Chọn account/provider rồi chọn ZIP qua hộp thoại Windows. Kiểm tra tên file/số byte/hash, hủy chọn, hủy kiểm tra và đổi account. Preview chỉ đọc file trên máy, không upload Google.

Trong đúng profile account, tự mở trang import từ menu Gemini. Lấy account ID từ `npm run native:accounts`, rồi chạy:

```powershell
npm run native:imports:check -- ACCOUNT_ID
```

Lệnh chỉ quan sát tab đang có; không mở/navigate tab, bấm Add, chọn file, dán memory hoặc Send. `controls_observed` chỉ xác nhận nhìn thấy controls và identity khớp tại thời điểm đó; không chứng nhận quyền import, quota, upload thành công hoặc chuyển Gemini A → B. `not_observed` cũng không đủ để kết luận account không được hỗ trợ. [Chi tiết và giới hạn](NATIVE_CHAT_IMPORT.md).

Khi báo lỗi, gửi code lỗi, `runtimeRevision`, bước đang thử và ảnh IDE/Web. Không gửi cookie, control token hoặc toàn bộ descriptor. Upload/import thật, các adapter cloud và các gate phát hành vẫn còn trong [kế hoạch đầy đủ](NATIVE_UPGRADE_PLAN.md).
