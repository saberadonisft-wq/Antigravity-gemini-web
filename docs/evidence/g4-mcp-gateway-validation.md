# G4 — Kiểm chứng OAuth gateway cho reverse MCP

Ngày 15/10/2026. Thực hiện sau khi user xác nhận IDE browser MCP trả `MCP_OK` và cho phép tiếp tục gateway. User đã chốt **chỉ kiểm tra local trước** khi được hỏi về deployment. Không thay đổi binary, cấu hình MCP đang chạy, đăng nhập Google hoặc chuyển G5.

Đây là snapshot nghiệm thu gateway trước bản sửa client routing. Hiện tại sau sửa ownership/EOF: **168/168 root, 20/20 MCP**; xem [follow-up](g4-mcp-client-routing-validation.md). Các con số 166/18 bên dưới giữ nguyên bằng chứng của snapshot.

## Kết quả đã kiểm chứng

| Kiểm tra | Kết quả và phạm vi |
|---|---|
| `npm run build` | PASS toàn repo, gồm gateway CLI/provider/HTTP |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS; hiện là `tsc --noEmit`, không có rules lint riêng |
| `npm test` | **166/166 PASS**, 0 fail/skip: contracts 8, browser 22, MCP 18, bridge 4, native 1, runtime 80, launcher 33 |
| MCP tests | **18/18 PASS**, gồm 8 baseline và 10 gateway tests mới |
| Gateway protocol | Official SDK OAuth client thực hiện discovery → DCR → PKCE → consent fixture → code exchange; MCP client gọi web tools qua gateway và broker thật trên loopback |
| Native results trong gateway test | Fixture có nhãn; host broker result/final roundtrip, không có Antigravity native executor |
| Gateway CLI | Bind loopback, descriptor, ownership không cho writer thứ hai, mã pairing không xuất ra stdout, process/port đóng khi dừng |
| Stalled body/silent backend | Thực nghiệm với socket thật: body thiếu bị cắt theo budget 5s; backend im lặng nhận đúng 1 POST rồi gateway trả 503 theo budget 10s. Combined test lượt cuối ~15.07s, dưới test deadline 30s |
| Public HTTPS/TLS/DNS/tunnel | **NOT_CONFIGURED / NOT_TESTED**; Caddyfile chỉ là mẫu, chưa cài/chạy |
| Gemini thật → reverse custom MCP | **NOT_TESTED**; chưa có public URL hoặc custom-app setup trên account quan sát |
| Native read/patch/test/approval loop | **NOT_TESTED**, native model vẫn unverified |

Log cục bộ: `.tmp/g4-followup-build.log`, `typecheck.log`, `lint.log`, `test.log` cùng prefix `g4-followup-`. [Metadata/source hashes](mcp/oauth-gateway-local.json). Không rerun Google prompts, desktop smoke hoặc Python suites trong thay đổi này; kết quả các đợt trước giữ nguyên phạm vi.

## Những hành vi bị từ chối

- Request thiếu OAuth hoặc dùng backend bearer ở cổng public; Host/proto/origin sai; đường file/host-side tools không tồn tại.
- Consent thiếu cookie CSRF, sai Origin, sai/hết hạn mã owner, replay consent hoặc owner code. Client name HTML được escape; logo/client URLs không được tải.
- Code sai client, verifier PKCE, callback, resource; code hết hạn và hai token exchanges dùng cùng code. Chỉ một exchange thành công.
- Refresh sai client/resource/scope; refresh cũ bị dùng lại thu hồi family, kể cả access/refresh mới. Explicit revocation và expiry được kiểm chứng.
- State registration corrupt, đổi issuer với store cũ, hoặc ghi thất bại; không cấp grant/forward tool khi state không khả dụng. Restart giữ registrations, hủy OAuth grants trong RAM.
- Backend descriptor trỏ khỏi exact loopback `/mcp`; không follow redirect, tự retry hoặc đưa bearer nội bộ vào kết quả.

## Thay đổi và quyết định

`gateway-oauth.ts` dùng official SDK auth endpoints, provider riêng cho consent/state/token binding. `gateway-http.ts` chỉ nhận traffic loopback sau TLS proxy có public Host và HTTPS proto đúng cấu hình; resource URL tường minh, không lấy từ headers. Forward tới backend descriptor với bearer riêng, không đưa host tools ra web. `gateway-state.ts` ghi file atomic/fsync và pairing one-use. `gateway-cli.ts` giữ single-owner, startup metadata không chứa token và shutdown có hạn.

Registrations/private confidential client secret nằm trong file local, chưa mã hóa bằng OS keystore. Code/access/refresh chỉ trong RAM; token lookup bằng hash. Windows protection còn phụ thuộc ACL user profile. Đây là thử nghiệm một chủ máy, không chứng nhận dịch vụ public nhiều tenant hoặc security audit hoàn chỉnh.

Phát hiện khi kiểm chứng: Node 24 `fetch` không giữ Host override trong fixture. Đã dùng HTTP request thật giữ Host để test proxy boundary, không nới Host check của gateway. Một nhánh shutdown Promise cũng được sửa để lỗi cleanup được quan sát, tránh rejection không xử lý.

Đã ràng buộc cả ghi và đọc client store cùng 128 KiB. Test với nhiều callbacks dài xác nhận registry đầy bị từ chối mà file đã lưu vẫn đọc được sau restart; không biến capacity thành trạng thái ghi hỏng.

## Failure đã quan sát trong kiểm tra toàn repo

Một lần root suite trả **165/166**, do test cũ `owned-browser.fixture.test.ts`: sau intentional Chrome crash, CIM còn thấy 5 descendant identities ở hạn cleanup. Ngay sau đó đọc OS process list không còn các PID đó; chạy riêng test lại PASS (~4.01s) và chạy lại toàn repo **166/166 PASS**. Không đổi assertion/timeout hoặc production browser driver để biến failure thành PASS. Giữ log thất bại ở `.tmp/gateway-root-cleanup-failure.log`; metadata ghi cả failure và rerun. Đây là dấu hiệu cleanup/observation fixture có tính gián đoạn, chưa sửa và không được tuyên bố “0 flaky”. Gateway suite 18/18 PASS trong cả lần root failure này.

## Bước còn lại

Trong phạm vi đã chọn, user chạy `npm run test:mcp` để kiểm tra local. Bước deployment sau: chọn URL HTTPS ổn định, cấu hình proxy/tunnel theo [setup](../archive/guides/MCP_GATEWAY_SETUP.md), kiểm tra TLS và metadata bên ngoài; rồi user tự thêm custom app/cấp OAuth trên tài khoản được Google hỗ trợ. Chỉ khi có trace Google connector thật → task/approval/native tool thật → final cùng task mới cập nhật native E2E thành PASS.

[ADR 0006](../archive/adr/0006-mcp-oauth-gateway.md), [bằng chứng MCP trước](g4-mcp-validation.md), [prompt host agent](../archive/prompts/MCP_HOST_AGENT_PROMPT.md).
