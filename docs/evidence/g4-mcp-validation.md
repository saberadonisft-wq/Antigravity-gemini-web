# G4 — MCP implementation và bằng chứng live

Ngày 15/10/2026. Người dùng yêu cầu triển khai MCP và chốt ưu tiên Gemini Web gọi công cụ của đúng task IDE.

## Đã triển khai

- Package `@antigravity-gemini-web/mcp-server`, SDK chính thức `@modelcontextprotocol/sdk` pinned 1.32.1. Workspaces/TS references/build/test đã ghép; npm install audit hiện tại 0 vulnerabilities.
- Browser stdio MCP: status/open/submit/result/cancel. Submission durable trước side effect, request retry không gửi trùng, restart không replay, polling pending không ép browser generation thành completed.
- Host stdio MCP và reverse Streamable HTTP MCP: task inventory/capability/TTL, argument schema, claim-once queue, native host result và final-answer roundtrip. Không có shell/filesystem executor riêng trong broker.
- Workspace `.agents/mcp_config.json` và global registration cho hai servers; IDE load được 9 tools như follow-up bên dưới. Không sửa binary hoặc tạo installer.
- Config workspace đã validate PASS với JSON schema MCP trong bản Antigravity IDE cài trên máy; cả hai entry point build tồn tại. Chưa coi schema validation là bằng chứng IDE đã load hay đã thực thi native tool.

## Kết quả

| Kiểm tra | Kết quả và giới hạn |
|---|---|
| `npm run build` | PASS toàn repo, gồm MCP package |
| `npm run typecheck` / `npm run lint` | PASS |
| `npm test` | 168/168 PASS: contracts 8, browser 22, MCP 20, bridge 4, native 1, runtime 80, launcher 33 |
| MCP unit/protocol suite | 20/20 PASS: 8 baseline, 10 OAuth gateway và 2 client-routing tests. [Gateway snapshot](g4-mcp-gateway-validation.md), [ownership/EOF fix](g4-mcp-client-routing-validation.md) |
| Google live browser qua MCP | PASS 3 lượt plain text, Markdown content và JavaScript code content trên cùng browser session; chỉ synthetic prompts. [Metadata](mcp/google-live.json) không lưu prompt/response/account |
| Google custom apps eligibility probe | NOT_OBSERVED: page `/customize/connectors` loaded, language en, Google apps observed; không Custom apps/MCP field/Add control. [Metadata](mcp/custom-apps.json) |
| Gemini thật → reverse custom MCP | BLOCKED / NOT_TESTED: gateway OAuth đã có code/local tests, chưa deploy HTTPS public; chưa có custom-app setup control trên account |
| Native IDE tool/approval E2E | NOT_TESTED: tests dùng SDK host fixtures, chưa actual Antigravity task execution |
| Native inference replacement | UNRESOLVED: adapter native/model bridge cũ không được bật hoặc đổi trạng thái |

Build/typecheck/lint/test logs tại `.tmp/g4-followup-*.log`; các logs này không được commit. Electron desktop suite đã pass ở đợt G4 trước; không rerun và không dùng số test mới để quảng bá desktop/native acceptance mới.

## Những lỗi thực tế phát hiện trong đợt này

1. Browser vừa open có account signed_in nhưng composer chưa tải: probe chờ readiness có deadline 12s trước khi gửi. Không báo nhầm yêu cầu đăng nhập.
2. SDK v1 stdio không bắt EOF; Windows client có thể kill process trước cleanup, để lại file PID lock. Thay file PID lock bằng kernel ownership và gắn EOF shutdown riêng. Test real child close/reconnect xác nhận owner không bị kẹt.
3. Không suy ra custom-app eligibility từ đăng nhập hoặc tiếng Anh. Đọc setup controls thực tế, giữ trạng thái NOT_OBSERVED thay vì fake connector ready.

Probe Google/browser và custom-app đã cleanup owned processes; kiểm tra sau đó không thấy Chrome process mang profile app còn chạy. Không đưa cookie/credential ra khỏi profile. Không tự thao tác login/MFA, đổi vùng hoặc Activity.

