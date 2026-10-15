# Review G2: inference/provider probes và browser driver

Ngày review: 14/10/2026. Đối chiếu báo cáo nghiệm thu với checkout hiện tại, build mới và chạy kiểm thử có watchdog. Chỉ thêm tài liệu review; không sửa implementation, đăng nhập, thay cấu hình IDE hay gọi Gemini Web thật.

**Kết luận: chưa nghiệm thu G2, chưa chuyển G3.** Shim regressions và browser happy path trên fixture đạt. Native inference chưa được kiểm chứng; browser còn các lỗi về ownership, xác minh surface, completion, cancellation và turn binding.

## Các kết quả reviewer đã chạy lại

| Kiểm tra | Kết quả hiện tại | Phạm vi |
|---|---|---|
| `npm run build` | PASS, khoảng 10,23 giây | Biên dịch 5 workspaces |
| `npm run typecheck` | PASS, khoảng 6,60 giây | TypeScript `--noEmit` |
| `npm test` | 32/32 PASS, khoảng 10,97 giây | contracts 8, browser 2, bridge 4, native 1, runtime 17 |
| Browser fixture | PASS, khoảng 7,27 giây | 3 lượt synthetic và cancel happy path; không chứng minh Gemini Web live |
| Build shim/fake child | PASS | Compiler .NET Framework trên máy |
| Shim suite | 9/9 PASS, khoảng 4,33 giây | Bao gồm H1/H2 regressions hiện có |
| G0 probe unit suite | 6/6 PASS | Unit tests; log mô phỏng không phải live acceptance |
| `verify_probe_timeout.py` | PASS | Fake child; timeout đặt 3 giây, cleanup thực tế khoảng 4,07 giây |
| LS `--help` | Exit 2, có usage | Xác nhận mô tả flags và default; không chạy inference |

Lệnh npm test chạy trong wrapper giới hạn 90 giây. Lần đầu wrapper không in được ký tự Unicode của Node do encoding console; chạy lại với UTF-8 và lấy được đầy đủ kết quả phía trên. Đây không phải một lỗi assertion của suite.

Các script `lint` hiện đều là `tsc --noEmit`; không có một bộ lint rules độc lập. Sau các checks không quan sát thấy Chrome mang profile `gemini-driver-test-profile-*`, shim hoặc fake child còn chạy. Quan sát này giới hạn ở các tài nguyên kiểm thử vừa nêu, không phải chứng minh tuyệt đối mọi process/profile đều không thể rò rỉ.

## V1 — [P1] Kết luận native UNSUPPORTED/MITM bắt buộc vượt quá bằng chứng

Nguồn: [raw probe results](../../tools/probes/g2/inference_routes_probe_results.json), [provider report](g2-inference-provider-probes.md), [gate report](g2-native-browser-gates.md), [probe](../../tools/probes/g2/probe_ls_inference_routes.py) dòng 270–325 và 330–335.

Cả 4 scenario đã lưu đều có:

- `ports.http/https/extension = null`;
- `rpc_attempted = false`, `rpc_status = null`;
- không có outbound request;
- `verdict = TIMEOUT_OR_NO_PORT`, elapsed khoảng 11 giây.

Baseline chưa đạt readiness. Kết quả này chưa kiểm tra được inference, response decoding hoặc executor native. Ma trận trong Markdown cũng dùng endpoint khác arguments trong raw JSON: ví dụ report ghi `https://custom-ccpa.internal`, trong khi experiment dùng `http://127.0.0.1:58202`; report ghi Blade override, nhưng experiment truyền `127.0.0.1:65305`.

Usage của đúng LS xác nhận mô tả `ccpa or gemini`, default generative service là Blade, cùng các cờ `cloud_code_endpoint`, `generative_service_addr`, `inference_api_server_url`. Đây là bằng chứng tĩnh về config, chưa chứng minh semantics outbound hay custom compatibility bridge không thể hoạt động. Việc thiếu cờ nhận HTML của Gemini Web không chứng minh phải dùng MITM giữa IDE và LS.

Probe còn đặt `inference_route_verified = true` chỉ từ path chứa `generate` hoặc `cascade`. Reviewer dùng child synthetic gửi `{}` đến local `/generate-health`: probe trả `PROVED`, dù không có native prompt, token decoding hoặc tool round-trip.

**Sửa:** đổi gate về `UNRESOLVED / NOT_TESTED`, ghi rõ startup/readiness là blocker hiện quan sát được; tách defaults/static findings khỏi observations. Thiết lập baseline đúng launch/init contract trước khi thử override. Xác minh schema RPC trước khi dùng payload StartCascade hiện tại. Chỉ nâng inference gate khi có synthetic native prompt, response fixture decode đúng lượt và read-only executor round-trip. Không kết luận TLS interception bắt buộc từ các timeout này.

## V2 — [P1] Cleanup đóng browser mà driver chỉ attach vào

Nguồn: [gemini-browser-driver.ts](../../packages/gemini-browser/src/gemini-browser-driver.ts) dòng 217–224; [index.ts](../../packages/gemini-browser/src/index.ts) dòng 78–80.

