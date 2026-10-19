# MCP cho Gemini Web và tác vụ IDE

Source 39 / browser worker 25 thêm `gemini_inspect_import`, chỉ quan sát controls trên tab import đang mở trong đúng profile, không mở/navigate tab hoặc truyền dữ liệu. Browser có **8 tools**, host có **4 tools**; 12 là inventory source mới, chưa phải discovery trên IDE thật. Giữ policy semi-space Node mặc định tắt, có fingerprint và xác minh trên shared owner. [Cấu hình](NATIVE_NODE_MEMORY.md), [import và giới hạn](NATIVE_CHAT_IMPORT.md). Các số discovery và fingerprint ở các mốc cũ bên dưới là bằng chứng lịch sử.

Cập nhật 18/10/2026 trước P7c: source khi đó có browser 7 + host 4 = 11 tools, gồm `gemini_release_conversation` và tra cứu metadata `gemini_receipt`. Người dùng chọn ưu tiên Gemini Web gọi công cụ của đúng tác vụ IDE như repo tham khảo. Google custom connector chưa nghiệm thu. Provider native đã có bằng chứng chat và view_file thật ở các revision trước; xem [NATIVE_SETUP](NATIVE_SETUP.md) để biết giới hạn nghiệm thu hiện tại. Các số 5/5, 9 tools bên dưới là snapshot discovery cũ. Worker fingerprint 22 bổ sung capture/restore model tạm cho context 3.8; status công bố `temporaryModelSelectionSupported`, `modelRestorePending` và chẩn đoán xác minh lưu lượng Google. Đây là phần tiếp tục G4, chưa G5.

Phạm vi gateway: **chỉ kiểm tra local trước**. Sau build, chạy `npm run test:mcp` để kiểm tra gateway, shared runtime, receipts/ledger, context model và retained/progress/cancellation; chưa cần domain/tunnel hoặc Google custom app. Số test của các báo cáo cũ là snapshot tại revision tương ứng. [Hướng dẫn local](MCP_GATEWAY_SETUP.md), [runtime dùng chung](adr/0007-shared-mcp-runtime.md).

## Hai server và ranh giới

```text
Agent Antigravity của tác vụ
  ├─ private stdio → gemini-ide-host
  │    ide_host_begin / ide_host_next / ide_host_result / ide_host_abort
  │                         ↕ broker gắn task + workspace + inventory + TTL
  │                   MCP HTTP 127.0.0.1:9234/mcp
  │                         ↕ OAuth gateway 127.0.0.1:9235 (chưa deploy HTTPS public)
  │                   Gemini Web custom MCP app
  │    ide_tool_inventory / ide_tool_call / ide_tool_result / ide_turn_complete
  └─ private stdio → gemini-web-browser
       gemini_status / gemini_open_browser / gemini_submit / gemini_result / gemini_cancel
       gemini_release_conversation
```

MCP HTTP chỉ nhận tool phía web; không cho phía web giả kết quả host hoặc tạo task. Công cụ native vẫn do agent IDE gọi với cơ chế approval hiện hành. Broker không tự đọc file, patch file hay chạy shell. Vì chưa có API gọi trực tiếp executor của task từ bên ngoài, adapter hiện là **host-agent pump**: agent IDE nhận yêu cầu từ broker rồi thực thi tool thật. Nó vẫn cần agent/model của IDE, chưa thay model native và chưa có cơ sở tuyên bố tiết kiệm quota IDE.

`gemini-web-browser` đã gửi/nhận ba lượt qua tài khoản Gemini thật. Đây là đường hỗ trợ gửi prompt, không phải bằng chứng Gemini đã gọi native tools qua connector chiều ngược.

Đã kiểm chứng thêm từ agent IDE thực tế: `gemini_submit` → `gemini_result` trả completed với `MCP_OK`. Receipt và DOM được đối chiếu độc lập, không gửi lại request. [Trace nghiệm thu](evidence/mcp/ide-browser-roundtrip.json). Phần browser roundtrip đã thông; bước tiếp theo là reverse custom connector và host-tool loop, không cần lặp lại browser smoke để chứng nhận phần còn thiếu.

## Bật MCP trong workspace

Các file build hiện đã có. Khi lấy source từ đầu:

```powershell
cd D:\Antigravity-gemini-web
npm ci
npm run build
```

Đã tạo `.agents/mcp_config.json` cho workspace này. Sau khi người dùng mở View raw config và thấy IDE đang dùng file global trống, đã đăng ký hai entries vào `%USERPROFILE%\.gemini\config\mcp_config.json` ngày 15/10. File cũ được backup cùng thư mục; command global dùng đường dẫn tuyệt đối `C:\Program Files\nodejs\node.exe` để không phụ thuộc PATH của IDE. Không sửa binary.