## Phần còn thiếu

User cần account có custom apps được Google cung cấp; chọn domain/tunnel để deploy gateway OAuth đã kiểm chứng local và liên kết app thủ công. [Gateway setup](../MCP_GATEWAY_SETUP.md). Sau đó mới chạy [host agent prompt](../MCP_HOST_AGENT_PROMPT.md) với native tool thật. Host-agent pump vẫn dùng model/agent IDE; không tương đương thay native model hoặc chứng minh tiết kiệm quota.

Không commit/push, không G5. [Setup](../MCP_SETUP.md), [ADR](../adr/0005-mcp-host-task-bridge.md).

## Follow-up đăng ký vào config IDE đang dùng

Người dùng thấy MCP Store không tìm được `gemini-ide-host`; View raw config mở `%USERPROFILE%\.gemini\config\mcp_config.json` trống. Kiểm tra file thực tế 0 bytes. Hai server local chưa được publish trong Store; workspace config riêng chưa đủ để xác nhận bản IDE này đã nạp.

Đã đăng ký hai entries vào đúng file global, giữ backup byte-for-byte cùng thư mục, dùng Node executable tuyệt đối. Config mới validate PASS với schema trong IDE cài trên máy. Cả hai process MCP thật qua SDK connect/discovery PASS: host 4 tools, browser 5 tools. Không gửi prompt trong lần kiểm tra đăng ký. Đây chưa phải bằng chứng IDE đã Refresh/load hoặc Gemini custom connector đã kết nối.

`npm run mcp:register` có thể chạy lại và giữ config không đổi; xung đột tên server hoặc JSONC được từ chối thay vì ghi đè. User cần Manage MCP Servers → Refresh, không search Store. [Hướng dẫn cập nhật](../MCP_SETUP.md).

## Sau reset và cài lại IDE — actual IDE discovery PASS

Lần reset để cài lại IDE đã gỡ global bridge entries và tắt hai entries workspace. Khi user mở bản IDE mới, global config có `mcpServers: {}` và workspace vẫn disabled nên Manage MCP Servers trống.

Đã bật lại workspace, chạy registration vào đúng global config, validate bằng schema của bản IDE mới tại `%LOCALAPPDATA%\Programs\Antigravity IDE`, sau đó bấm Refresh qua Computer Use. Quan sát UI thật: **9 tools**, `gemini-ide-host 4/4`, `gemini-web-browser 5/5`; đã chọn từng server và thấy Enabled cùng tên tools. PID Language Server 22968 là parent của hai Node MCP processes 14744 và 19008 tại thời điểm kiểm tra.

Không gửi prompt qua agent, không thao tác login/approval và không chạy tool native trong lần xác nhận này. Native host tool E2E và Gemini reverse custom connector vẫn NOT_TESTED. Hai MCP processes được để chạy dưới quyền sở hữu của IDE để user test; không chạy thêm CLI probe giành cùng profile.

## IDE agent → browser MCP → Google → IDE agent — PASS

User đã chạy `gemini_open_browser`, chờ `gemini_status` ready/signed_in, rồi submit request `req_20261015_mcp_ok_9f2a7b1c`. Tool trace trả completed, text `MCP_OK`, completedAt `2026-10-15T05:36:36.388Z`.

Đối chiếu độc lập sau báo cáo: durable MCP receipt của request có phase terminal; browser hiện ready/signed_in; đọc DOM qua CDP observer chỉ đọc thấy last response đúng `MCP_OK`. Observer không sở hữu browser, chỉ đóng kết nối riêng sau kiểm tra, không gửi thêm prompt hoặc chạy thêm MCP writer. [Metadata](mcp/ide-browser-roundtrip.json).

Đây là actual IDE-agent-mediated browser MCP roundtrip, vượt mức chỉ discovery/protocol fixture. Chưa chứng minh Gemini custom connector gọi tool của host, native read/patch/test/approval loop hoặc thay thế model native. Không nâng các gate đó thành PASS.
