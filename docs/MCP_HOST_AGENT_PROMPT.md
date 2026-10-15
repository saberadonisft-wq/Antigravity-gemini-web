# Prompt cho agent Antigravity — chỉ dùng sau khi custom MCP Gemini đã kết nối

Điều kiện: IDE đã load `gemini-ide-host`; Gemini Web đã có custom connector tới endpoint MCP chiều web qua HTTPS/OAuth gateway. Gateway đã có code và local tests; chưa deploy HTTPS public, tài khoản khảo sát chưa thấy nút custom app. Hoàn tất [gateway setup](MCP_GATEWAY_SETUP.md) trước; không thực hiện prompt này bằng cách giả lập phần Gemini.

```text
Thực hiện một tác vụ kiểm chứng MCP, dùng công cụ native của chính tác vụ IDE này.

1. Xác nhận user yêu cầu và workspace hiện tại. Chỉ cho phép công cụ đọc một file fixture do user chọn trước. Lấy tên và JSON schema thật của công cụ từ inventory hiện hành, không tự đoán tên hay đăng ký run_shell.
2. Dùng ide_host_begin tạo task_id mới, bind đúng workspace_id và inventory công cụ đó. Capability này chỉ có hiệu lực trong TTL đã trả về.
3. Chuẩn bị prompt cho phiên Gemini Web đã nối custom MCP: gồm turn_token, yêu cầu dùng ide_tool_inventory, ide_tool_call với call_id mới để đọc file fixture, ide_tool_result để nhận kết quả thật, cuối cùng ide_turn_complete để gửi câu trả lời. Chỉ chia sẻ capability cho phiên Gemini của tác vụ này, không ghi vào repo/log.
4. Trong khi Gemini xử lý, gọi ide_host_next. Nếu status=waiting, chờ một khoảng có giới hạn rồi gọi lại. Không tự thêm công cụ hoặc tự diễn giải waiting thành thành công.
5. Chỉ khi status=action: kiểm tra workspace, tên tool, tham số và quyền user. Gọi đúng native tool của IDE với approval bình thường. Không tự chạy tool trong MCP server và không bypass approval. Nếu user từ chối hoặc tool thất bại, báo kết quả lỗi thật.
6. Gọi ide_host_result với đúng task_id/call_id và kết quả thật. Nếu status=awaiting_result, action đã được nhận trước đó: tuyệt đối không thực thi lại. Nếu mất kết quả native, dừng và báo outcome unknown.
7. Chờ Gemini lấy kết quả và gọi ide_turn_complete. Khi ide_host_next trả completed, hiện finalText tại chat IDE.
8. Nếu timeout/disconnect/cancel, gọi ide_host_abort; không replay các thao tác chưa rõ kết quả. Không báo native model đã được thay thế: đây là MCP host-agent pump, vẫn sử dụng agent IDE để thực thi và duy trì approval.

Bằng chứng phải phân biệt: Gemini gọi connector thật hay MCP test client; native tool thật hay fixture. Chỉ ghi native E2E PASS nếu có cả Gemini thật + đúng task/workspace + tool native thật + final answer trở lại task đó.
```
