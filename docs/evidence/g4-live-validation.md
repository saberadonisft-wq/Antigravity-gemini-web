# G4 — Live acceptance status

Cập nhật 15/10/2026. **G4-A launcher/control/fixture VERIFIED** trong [scope được đo](g4-acceptance-validation.md). **Native G4-B BLOCKED / NOT_TESTED**. Đợt MCP sau đó đã kiểm chứng 3 browser turns trên Google thật; reverse custom connector và native tool E2E chưa thông. [MCP validation mới](g4-mcp-validation.md).

| Gate | Bằng chứng và giới hạn |
|---|---|
| Native launch hook | Isolated IDE/shim/Language Server theo evidence G2 trước, không rerun ở đợt này |
| Native inference | UNRESOLVED/NOT_TESTED; standalone no port, rpc_attempted=false. Missing handshake chỉ là giả thuyết |
| Browser | 22 package tests + 1 owned Chrome runtime fixture crash/reconnect/no replay; chưa Google account |
| Google session | Đợt MCP sau: signed_in, 3 browser turns PASS trên profile launcher. Desktop smoke vẫn là fixture, không được dùng thay bằng chứng Google |
| Native host tools | Chưa native read/patch/test PASS+FAIL/approvals; không trace E2E |

Launcher live dùng %USERPROFILE%\.gemini\antigravity-gemini-web-live\app_data\browser_profile, port 9223; profile G2 cũ .gemini\gemini_web_probe_profile, port 9222. Không copy cookie/credential hoặc mặc định dùng phiên G2 cho launcher. Đăng nhập thủ công trên app-owned browser khi tiến hành live acceptance sau này.

Không kết luận IDE đóng kín hoàn toàn hoặc MITM bắt buộc từ static flags/no-port. Native capabilities/install/model/host tools remain gated. CDP bringToFront test không chứng minh native inference, Google login hay OS foreground. Dừng G4, không G5.

