# Xử lý lỗi và nối chat

## Kiểm tra nhanh

Mở **Kết nối** trong launcher hoặc chạy:

```powershell
npm run native:status
npm run native:accounts
```

| Tình trạng | Cách xử lý |
|---|---|
| Native owner không chạy | Chạy `npm run native:launch`, rồi làm mới launcher. |
| Source và runtime khác phiên bản | Đợi lượt hiện tại kết thúc, chạy `npm run native:stop`, rồi `npm run native:launch`. |
| Connector mất kết nối | Khởi động connector ở launcher; mở Chrome đúng hồ sơ và bấm **Kết nối** trong extension. |
| Cần đăng nhập/xác minh Google | Hoàn thành trực tiếp trong Chrome, rồi **Kiểm tra danh tính** ở launcher. |
| `ACCOUNT_IDENTITY_UNVERIFIED` hoặc sai danh tính | Kiểm tra tài khoản Google đang mở trong đúng hồ sơ. Nếu dùng tài khoản khác, tạo mục ghép riêng. |
| `NATIVE_MODEL_NOT_SELECTED` | Chọn **Gemini Web (Local)**. Nếu vẫn lỗi, mở chat mới hoặc khởi động lại IDE để nạp catalog. |
| `BUSY` | Chờ lượt kết thúc hoặc hủy tại **Đoạn chat**; có thể cần kiểm tra nút Stop trên Gemini. |
| `ACCOUNT_IN_USE` khi xóa | Xác nhận xóa trạng thái tiếp tục trong hộp xóa tài khoản. |
| `ACCOUNT_BOUND` khi xóa | Bỏ ghim ở **Đoạn chat**; bỏ thứ tự ưu tiên định tuyến nếu đã cấu hình. |

Nếu extension kẹt “Đang kiểm tra” hoặc báo service worker: mở `chrome://extensions`, bấm tải lại extension và ghép/kết nối lại.

## Nối lại hội thoại

Dùng khi gặp `OUTCOME_UNKNOWN`, `CONVERSATION_CHANGED` hoặc chat bị gián đoạn:

1. Kiểm tra câu trả lời và tác vụ thực tế trong Gemini/IDE trước.
2. Chọn **đúng tài khoản gốc** trong launcher.
3. Mở đúng một tab tại URL hội thoại Gemini đã dừng.
4. Vào **Đoạn chat**, chọn hoặc dán URL, bấm **Đánh dấu nối**.
5. Gửi một yêu cầu **mới** trong đúng chat IDE. Đánh dấu nối không tự gửi lại lượt cũ.

## Khi cần điều tra thêm

Hủy lượt: `npm run native:cancel`. Tra receipt theo request ID: `npm run native -- receipt native_<64_hex_request_id>`.

Với lỗi ledger/SQLite/metadata hoặc owner mismatch: giữ nguyên dữ liệu, dừng thao tác thay đổi và lưu mã lỗi để điều tra. Không xóa receipt, lock hoặc cache để ép gửi lại. Chỉ sao lưu khi các writer đã dừng; giữ nguyên cả bộ SQLite/WAL/SHM nếu còn.

State native nằm tại `%USERPROFILE%\.gemini\antigravity-gemini-web-live\app_data\native-route`. Mỗi account có state riêng. Không đưa cookie, mã ghép nối hoặc owner token vào log chia sẻ.
