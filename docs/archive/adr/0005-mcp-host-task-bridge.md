# ADR 0005 — MCP bridge cho Gemini Web và công cụ của task

Ngày 15/10/2026. Trạng thái: local implementation/protocol fixtures PASS; Gemini remote connector và native host E2E BLOCKED/NOT_TESTED.

Người dùng chọn Gemini Web gọi công cụ của tác vụ IDE. Tách hai hướng rõ ràng: browser MCP gửi/nhận prompt; reverse MCP cung cấp inventory và queue về host task. Browser MCP một mình không hoàn thành mục tiêu native.

- `HostTurnBroker` giữ một task active, workspace label, inventory thật do host cung cấp, JSON-schema argument validation, random capability, TTL, giới hạn 32 calls. Capability cũ/sai, tool ngoài inventory và argument sai schema bị từ chối.
- Hai MCP servers riêng: host qua private stdio có quyền begin/claim/result/abort; web qua loopback HTTP có inventory/call/result/complete. Web không có methods giả host result.
- HTTP dùng bearer riêng, kiểm Host/Origin, body cap 128 KiB, request/header deadlines và connection bound. Chưa cung cấp OAuth/public deployment; không quảng bá local bearer backend là Gemini-ready remote app.
- Native side effect do host-agent pump thực thi bằng tools và approvals của task. Broker không chạy shell hay tự dựng executor. Workspace/path/approval enforcement cuối cùng vẫn thuộc host. Native model provider chưa thay thế.
- Call ID gắn canonical payload hash, không enqueue hai lần. Action đã delivered chỉ trả awaiting_result; không phát lại. Kết quả terminal và final answer không overwrite.
- Task IDs được reserve bằng ledger fsync/atomic rename trước khi cấp capability; IDs đã dùng sau restart trả OUTCOME_UNKNOWN. Ledger sai/hỏng hoặc ghi thất bại chặn tạo authority. Không khôi phục payload hay token để auto-replay.
- Browser receipts ghi hash, không prompt/result. Một writer/kernel lock theo profile; host journal có kernel lock theo state dir. Kernel giải phóng lock khi process bị kill trên Windows. Stdio EOF được xử lý riêng vì SDK v1 không tự gắn end listener; shutdown fence broker và cleanup browser trước khi SDK client force-kill.
- Không dùng OpenAI tunnel như một dependency mặc định cho Gemini. Cần kiểm account custom-app eligibility và deployment HTTPS/OAuth tương thích riêng.

Đã thấy account signed-in và 3 browser MCP live turns. Connected Apps thực tế bằng tiếng Anh chưa thấy Custom apps hoặc Add a custom app. Giữ NOT_OBSERVED; không tự đổi vùng/Activity hay kết luận account không thể được cấp tính năng trong tương lai.

[Hướng dẫn](../guides/MCP_SETUP.md), [validation](../../evidence/g4-mcp-validation.md). Chưa G5.