`close()` gửi `Browser.close` bất cứ khi nào có CDP, trước khi kiểm tra `childProcess`. `checkStatus()` có thể attach vào Chrome đang mở sẵn; cleanup sau đó sẽ đóng toàn bộ browser này, gồm các tab ngoài ownership của adapter.

Controlled proof: driver không có child, gắn client CDP giả rồi gọi `close()`; client vẫn nhận `Browser.close`. Không đóng browser thật trong review.

**Sửa:** lưu rõ owned process/owned tab/attached target. Với target chỉ attach, chỉ disconnect; đóng tab/process khi có ownership đã xác lập. Cleanup idempotent và có deadline; không chạy taskkill với PID của browser bên ngoài.

## V3 — [P1] Generic composer có thể được báo là Gemini signed-in; model bị tự điền

Nguồn: [gemini-selectors.ts](../../packages/gemini-browser/src/gemini-selectors.ts) dòng 9–10, 64–70; [index.ts](../../packages/gemini-browser/src/index.ts) dòng 78, 101–109, 245.

`checkStatus()` chọn page bất kỳ. Selector chấp nhận generic textarea/contenteditable; snippet xem bất kỳ composer nào là `signed_in`, kể cả nhánh được chú thích dành cho fixture nhưng chạy chung trong live. URL được đọc nhưng không được xác minh bằng origin. Adapter mặc định báo `ready`, và điền `Gemini 1.5 Pro` khi không có model evidence.

Controlled DOM proof: `https://example.invalid/support` chỉ có textarea được báo `signed_in`; adapter báo `ready`, `signed_in`, model `Gemini 1.5 Pro`. Không truy cập website thật.

**Sửa:** live chỉ chấp nhận đúng Gemini origin/path và DOM evidence cụ thể; fixture phải là mode riêng với explicit allowlist, không rơi vào production fallback. Account không đủ evidence là `unknown`; model không nhận diện được phải để unknown/absent. Unknown surface/composer không đủ điều kiện không được `ready` hoặc gửi prompt. Không chọn page bằng substring hoặc page đầu tiên.

## V4 — [P1] Partial response sau timeout được trả completed

Nguồn: [index.ts](../../packages/gemini-browser/src/index.ts) dòng 225–245.

Adapter chỉ trả TIMEOUT nếu `completed = false` **và** text rỗng. Nếu đã có một phần text nhưng generation vẫn chưa xong, code trả `status = completed`. Caller `sendPrompt()` cũng nhận đoạn dở dang như final answer.

Controlled proof: driver trả `{ completed: false, text: 'SYNTHETIC_PARTIAL_TEXT' }`; adapter trả `completed`.

**Sửa:** completion cần dấu kết thúc được xác nhận. Timeout có partial text vẫn là failed/timeout hoặc trạng thái chưa terminal theo contract; giữ partial như dữ liệu phụ, không đổi thành success. Deadline phải truyền xuống CDP/poll còn lại.

## V5 — [P1] Cancel báo thành công khi Stop thất bại; poll có thể đổi terminal outcome

Nguồn: [index.ts](../../packages/gemini-browser/src/index.ts) dòng 203–213, 250–273.

`active.cancelled` được đặt trước khi click Stop. Giá trị false từ `clickStop()` bị bỏ qua; exception cũng trả `cancelled = true`. Poll tiếp theo suy ra cancelled từ cờ local mà không xác nhận generation đã dừng.

Reviewer xác nhận cả trường hợp click trả false và throw đều báo cancel thành công. Với poll đang chờ, cancel xảy ra rồi driver trả response: poll đang chờ trả `completed`, poll tiếp theo trả `cancelled` cho cùng turn. Các lượt completed vẫn nằm trong activeTurns và có thể bị hủy lại.

**Sửa:** tách cancel requested và cancel confirmed; xác minh Stop/DOM generation hoặc transport cleanup. Đồng bộ poll/cancel bằng state machine/epoch và một terminal outcome bất biến. Từ chối cancel trên turn đã terminal. Failure/unknown outcome phải được báo đúng.

## V6 — [P1] Không chống resend cùng turn và không bind response cho overlapping turns

Nguồn: [index.ts](../../packages/gemini-browser/src/index.ts) dòng 149–187, 192–245; [gemini-browser-driver.ts](../../packages/gemini-browser/src/gemini-browser-driver.ts) dòng 190–193.

`submitPrompt()` click Send trước khi tạo record và không kiểm tra turnId đã tồn tại hoặc browser đang có turn active. Hai lần cùng turnId gửi hai prompt. Hai lượt đồng thời có thể cùng lấy initial responseCount; polling lấy last response toàn trang và gán nó cho cả hai turn.

Controlled driver proofs: cùng turnId gây 2 Send; hai turnId đồng thời đều accepted và nhận cùng synthetic response của turn B. Đây là probe adapter với driver giả, không phải live multi-turn acceptance.

