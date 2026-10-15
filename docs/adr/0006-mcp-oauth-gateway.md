# ADR 0006 — OAuth gateway riêng cho reverse host MCP

Ngày 15/10/2026. Đã triển khai/kiểm chứng local; public/Google acceptance chưa thực hiện.

## Bối cảnh

Host và browser MCP đã nạp trong Antigravity; browser roundtrip thật PASS. Reverse broker dùng bearer loopback, chưa đủ cho remote custom MCP app với OAuth. Native inference replacement vẫn unverified. Không đưa bearer nội bộ lên Internet hoặc thay executor IDE bằng shell tự chạy.

## Quyết định

- Process riêng dùng Express 5.3.0 và official MCP SDK 1.32.1 auth router. Issuer HTTPS origin root cấu hình tường minh; bind loopback 9235 sau TLS proxy/tunnel được chọn riêng. Không suy issuer từ request headers.
- DCR, authorization code, PKCE S256, protected-resource metadata, refresh rotation và revocation. Scope `ide.tools`, exact resource binding; client auth `none`/`client_secret_post` đúng khả năng SDK đang dùng.
- Consent dùng browser CSRF cookie và owner code 256-bit, một lần, TTL 5 phút, tạo qua CLI local. Không tự approve OAuth hoặc đăng nhập Google.
- Chỉ forward `/mcp` tới descriptor host loopback. Thay OAuth header bằng bearer riêng; không follow redirects hoặc retry tool POST. Web không có host-side tools.
- Broker giữ task capability, inventory/schema, TTL, call ID và claim-once. Agent IDE thực thi native tool với approval hiện hành. Gateway không có executor filesystem/shell.
- Registrations ghi atomic/fsync trong private store; CLI giữ kernel single owner; lỗi persistence fail-closed. Code/access/refresh chỉ RAM và hash token lookup. Restart buộc reauthorize; chấp nhận mất phiên để không lưu OAuth bearer lâu dài trên đĩa.
- Giới hạn 64 clients và client store 128 KiB (đồng nhất read/write), 64 pending consent/codes, 128 families, 2048 entries mỗi access/refresh map. SDK rate limits theo peer loopback, phù hợp thử nghiệm một chủ máy; chưa thiết kế nhiều tenant.
- Có size caps, HTTP deadlines, concurrency/connection caps và bounded CLI shutdown. Không log credential, prompt hoặc tool payload.

## Giới hạn

Cần public HTTPS origin và account Google có Custom apps. Chưa deploy DNS/tunnel/firewall hoặc test public TLS/proxy/account controls. Client secret confidential nằm trong private file, chưa mã hóa OS-keystore. Mẫu Caddy chưa chạy trên domain thật.

User đã chọn **chỉ kiểm tra local trước** sau khi gateway local có kết quả; deployment HTTPS/tunnel để bước sau.

Disconnect không chứng minh tool chưa chạy. Không auto replay; host kiểm tra outcome và abort khi cần. Dừng gateway mất OAuth grants nhưng không undo hành động host. G4-B/native replacement và read/patch/test E2E vẫn chưa PASS.

[Validation](../evidence/g4-mcp-gateway-validation.md), [setup](../MCP_GATEWAY_SETUP.md), [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [SDK server](https://ts.sdk.modelcontextprotocol.io/server).
