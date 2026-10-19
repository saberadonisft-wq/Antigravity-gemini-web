# Unicode streaming và giữ tab lỗi — revision 10

Ngày 16/10/2026. Sửa sau lỗi `Unknown: Agent execution terminated due to error` trong chat native.

## Bằng chứng sự cố

Log isolated IDE `logs/20261016T101815/ls-main.log` lúc 10:22:51 báo `stream_handler.go:101`: `proto: syntax error (line 1:82): invalid escape code "-\\udbf" in string`; tiếp theo executor kết thúc. Đây là lỗi parser Unicode ở IDE, không phải bằng chứng hết quota hay context quá dài. Không lưu raw prompt/credential trong báo cáo.

Health proxy revision 9: lượt cuối có firstTextMs=36288, elapsedMs=36343, code=CANCELLED; IDE đóng stream ngay sau khi nhận text. Bộ đọc partial trước đây chỉ bỏ high surrogate ở cuối, vẫn có thể chuyển surrogate đơn lẻ ở giữa hoặc low surrogate đơn lẻ. JSON.parse của JavaScript chấp nhận chúng, trong khi protobuf JSON của IDE từ chối. Đường lỗi này đã tái hiện bằng fixture; không thu lại raw SSE của lượt sự cố.

Tab task trước đây luôn bị đóng trong cleanup khi generation bị ngắt hoặc phản hồi bị từ chối. Đây là tab bridge sở hữu; không có bằng chứng cửa sổ bị crash hoặc tài khoản mất đăng nhập.

## Bản vá

- Native runtime **10** chỉ stream prefix Unicode hoàn chỉnh đến trước surrogate không hợp lệ đầu tiên, kể cả lỗi nằm giữa chuỗi. Các snapshot sau có thể hoàn thiện ký tự mà không lặp/mất text.
- Phản hồi cuối được kiểm tra cả text, tên tool, key/value trong args. Unicode không hợp lệ trả `INVALID_MODEL_UNICODE` qua terminal an toàn; không sửa âm thầm nội dung hoặc tham số tool.
- Browser runtime fingerprint **8**: lease có thể retire mà giữ tab đã dừng cho người dùng xem. Lease cũ không thể resume hoặc đóng lại tab đã preserve. Bridge bỏ revision của phiên lỗi. Nếu Stop/chuyển trạng thái idle chưa xác minh được, fallback đóng đúng owned tab để ngăn generation chạy ngầm.
- Native báo release với `preserve_tab` khi lỗi parse/stream. Không tự gửi lại prompt, không thay model 4 Argon / Low.

## Kiểm chứng

`npm run build`, `npm run typecheck`, `npm run lint`, `npm test`: **PASS**, **222/222 tests**, không fail/skip/cancelled. Native 37, MCP 31; các gói còn lại giữ số lượng cũ. Thêm HTTP Unicode streaming repair, terminal invalid Unicode/args, MCP preserve + unsafe fallback, retire successful lease sau parse failure. Mở rộng real-CDP fixture để chứng minh preserved tab vẫn tồn tại, lease cũ không dùng được, active generation không được preserve.

Không gửi live Gemini prompt để kiểm tra. UI IDE acceptance revision 10 chưa thực hiện. Khi chuẩn bị reload, health báo runtime 9 đang có active=1 (một lượt IDE mới), nên chưa dừng/thay tiến trình đó. Source và dist đã build bản 10; browser owner cũ cần Refresh/restart các MCP clients để nạp fingerprint 8.

## Nạp bản sửa

Khi lượt hiện tại kết thúc (hoặc người dùng chủ động Cancel), chạy `npm run native:stop`. Đóng các cửa sổ IDE/client đang dùng browser MCP cũ để runtime chung kết thúc, rồi chạy `npm run native:launch` và mở lại IDE nếu cần. `npm run native:status` phải báo runtimeRevision=10. Không force-kill Chrome/IDE hay xóa profile. Phiên bị lỗi không được replay tự động; tạo yêu cầu mới khi muốn thử tiếp.
