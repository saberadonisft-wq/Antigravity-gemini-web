# Gateway OAuth cho Gemini gọi công cụ IDE

Cập nhật 15/10/2026. Đã triển khai và kiểm chứng OAuth + MCP trên loopback bằng SDK chính thức. **Chưa triển khai URL HTTPS public, chưa liên kết custom app Gemini thật, chưa nghiệm thu native tool E2E.** Đường IDE → MCP browser → Gemini → IDE đã PASS riêng.

## Kiểm tra local trước — phạm vi người dùng đã chọn

```powershell
cd D:\Antigravity-gemini-web
npm run build
npm run test:mcp
```

Suite hiện có 25 tests, gồm 10 gateway, 2 client-routing, 3 shared-runtime và 2 native-browser regressions bên cạnh 8 baseline tests. Các bài OAuth tự tạo HTTP loopback, PKCE, consent và task broker trong fixture tạm, rồi dọn state đã tạo. Không cần domain, Google login hoặc cổng public. Kết quả fixture không thay bằng chứng native hoặc Google connector; provider native mới được nghiệm thu riêng tại [native validation](evidence/g4-native-provider-validation.md). Có bài test deadline chờ thực tế khoảng 15s.

Các phần HTTPS/custom app bên dưới là hướng dẫn cho bước sau; người dùng đã chọn **chỉ kiểm tra local trước**, chưa triển khai bước đó.

## Đường chạy

```text
Gemini custom app
  → HTTPS proxy/tunnel trên domain của bạn
  → 127.0.0.1:9235 (gateway OAuth)
  → 127.0.0.1:9234/mcp (host broker riêng)
  → hàng đợi của task
  → agent IDE gọi native tool với approval hiện hành
```

OAuth cấp quyền kết nối. Mỗi tool call còn cần `turn_token` của task đang sống, tool trong inventory và tham số đúng schema. HTTP không có `ide_host_begin`, `ide_host_result` hoặc executor shell riêng. Host-agent pump vẫn dùng agent/model IDE; chưa thay native inference.

## Chuẩn bị và chạy

1. Trong Antigravity IDE, xác nhận `gemini-ide-host` đang Enabled với 4 tools. Giữ IDE mở; không khởi chạy thêm `npm run mcp` trong terminal cùng state directory.
2. Chọn domain HTTPS hoặc URL tunnel ổn định do bạn quản lý. `mcp.example.com` bên dưới **chỉ là placeholder**, không phải endpoint đã được tạo. Proxy/tunnel phải chuyển tới gateway trên cùng máy chạy IDE.
3. Build và chạy trong terminal riêng:

```powershell
cd D:\Antigravity-gemini-web
npm run build
$env:AG_MCP_PUBLIC_URL = "https://mcp.example.com"
npm run mcp:gateway
```

Gateway chỉ bind `127.0.0.1:9235`. Thông báo `listening` và `/health` xác nhận process/cấu hình local; không chứng nhận TLS public hoặc backend IDE E2E. Thiếu URL hợp lệ, state lỗi hoặc trùng owner thì lệnh thoát lỗi.

4. Proxy/tunnel phải giữ public `Host`, đặt `X-Forwarded-Proto: https`, chuyển nguyên path và Authorization tới `http://127.0.0.1:9235`. Không retry POST khi chưa rõ kết quả. Chỉ publish gateway; không publish port 9234, CDP 9223 hoặc app_data.

