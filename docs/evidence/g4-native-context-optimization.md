# Native context optimization — revisions 9 and 14

Ngày 16/10/2026. Phạm vi local/fixture; **chưa nghiệm thu giao thức patch mới hoặc schema description compaction trên Gemini Web thật**. Bổ sung revision 14 chạy offline, không gọi model.

## Thay đổi

Giữ cùng owned conversation khi IDE sửa history/system/tools/config. Gửi append hoặc patch có revision thay cho việc tạo tab mới và lặp toàn bộ context. Bootstrap mang hướng dẫn một lần, lượt tiếp theo dùng header ngắn. Trường hợp patch lớn hơn snapshot dùng replace tường minh trong cùng tab. Revision 14 giới hạn mô tả tool/schema dài trên wire; AJV vẫn dùng schema đầy đủ. Snapshot đầy đủ vẫn ở local; không cắt ngầm chỉ thị hay lịch sử. [ADR 0010](../adr/0010-native-context-updates.md).

Nonce và tool authority lấy từ request hiện tại. Reservation riêng chống callback trễ kể cả hai lượt cùng context hash. Kiểm tra cap trước browser và giải phóng reservation chưa gửi khi lỗi. Diagnostics thêm contextMode/contextReason/patchOperations/savedPromptChars, không ghi prompt thô.

## Đo fixture

Chạy sau build: `node tools/probes/native-context-offline.mjs`. Script không có browser/network/model call. `--write-evidence` cập nhật [metadata tổng hợp](mcp/native-context-offline.json).

| Lượt tổng hợp | Mode | Gửi full nếu không tối ưu | Thực gửi |
| --- | --- | ---: | ---: |
| Bootstrap | full | 65.095 | 65.173 |
| Kết quả đọc file | append | 66.321 | 1.903 |
| Follow-up | append | 66.443 | 799 |
| Sửa chỉ dẫn/history, thu hồi tool | patch | 66.290 | 1.125 |
| IDE cập nhật lại history | patch | 65.123 | 913 |
| Tổng | | 329.272 | 69.913 |

Giảm **78,77%** tổng ký tự gửi trong fixture; bootstrap tăng 78 ký tự để mang revision. Các tổng là 329.272 ký tự đầy đủ và 69.913 ký tự gửi. Đơn vị là JavaScript UTF-16 string length, **không phải token hoặc quota Google**. Bộ nhận local khôi phục chính xác snapshot IDE ở cả năm lượt. Không dùng số này để cam kết mức giảm quota thực tế.

## Kiểm tra

- Build hoàn tất; typecheck/lint toàn workspace không báo lỗi.
- `npm test`: **218/218 PASS**, 0 fail/cancelled/skipped: contracts 8, browser 29, MCP 29, model-bridge 4, native 35, runtime 80, launcher 33. Log tại `.tmp/g4-followup-{build,test,typecheck,lint}.log` (local, không commit).
- Native có thêm 7 tests: Unicode/repeated text/JSON keys/deletion, invalid patch/large array, 200 deterministic edit cases, stale reservations, explicit replace, cap/unsent cleanup, HTTP multi-turn updates và revoked-tool rejection.
- HTTP fixture dùng loopback/fake backend: cùng lease, bootstrap → append → patch, khôi phục context chính xác; `view_file` đã thu hồi bị TOOL_DENIED; retry không gửi lần hai.
- Giữ các regression nonce/schema, streaming, cancellation, dedup, caller isolation và browser checkpoint từ trước.

Không chạy lại desktop smoke vì không sửa Electron/UI. Các acceptance live revision 7/8 là bằng chứng lịch sử, không thay nghiệm thu patch revision 9. Lý do cụ thể của mọi lần full reset ở phiên thật trước đó chưa được đo; đổi caller/task scope vẫn chủ động tạo context riêng. Không commit/push, không G5.