**Sửa:** reserve lượt trước side effect; serialize một browser conversation hoặc reject BUSY; idempotent retry cùng turnId/content, conflict cho content khác. Receipt phải gắn page/conversation/response identity cụ thể. Một response không được hoàn tất hai accepted turns. Giữ terminal record/ledger đủ để từ chối stale/duplicate requests.

## V7 — [P1] Inference probe vẫn in raw LS logs dù đã import sanitizer

Nguồn: [probe_ls_inference_routes.py](../../tools/probes/g2/probe_ls_inference_routes.py) dòng 31 và 170–172.

`format_http_event`/`sanitize_path` được import nhưng raw line vẫn được print nguyên vẹn. Shim argv redaction không bảo vệ log stdout/stderr của probe này.

Controlled queue proof: đưa `api_key=SYNTHETIC_G2_LOG_SECRET` vào stderr queue; marker xuất hiện nguyên trong captured output.

**Sửa:** log metadata allowlist cho port/protocol/status/error code; không dump raw LS line, auth headers, prompt hoặc payload. Cả failure paths phải qua sanitization. Dùng synthetic markers kiểm chứng trước khi chạy probe với tài khoản thật.

## V8 — [P2] Deadline mới không bao phủ cleanup và toàn bộ I/O

Nguồn: [probe_ls_inference_routes.py](../../tools/probes/g2/probe_ls_inference_routes.py) dòng 69, 107–115, 289–327, 343–368; [gemini-browser-driver.ts](../../packages/gemini-browser/src/gemini-browser-driver.ts) dòng 217–245; [cdp-client.ts](../../packages/gemini-browser/src/cdp-client.ts) dòng 35–80, 127–133.

Queue sửa đúng lỗi blocking readline cũ. Nhưng SafeMockServer dùng blocking body read và shutdown không có deadline. Reviewer giữ một owned HTTP client gửi thiếu body: `stop()` vẫn chờ, chỉ xong khi reviewer thả client. Scenario deadline không ngắt được đoạn này. Silent-child verification mất khoảng 4,07 giây dù đặt 3 giây và assertion cho phép tới 6 giây; cần ghi rõ scenario budget và cleanup budget thay vì gọi là strict 3 giây.

Browser close cũng chờ CDP command theo default 10 giây trước deadline 5 giây; `execSync(taskkill)` không có timeout, cuối cleanup không xác nhận tree thực sự đã thoát. Fixture test nuốt lỗi cleanup và không assertion về process/port, nên happy-path pass không đủ cho claim cleanup 100%. CDP connect timeout không đóng socket đang mở dở; `isConnected` chỉ kiểm tra client khác null.

**Sửa:** dùng deadline chung và cleanup budget hữu hạn; đặt socket/request/body limits, không shutdown vô hạn, timeout child cleanup commands. Timeout/error phải đóng transport và xóa connection state. Thêm ca incomplete HTTP body, CDP không phản hồi, disconnect, và cleanup failure; runner ngoài có watchdog, chỉ dọn process do chính runner tạo. Xác nhận owned process/port đã biến mất và báo failure khi không dọn được.

## Provenance và trạng thái thật

Sau build trong review:

| Artifact | SHA256 |
|---|---|
| `AntigravityShim.cs` | `F7CD5F15F5F94A91B6457098DB51274C19D0B48E661F1CD422730308C7552EF8` |
| `antigravity_shim.exe` | `79F0363BCC0046579949AD03B725156E8B6971F558AFBF1BAE81F64832917EAD` |
| `fake_child.exe` | `5704583405B904F383141B9B932B590FE4936C91958DDB31326C77AB12629363` |
| Native LS | `78C4242BF9E5D84A3A0CA44675D44BE09A028056E54C3F0D85280A4D8700DEE4` |

Không dùng checksum cũ để nhận diện binary build mới; không suy ra reproducible build từ checksum này.

- Launch hook: giữ nguyên launch smoke đã lưu trước đó; review này không mở IDE để chạy lại.
- H1/H2: các regressions hiện có đạt; không suy ra mọi trường hợp đều an toàn từ test count.
- Native inference: `UNRESOLVED / NOT_TESTED`, blocker hiện quan sát là startup/readiness chưa đạt.
- Browser fixture: happy path PASS; các lỗi V2–V6/V8 cần sửa trước live acceptance.
- Browser live: chưa reviewer kiểm chứng login/account/model/3 lượt/cancel thật. `SIGN_IN_REQUIRED` là trạng thái theo báo cáo/probe cũ, chưa được refresh trong review này.
- End-to-end native tool loop: `NOT_TESTED`.

README vẫn ghi driver stub và số tests 31/7 (một đoạn còn 29); cần cập nhật sau remediation. Không coi user login là điều kiện duy nhất còn thiếu của G2.

Observations của các controlled proofs: [g2-inference-browser-review-observations.json](g2-inference-browser-review-observations.json).

Prompt tiếp tục: [GEMINI_G2_INFERENCE_BROWSER_CONTINUE_PROMPT.md](../GEMINI_G2_INFERENCE_BROWSER_CONTINUE_PROMPT.md).