Có [mẫu Caddyfile](../tools/mcp/Caddyfile.example) để review. Thay cả hai hostname cho khớp `AG_MCP_PUBLIC_URL`. Mẫu cần đường nhận traffic/cấp chứng chỉ thật cho domain đó; chưa cài Caddy, đổi DNS, firewall hoặc NAT trong đợt này. Với tunnel, cấu hình header tương đương. Xem [tài liệu Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

5. Kiểm tra local bằng header mô phỏng TLS proxy; không cấp quyền hoặc gửi tool call:

```powershell
curl.exe --max-time 10 -i -H "Host: mcp.example.com" -H "X-Forwarded-Proto: https" http://127.0.0.1:9235/health
curl.exe --max-time 10 -i -H "Host: mcp.example.com" -H "X-Forwarded-Proto: https" http://127.0.0.1:9235/.well-known/oauth-protected-resource/mcp
```

Sau khi proxy chạy, kiểm tra URL public từ ngoài mạng local:

```powershell
curl.exe --max-time 10 -i https://mcp.example.com/.well-known/oauth-authorization-server
curl.exe --max-time 10 -i https://mcp.example.com/.well-known/oauth-protected-resource/mcp
curl.exe --max-time 10 -i -X POST -H "Content-Type: application/json" -d "{}" https://mcp.example.com/mcp
```

Metadata phải trả đúng issuer/resource public. POST chưa có OAuth phải trả **401**, với `WWW-Authenticate` trỏ protected-resource metadata. Không bỏ kiểm tra chứng chỉ TLS để biến lỗi thành PASS.

## Thêm custom app và cấp quyền

Tài khoản Gemini phải có **Add a custom app**. Quan sát trước đó trên account hiện tại chưa thấy control này; browser MCP hoạt động không chứng minh quyền custom app. Điều kiện Google công bố tại thời điểm kiểm tra: personal account, 18+, ở Mỹ, Keep Activity bật và tiếng Anh. Xem [Google Gemini Help](https://support.google.com/gemini/answer/17209137?hl=en-SB); không giả vùng hoặc thay account settings để vượt điều kiện.

Nếu tài khoản có tính năng, nhập MCP server URL `https://<domain>/mcp`, dùng OAuth. Gateway hỗ trợ DCR tại `/register`, public client `none` và confidential client `client_secret_post`. Ưu tiên DCR nếu UI hỗ trợ. Nếu UI yêu cầu client ID/secret đăng ký trước, cần callback URI thật do Google cung cấp; không đoán callback hoặc dùng credentials giả.

Browser OAuth sẽ mở trang **Cấp quyền kết nối công cụ IDE** trên domain gateway của bạn. Kiểm tra tên client và callback, rồi chạy trên máy gateway, trong terminal thứ hai:

```powershell
cd D:\Antigravity-gemini-web
npm run mcp:gateway:pair
```

Lệnh chỉ in đường dẫn file mã và hạn dùng. Tự mở file bằng editor/Notepad, nhập mã vào trang gateway rồi chọn **Cấp quyền**. Không dán mã vào chat Gemini, chat IDE hoặc log chia sẻ. Mã hết hạn sau 5 phút, chỉ dùng một lần và bị xóa khi dùng thành công. Mã chưa dùng có thể còn trong file sau hết hạn nhưng không còn hiệu lực; chạy lại lệnh để thay mã. **Từ chối** không cấp grant.

OAuth dùng authorization code + PKCE S256, ràng buộc client, callback và exact resource `https://<domain>/mcp`, scope duy nhất `ide.tools`. Access token có hạn 10 phút; refresh token xoay vòng trong grant tối đa 24 giờ. Dùng lại refresh token cũ thu hồi cả grant. `/revoke` thu hồi grant tương ứng. DCR không tự cấp quyền: vẫn cần consent và capability của task.

Sau khi Google kết nối thành công, dùng [prompt host-agent](MCP_HOST_AGENT_PROMPT.md) để nghiệm thu trên fixture với **native tool thật**. Chứng minh đọc file đúng task/workspace trước khi mở thao tác ghi. Giữ nguyên approval của IDE và Google.

## State và dừng thử nghiệm

State mặc định: `%USERPROFILE%\.gemini\antigravity-gemini-web-live\app_data\mcp-gateway`.

| File/trạng thái | Nội dung và vòng đời |
|---|---|
| `gateway.json` | PID, public issuer, loopback bind; `publicReachability=not_verified` là thông tin startup |
| `oauth-clients.json` | Registration, callback và client secret nếu confidential; private file, chưa mã hóa bằng Windows keystore |
| `owner-pairing.json` | Hash mã một lần và hạn dùng |
| `owner-pairing-code.txt` | Mã thô cho chủ máy tự đọc; không commit/chia sẻ |
| Code/access/refresh grants | Chỉ trong RAM; token lookup dùng SHA-256; restart buộc OAuth lại, không replay hành động |

OAuth store không chứa prompt, tool payload/result hoặc capability task. File tạo mode 0600 trên OS hỗ trợ; trên Windows còn phụ thuộc ACL profile, không coi mode POSIX là chứng nhận bảo vệ Windows. Dùng thư mục local do tài khoản hiện hành sở hữu.

Biến tùy chọn: `AG_MCP_GATEWAY_PORT` (9235), `AG_MCP_GATEWAY_STATE_DIR`, `AG_MCP_HOST_STATE_DIR`. Đổi issuer nhưng giữ client store cũ bị từ chối; dùng state directory riêng nếu chủ động đổi domain, rồi đăng ký/cấp quyền lại. Không tự xóa registration cũ.

Dừng proxy/tunnel và Ctrl+C gateway để thu hồi grants trong RAM. Task/action host đã nhận không tự undo hoặc chạy lại; yêu cầu agent IDE gọi `ide_host_abort`, kiểm tra kết quả native trước khi tạo task mới. Không cần xóa browser profile hoặc sửa binary IDE.

## Bằng chứng và giới hạn

`npm run test:mcp`: **20/20 PASS**, gồm 10 gateway và 2 client-routing tests. Có SDK OAuth client thực, DCR, owner consent, PKCE, refresh/revocation, MCP HTTP tới broker, claim-once và deadline với socket/backend bị treo thật. Tests mô phỏng header TLS proxy trên HTTP loopback; tool results là fixture có nhãn. **Chưa chứng nhận public TLS, Google connector hoặc Antigravity native executor.**

[Gateway validation](evidence/g4-mcp-gateway-validation.md), [ADR 0006](adr/0006-mcp-oauth-gateway.md), [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
