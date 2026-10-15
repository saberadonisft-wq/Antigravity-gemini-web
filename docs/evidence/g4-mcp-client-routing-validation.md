# G4 — Sửa MCP ownership/EOF khi mở cả agy và Antigravity IDE

**Follow-up cùng ngày:** báo cáo này là snapshot trước shared runtime. Client hợp lệ hiện chia sẻ một owner; xem [ADR 0007](../adr/0007-shared-mcp-runtime.md). Native chat/read-file acceptance mới và số tests hiện tại được ghi tại [native provider validation](g4-native-provider-validation.md); không diễn giải lại các kết quả lịch sử dưới đây thành nghiệm thu provider mới.

Ngày 15/10/2026. User gửi ảnh hai MCP báo `owned by another process` và `initialize ... EOF` trong Antigravity IDE.

## Nguyên nhân thực tế

Hai bridge Node đang chạy dưới `agy.exe` của VS Code: host PID 12748, browser PID 22928, parent 10744, tạo khoảng 14:31 giờ Việt Nam. Antigravity IDE mở sau, cũng đọc hai entries trong `%USERPROFILE%\.gemini\config\mcp_config.json`, nên không giành được host state/browser profile. Đây là owner đang sống; kernel lock vẫn hoạt động đúng, không phải file lock rác.

Tại thời điểm khởi động lại: host task receipts chưa có file, browser receipts có 5 records đều terminal, CDP 9223 không listen. Đã đối chiếu PID, parent, executable, entry point và creation time trước khi dừng đúng hai Node bridges. Không dừng agy, VS Code, IDE, browser cá nhân hoặc task khác.

## Bản sửa

- `client-filter.ts` đọc tên executable của tối đa 16 ancestors trên Windows bằng CIM có timeout 3s; không đọc/log command line. Native ancestor `Antigravity IDE.exe` được ưu tiên nếu có helper `agy.exe` ở giữa.
- Workspace/global entries đặt `AG_MCP_TARGET_CLIENT=antigravity_ide`. agy trong VS Code nhận một stdio server hợp lệ với **0 tools**, instructions nêu rõ bị lọc theo client; không tạo receipts/profile hoặc giành ownership. Native IDE nhận đủ tools như trước.
- Nếu không chứng minh được ancestry cho policy IDE-only, server cũng không mở tài nguyên. Policy `any` cho phép chọn host khác một cách tường minh; `disabled` trả 0 tools. CLI không cấu hình policy vẫn mặc định `any` để giữ các local protocol probes hoạt động.
- Client routing là lựa chọn ứng dụng sử dụng bridge, **không phải authentication boundary**. Kernel ownership, browser idempotency và task authority giữ nguyên. Vẫn chỉ một owner trên mỗi state/profile; chưa hỗ trợ nhiều IDE độc lập đồng thời dùng cùng profile.
- Registration tự nâng cấp duy nhất entry cũ khớp chính xác do checkout đã cài, bằng cách thêm client policy; cấu hình khác vẫn bị từ chối ghi đè. Global config được backup trước khi ghi; chạy lại registration báo `changed=false`.

## Xác nhận trực tiếp trong IDE

Đã mở **Settings → Customizations → Installed MCP Servers → Refresh** bằng Computer Use. Sau nạp lại, UI hiển thị:

| Server | Quan sát |
|---|---|
| `gemini-ide-host` | **4 tools enabled**, toggle Enabled, không còn ownership/EOF error |
| `gemini-web-browser` | **5 tools enabled**, toggle Enabled, không còn ownership/EOF error |

Hai Node mới PID 24200/18500 là con của Language Server 24632 thuộc Antigravity IDE. Không gửi chat, gọi native tools hoặc gửi prompt Google trong lần khôi phục. Profile đăng nhập được giữ nguyên; account readiness chưa kiểm tra lại bằng browser trong lượt này. Full agy UI reload không được tự thao tác; nhánh bị lọc được kiểm chứng bằng tests.

## Kiểm thử

| Kiểm tra | Kết quả |
|---|---|
| `npm run build` | PASS |
| `npm run typecheck` / `npm run lint` | PASS |
| `npm test` | **168/168 PASS**, 0 fail/skip: contracts 8, browser 22, MCP 20, bridge 4, native 1, runtime 80, launcher 33 |
| MCP suite | **20/20 PASS**: 8 baseline, 10 OAuth gateway, 2 client-routing tests mới |
| Client routing regression | agy/VS Code bị loại, native được chọn cả qua helper agy, `any` override, policy lỗi bị từ chối |
| Real stdio regression | Cả hai entry point initialize/listTools → 0 tools cho client bị lọc, không stderr ownership error, không tạo profile/state; EOF đóng sạch |
| Registration | Migration có backup; chạy lại không ghi đổi config |

Metadata và source hashes: [mcp/client-routing.json](mcp/client-routing.json). Root logs `.tmp/g4-followup-*.log`. Lỗi gián đoạn Chrome cleanup từng quan sát trong đợt gateway trước vẫn được giữ tại [báo cáo gateway](g4-mcp-gateway-validation.md); lượt hiện tại pass không chứng nhận “0 flaky”.

Phạm vi vẫn local theo lựa chọn user. Public HTTPS, Google reverse connector, native tool E2E và thay native model chưa được nâng gate.