Trong **Antigravity IDE**, mở **MCP Servers → Manage MCP Servers → Refresh** và kiểm tra `gemini-ide-host` cùng `gemini-web-browser`. Đây là custom local servers, chưa publish trong **MCP Store**, nên tìm tên trong ô search của Store sẽ không có kết quả. Nếu editor đang mở file config trống cũ, đóng/mở lại tab để đọc bản đã lưu trên đĩa; không ghi đè lại bản trống. Nếu Refresh chưa nạp, đóng/mở lại IDE.

Sau đợt reset/cài lại IDE ngày 15/10, hai entries workspace từng được đặt `disabled: true` và global bridge entries đã gỡ. Đã bật lại workspace, đăng ký global và Refresh trực tiếp trong IDE mới. UI hiện **9 tools**: `gemini-ide-host` **4/4**, `gemini-web-browser` **5/5**, cả hai Enabled. Language Server của IDE đã khởi chạy hai Node server. Đây là bằng chứng IDE discovery/load; chưa xác nhận native executor roundtrip hoặc Gemini custom connector.

Lệnh đăng ký cho checkout/máy khác:

```powershell
npm run mcp:register
```

Script lấy đường dẫn Node hiện hành và entry points build từ checkout, giữ các server khác, backup cấu hình cũ và kiểm tra thay đổi trước khi ghi. Chạy lại cùng cấu hình không ghi file. JSONC hoặc entries trùng tên nhưng khác cấu hình bị từ chối để người dùng review, không ghi đè. Đường dẫn trong global config gắn với checkout; chạy lại/review config khi chuyển project hoặc Node.

Sau refresh có thể yêu cầu agent:

```text
Liệt kê tools của gemini-ide-host và gemini-web-browser.
Gọi gemini_status. Chỉ báo trạng thái quan sát được; không tạo task hay gửi prompt.
```

Server không mở Chrome trong lúc khởi động hoặc khi gọi status. Gọi `gemini_open_browser` khi muốn mở browser. Profile đúng của launcher: `%USERPROFILE%\.gemini\antigravity-gemini-web-live\app_data\browser_profile`, CDP port `9223`. MCP clients và CLI dùng shared stdio có thể chia sẻ cùng runtime owner. Probe tự khởi tạo driver trực tiếp vẫn cần quyền sở hữu profile độc lập; không chạy driver thứ hai vào profile đang dùng hoặc sao chép cookie.

Native provider runtime revision 4 chủ động gọi `gemini_open_browser` khi launch hoặc trước generation nếu browser chưa ready. Đây là hành động của native provider; `gemini_status` vẫn không tự mở browser. [Bằng chứng cold startup và phản hồi thật](evidence/g4-native-autostart-validation.md).

### Lỗi `owned by another process` / `initialize ... EOF`

Đã xác nhận agy trong VS Code và Antigravity IDE cùng đọc global MCP config. Nếu agy khởi chạy trước, nó giữ cả host state và browser profile, khiến IDE báo lỗi như ảnh. Global/workspace entries hiện đặt `AG_MCP_TARGET_CLIENT=antigravity_ide`, ưu tiên đúng IDE theo mục tiêu dự án. Sau sửa và Refresh thực tế, UI đã có **host 4 tools + browser 5 tools** Enabled.

agy/VS Code đọc cùng cấu hình nhận **0 tools** với instructions giải thích policy. Policy `any` cho phép client khác một cách tường minh; client hợp lệ chia sẻ một runtime owner theo config fingerprint, không tạo hai chủ sở hữu profile. Host-task authority vẫn gắn với connection tạo task. Windows parent-process inspection không xác minh được client cũng trả 0 tools. [ADR hiện tại](adr/0007-shared-mcp-runtime.md); [báo cáo routing cũ](evidence/g4-mcp-client-routing-validation.md) là snapshot trước shared runtime.

Lệnh chẩn đoán độc lập:

```powershell
npm run mcp:status
npm run test:mcp
npm run mcp:live
npm run mcp:custom-apps
```

`mcp:live` gửi ba prompt tổng hợp không chứa source code tới Google. Nó chỉ xác nhận browser route, không xác nhận native tools. `mcp:custom-apps` chỉ mở một tab Connected Apps trong profile riêng, đọc dấu hiệu UI và đóng tab; không thay language, Activity, vùng hoặc quyền tài khoản. Không chạy `npm run mcp` trong terminal để chờ cửa sổ: đây là server stdio, client IDE phải khởi chạy và giao tiếp với nó.

## Điều kiện còn thiếu cho custom connector thật

Probe đăng nhập thật ngày 15/10 đã được redirect từ `/apps` sang `/customize/connectors`, giao diện `en`, nội dung Connected Apps đã tải. Không thấy Custom apps, ô MCP URL hoặc nút Add a custom app: **NOT_OBSERVED**, không kết luận chỉ từ đó rằng tài khoản bị khóa vùng vĩnh viễn. Xem [metadata](evidence/mcp/custom-apps.json).

Theo [Google Gemini Help](https://support.google.com/gemini/answer/17209137?hl=en-SB), custom apps hiện yêu cầu tài khoản cá nhân, từ 18 tuổi, ở Mỹ, Keep Activity bật và chỉ có tiếng Anh. Không thay các thiết lập hoặc giả vùng để vượt điều kiện. Cần tài khoản được Google cấp tính năng và có mục Add a custom app để tiếp tục Google connector acceptance.

Backend HTTP chỉ bind loopback và dùng bearer riêng. **Đã bổ sung gateway OAuth** tại `127.0.0.1:9235`, có DCR, owner consent bằng mã một lần, PKCE S256, resource binding, refresh rotation và revocation. SDK OAuth/MCP fixture cùng CLI đã kiểm chứng; **chưa triển khai URL HTTPS public hoặc liên kết Google custom app**. Không dán localhost vào Gemini hoặc đưa raw backend lên Internet. [Hướng dẫn gateway/HTTPS](MCP_GATEWAY_SETUP.md), [bằng chứng](evidence/g4-mcp-gateway-validation.md). Không tự tạo tài khoản, đổi DNS/firewall hoặc cấp quyền external app.

Descriptor local tại `%USERPROFILE%\.gemini\antigravity-gemini-web-live\app_data\mcp-host\connector.json` chứa endpoint, PID và bearer transport; không commit, chia sẻ hoặc dán vào prompt. `turn_token` do `ide_host_begin` trả là capability riêng của một task; chỉ chuyển cho phiên Gemini được ủy quyền của task đó. Token hết hạn theo TTL, không phục hồi qua restart. Task receipts chỉ lưu ID và workspace hash để chống replay.

## Kiểm thử đầy đủ sau khi connector sẵn sàng

Dùng [prompt host-agent](MCP_HOST_AGENT_PROMPT.md). Bắt đầu bằng một file fixture và chỉ advertise tool đọc file thật của task. Chứng minh chuỗi:

1. IDE tạo binding và gửi yêu cầu sang Gemini thật.
2. Gemini gọi custom MCP với capability đúng, enqueue đúng tool và tham số.
3. Agent IDE nhận action một lần, xác thực workspace/tham số và thực thi native tool với approval hiện hành.
4. Gemini nhận đúng kết quả tool, rồi gửi final answer về cùng task.
5. Thử lỗi tool, user từ chối, cancel, capability cũ và mất kết nối. Không resend hành động đã claim nhưng chưa rõ kết quả.

Chỉ khi chuỗi này có trace native thật mới ghi native MCP E2E PASS. Test client HTTP hoặc fake executor không được dùng thay bằng chứng đó. Workspace binding ở broker là nhãn authority; host agent vẫn phải kiểm tra đường dẫn và ngữ nghĩa tool trước khi gọi executor thực tế.

Rollback: xóa hai entries tương ứng trong cấu hình global và workspace, rồi refresh MCP. Bản global trước đăng ký được giữ trong file `mcp_config.json.backup-*` cùng thư mục. Không cần thay binary hoặc xóa dữ liệu browser.

Nguồn: [repo tham khảo](https://github.com/miuuyy/codex-chatgpt-web/blob/main/docs/architecture.md), [Antigravity MCP](https://antigravity.google/docs/mcp), [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server).

## Physical receipt metadata (source worker 18)

Browser MCP source mới thêm `gemini_receipt` để đọc metadata bền vững mà không mở Chrome. Bộ browser tools mới có 7 công cụ; kết quả discovery 7/7 đã được kiểm thử qua stdio fixture, chưa phải xác nhận UI IDE hiện tại đã refresh worker mới. `gemini_receipt` không khôi phục model text và không cho phép replay.

Worker 18 dùng SQLite tích hợp, yêu cầu Node 22.13+ trong nhánh 22.x hoặc Node 24+. Migration giữ tất cả receipt v1, backup byte gốc và marker khiến runtime cũ từ chối. Nâng cấp không coi restart là cách xóa receipt. [Chi tiết kiểm thử và ranh giới runtime](evidence/g4-native-p4-physical-ledger.md).
