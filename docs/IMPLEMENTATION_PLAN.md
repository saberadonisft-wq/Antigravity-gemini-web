# Kế hoạch Antigravity – Gemini Web

**Kế hoạch nâng cấp tổng hợp 16/10/2026:** xem [NATIVE_UPGRADE_PLAN.md](NATIVE_UPGRADE_PLAN.md) cho baseline revision 22, đa tài khoản, handoff giữ chat IDE, upload context, nguồn kiến thức Gemini Web và các gate P0–P8. Nội dung lịch sử bên dưới giữ nguyên để đối chiếu.

**Cập nhật native provider 15/10/2026:** đã triển khai endpoint Cloud Code local trên profile IDE riêng, model Gemini Web (Local), fresh browser conversation và native functionCall/functionResponse. Chat native và view_file thật đã PASS. Sửa file/chạy test, cancel và compaction còn nghiệm thu riêng; Google reverse connector độc lập. [Cách chạy](NATIVE_SETUP.md), [bằng chứng hiện tại](evidence/g4-native-provider-validation.md), [ADR 0008](adr/0008-native-gemini-web-provider.md). Các gate BLOCKED và kết luận chưa thay native model trong snapshot bên dưới không còn đại diện cho hai ca native đã PASS này.

Ngày lập: 14/10/2026. Cập nhật 15/10/2026: đã triển khai qua G4 theo chỉ thị người dùng. **G4-A launcher/control/fixture VERIFIED**, **G4-B BLOCKED / NOT_TESTED**, chưa G5. Các hiện trạng khảo sát ban đầu bên dưới là snapshot ngày lập. [Nghiệm thu hiện tại](evidence/g4-acceptance-validation.md), [hướng dẫn tự test](G4_USER_TEST_GUIDE.md).

Cập nhật MCP 15/10: người dùng chốt ưu tiên Gemini Web gọi công cụ của task IDE. Đã triển khai local MCP host broker + web transport, browser MCP và OAuth gateway (DCR/owner consent/PKCE/refresh/revoke). 3 lượt Google browser thật và IDE browser roundtrip PASS; OAuth/MCP local fixture PASS; **chưa deploy HTTPS public, chưa Google reverse connector/native task E2E**. Xem [MCP setup](MCP_SETUP.md), [gateway setup](MCP_GATEWAY_SETUP.md), [ADR 0006](adr/0006-mcp-oauth-gateway.md), [validation](evidence/g4-mcp-gateway-validation.md). Đây là tiếp tục G4; chưa G5 hoặc thay native model.

## 1. Mục tiêu đã chốt

Ưu tiên sử dụng Gemini Web ngay trong chat native của Antigravity IDE: gửi yêu cầu từ IDE, suy luận qua phiên Gemini Web của người dùng, trả phản hồi về đúng tác vụ, và dùng công cụ của tác vụ để đọc/sửa file, chạy lệnh.

Điều kiện thành công không chỉ là có một cửa sổ chat Gemini cạnh IDE. Một MCP tool hỏi Gemini, một CLI riêng hoặc một giao diện chat mới không được tính là hoàn thành mục tiêu native này.

Phân công ban đầu: Gemini làm giao diện; Codex phụ trách khảo sát tích hợp, runtime, bridge, adapter trình duyệt, hợp đồng dữ liệu và ghép hệ thống. Người dùng đã chấp thuận triển khai G0–G4 và sửa lỗi trong các lượt sau. Không tự triển khai G5 hoặc sửa binary/cấu hình IDE chính.

## 2. Hiện trạng và bằng chứng

| Nội dung | Đã biết | Chưa chứng minh |
|---|---|---|
| Workspace | Chỉ có README và Git; chưa có mã ứng dụng, dependency hay `.codegraph/` | Toàn bộ runtime và UI |
| Antigravity trên máy | Lệnh `antigravity`/`agy` chưa được tìm thấy qua PATH khi khảo sát | Vị trí cài, phiên bản, loại sản phẩm; không suy ra là chưa cài |
| Repo tham khảo | Đã đọc source tại commit `889f291d06339400a8b9c2941473f65cd47d4830`, package 6.1.9, MIT | Khả năng áp dụng trực tiếp cho Antigravity/Gemini |
| Antigravity CLI/SDK | Tài liệu mô tả custom endpoint ở CLI, local OpenAI-compatible endpoint ở SDK | IDE có dùng cùng cơ chế không; request thực tế của phiên bản trên máy |
| Gemini Web custom MCP | Tài liệu có custom apps, kèm điều kiện tài khoản/khu vực và xác nhận thao tác ghi | Tài khoản cụ thể có tính năng; kết nối và thực thi thực tế |
| Browser automation | Là hướng kỹ thuật có thể nghiên cứu | Đăng nhập, chọn model, đọc phản hồi và hủy trên Gemini thật |

Không chốt model, context window, giới hạn quota hoặc mức tiết kiệm quota bằng giá trị từ repo ChatGPT. Từng kết luận phải gắn phiên bản ứng dụng và ngày kiểm tra.

## 3. Phạm vi phiên bản đầu

- Windows trước, một tài khoản Gemini, một workspace, một lượt đang chạy.
- Một model Gemini mà tài khoản thật truy cập được; xác nhận lựa chọn trước khi gửi.
- Text và code trước; ảnh, tệp đa phương tiện, nhiều tài khoản và nhiều agent để giai đoạn sau.
- Vòng tối thiểu: yêu cầu IDE → Gemini Web → đọc file → sửa file → chạy test → câu trả lời cuối tại IDE.
- Có cancel, timeout, trạng thái lỗi rõ, chống chạy lại thao tác, log đã loại dữ liệu nhạy cảm và gỡ tích hợp.
- UI launcher dùng để thiết lập, xem kết nối/tác vụ, xử lý lỗi và quản lý phiên. Chat chính vẫn ở Antigravity.
- Chưa làm auto-update, marketplace, theo dõi quota dạng con số chính xác, mở rộng context nhiều tin nhắn hoặc chạy ngầm tự khởi động cùng Windows.

## 4. Kiến trúc dự kiến

```text
Antigravity IDE: chat và tool executor của tác vụ
                     ↕ [đường tích hợp phải chứng minh ở G0]
Native host adapter ↔ Model bridge ↔ Session/context manager
                                         ↕
                                  Gemini browser adapter
                                         ↕
                              Profile trình duyệt riêng

Launcher renderer → typed preload API → Electron main → runtime control
```

Model bridge và API điều khiển launcher là hai giao diện khác nhau. Hợp đồng UI không xác định giao thức model của IDE. Không mặc định dùng Responses API chỉ vì repo tham khảo dùng nó.

### Đường gọi công cụ: quyết định sau khảo sát

**Đường A — Native tool protocol:** nếu IDE cho cấu hình backend và nhận tool calls, bridge chuyển yêu cầu có cấu trúc từ Gemini thành tool call mà IDE hiểu; IDE thực thi rồi gửi kết quả về lượt tiếp theo. Cần thử chính xác schema, ID và kết thúc stream của phiên bản IDE.

**Đường B — Gemini custom MCP:** chỉ dùng nếu tài khoản hỗ trợ và đã chứng minh được đường từ MCP về executor đúng tác vụ của IDE. Hai đầu cùng hỗ trợ MCP không tự tạo ra đường này. Giữ nguyên cơ chế xác nhận thao tác của Gemini.

**Đường C — Đề xuất tool bằng văn bản có cấu trúc:** phương án thử nếu A nhận native tool call nhưng Gemini không có MCP. Chỉ nhận một envelope đúng schema, gắn request nonce, tên tool trong danh sách của lượt, tham số hợp lệ và giới hạn kích thước. Reject nội dung mơ hồ. Code block thông thường không phải lệnh. Nonce chỉ giúp gắn lượt, không biến văn bản model thành nội dung đáng tin.

Nếu chỉ tự chạy lệnh trong runtime riêng được mà không giữ được executor và approval của IDE, phải ghi nhận đây là agent riêng; chưa đạt mục tiêu native.

### Stack đề xuất

| Thành phần | Đề xuất | Mức chốt |
|---|---|---|
| Runtime/bridge | TypeScript strict, Node LTS, schema runtime bằng Zod | Chốt phiên bản ở G1 |
| Browser adapter | Playwright với profile riêng; Electron browser chỉ khi login/smoke đạt | Quyết định ở G0-B |
| Desktop shell | Electron main + preload API hẹp, context isolation, renderer không có Node | Đề xuất cho launcher |
| Renderer | React + TypeScript + Vite, CSS variables | Gemini có thể dựng mock độc lập sau khi được giao |
| Package management | npm; renderer có package độc lập ban đầu | Root workspace/lockfile do Codex quản lý |
| Storage | Config và integration journal có version, ghi atomic; bí mật qua lưu trữ phù hợp hệ điều hành | Chốt layout ở G1 |
| Test | Unit/integration cho giao thức và vòng đời; browser thật cho acceptance | Không dùng mock thay bằng chứng live |

Không kéo toàn bộ dependency hoặc phiên bản Bun của repo tham khảo khi chưa có nhu cầu.

## 5. Giai đoạn và điều kiện chuyển tiếp

### G0 — Chứng minh khả thi native trước

**G0-A: Antigravity IDE**

1. Xác định đúng app/IDE/extension và phiên bản cài trên máy; đọc metadata và cấu hình có liên quan, không đọc token/cookie.
2. Kiểm tra tài liệu, command/config schema và extension surface để tìm cách đăng ký model hoặc đổi endpoint.
3. Dùng workspace và cấu hình thử tách biệt nếu sản phẩm hỗ trợ; nếu không hỗ trợ thì ghi rõ giới hạn trước khi can thiệp cấu hình đang dùng.
4. Lập local stub ghi metadata đã redact để chứng minh một prompt từ chat native đi tới endpoint của mình. Stub chỉ chứng minh route, không chứng minh Gemini chạy được.
5. Trả về một câu trả lời và một tool request vô hại; chứng minh IDE hiểu đúng, thực thi đúng workspace, trả kết quả, và xử lý cancel.
6. Kiểm tra model native khác, cấu hình cũ và khôi phục route. Phân biệt “đổi backend model hiện có” với “thêm được dòng Gemini Web trong picker”.

**Không vượt qua bằng việc sửa hosts, TLS interception, lấy thông tin xác thực hoặc patch binary một cách mặc định.** Nếu chỉ còn patch nội bộ, lập phương án riêng với phiên bản được hỗ trợ, tác động update và rollback để người dùng quyết định.

**G0-B: Gemini Web**

1. Người dùng tự đăng nhập profile riêng; xác minh Gemini chat thật dùng được. Không lấy cookie từ profile trình duyệt đang dùng.
2. Thử host trình duyệt được hỗ trợ; không giả định Google login hoạt động trong Electron. Nếu có challenge/MFA thì chuyển trạng thái yêu cầu thao tác người dùng.
3. Gửi prompt ngắn, đọc đúng lượt phản hồi, giữ markdown/code fence, tiếp tục 3 lượt trong cùng phiên và hủy một lượt đang chạy.
4. Kiểm tra tài khoản có custom apps/MCP không; ghi điều kiện thực tế. Không đổi vùng hay vòng qua điều kiện truy cập.
5. Thử envelope yêu cầu tool ở chế độ read-only nếu đi đường C; đo tỷ lệ sai schema, không thực thi lệnh từ văn bản chưa kiểm tra.

**Sản phẩm G0:** `docs/evidence/native-feasibility.md`, bảng tương thích phiên bản, log đã redact, quyết định đường tool và browser host. Cần nêu rõ đạt/không đạt/chưa thử cho từng bước.

**Gate G0:** chỉ chuyển sang native implementation khi A và B đạt và ghép được một lượt đọc file thật từ IDE qua Gemini. Nếu A không đạt: báo nguyên nhân và trình người dùng lựa chọn nghiên cứu tiếp hay đổi sang CLI/SDK/MCP. Không tự đổi mục tiêu. UI mock vẫn có thể hoàn thành độc lập nhưng không được quảng bá như tích hợp đã chạy.

### G1 — Nền tảng, hợp đồng và ownership

1. Tạo skeleton sau khi kế hoạch được duyệt; root scripts, formatter/lint, typecheck và test runner.
2. Chốt `packages/contracts` từ [UI_RUNTIME_CONTRACT.md](UI_RUNTIME_CONTRACT.md); validate hai đầu IPC.
3. Xác lập adapter interfaces: native host, Gemini browser, session store, event stream, integration journal.
4. Tách profile DEV và profile người dùng, port collision, single-instance/runtime ownership và shutdown.
5. Ghi ADR cho giao thức IDE, browser host, đường tool và cách bảo quản session.

**Gate G1:** renderer mock chạy độc lập; runtime fake phục vụ đúng cùng contract; không cần tài khoản để mở UI; live mode không tự fallback về mock.

### G2 — Một lượt end-to-end thật

1. Nhận context/tool inventory từ host adapter, chuẩn hóa nhưng không âm thầm bỏ hướng dẫn/lịch sử.
2. Gửi qua Gemini adapter với binding workspace/task/turn; kiểm tra đúng model nếu UI có thể xác minh.
3. Chuyển text/markdown về native stream; chỉ phát sự kiện mà nguồn thực tế cung cấp, không giả lập reasoning hay token usage.
4. Tool loop đi qua đường đã chứng minh ở G0, bảo toàn call ID và approval boundary.
5. Thêm model/integration metadata cần thiết theo cơ chế IDE đã xác minh.

**Gate G2:** từ chat native, model đọc file mẫu, tạo bản sửa đúng yêu cầu, chạy test của mẫu và trả kết quả phản ánh exit code thật. Thử cả test pass và fail. Có log đối chiếu IDE → browser → executor mà không chứa bí mật.

### G3 — Độ bền và ngữ cảnh

1. State machine cho queue, submission, streaming, tool execution, completion và cancellation.
2. Dedupe theo session/turn/call ID; mất xác nhận sau thao tác ghi là trạng thái `outcome_unknown`, không tự thực thi lại.
3. Hủy có acknowledgment, timeout rõ, thu hồi quyền của lượt cũ; đóng tab/runtime không tạo lại công việc đã hủy.
4. Phục hồi sau crash: đánh dấu interrupted và yêu cầu đối chiếu trạng thái; không hứa exactly-once xuyên crash nếu chưa chứng minh.
5. Ngân sách context dựa trên phép đo; nếu quá giới hạn thì báo lỗi hoặc handoff có kiểm tra. Chỉ triển khai compaction khi xác minh được contract của host.
6. Thử attachment, model changes, account changes ở mức phát hiện và thông báo; hỗ trợ đầy đủ có thể để bản sau.

**Gate G3:** cancel, reconnect, browser crash, IDE restart và stale tool call đều có kết quả xác định; không trộn dữ liệu hai workspace; không gửi lại prompt đã được browser chấp nhận chỉ để chữa DOM.

### G4 — Ghép launcher do Gemini làm

**Cập nhật cuối G4-A 15/10/2026:** 148/148 TS tests, build/typecheck/lint và desktop acceptance PASS. Actual second-instance, pending window lifecycle, Chrome fixture crash/reconnect, 10 UI scenarios, Save/Cancel Windows, keyboard/theme/reduced-motion và computed contrast có bằng chứng. **G4-A VERIFIED trong scope launcher/control/fixture; G4-B BLOCKED / NOT_TESTED.** [Validation hiện tại](evidence/g4-acceptance-validation.md) thay thế snapshot 119/133/146 tests. [Tự test](G4_USER_TEST_GUIDE.md). Dừng G4, không G5.

**Cập nhật review G4 14/10/2026:** Desktop control core đã smoke Electron thật; 119/119 TS tests pass. Toàn bộ G4-A vẫn PARTIAL (early operation ack/progress, English và acceptance cases), G4-B BLOCKED/NOT_TESTED. Tiếp theo [GEMINI_G4_CONTINUE_PROMPT.md](GEMINI_G4_CONTINUE_PROMPT.md), dựa trên [validation](evidence/g4-codex-remediation-validation.md), chưa chuyển G5.

**Phân kỳ sau review G3:** G4-A có thể triển khai launcher/main/preload và backend control độc lập khi native/live gates chưa thông; các thao tác chưa có provider phải disabled/reject. G4-B chỉ nghiệm thu native/live sau khi route và browser thật đã được chứng minh. Source G3 core đã kiểm chứng bằng controlled tests, chưa phải recovery native E2E. Prompt hiện tại: [GEMINI_G4_PROMPT.md](GEMINI_G4_PROMPT.md); mốc bản vá: [g3-codex-remediation-validation.md](evidence/g3-codex-remediation-validation.md).

1. Thay `MockLauncherClient` bằng preload client qua interface đã chốt.
2. Kết nối login/browser focus, kiểm tra kết nối, xem tác vụ, cancel, logs, cài/gỡ route và settings.
3. Long-running command trả operation ID; UI phản ánh progress thật, không setTimeout để giả thành công.
4. Cài/gỡ route có preview thay đổi, journal trước/sau, phát hiện cấu hình bị sửa bên ngoài và rollback chính xác.
5. Test layout ở cửa sổ nhỏ/lớn, bàn phím, focus, text dài, lỗi, offline và đóng app khi đang chạy.

**Gate G4-A:** launcher desktop + IPC có test trên đường gọi runtime thật; commands đã triển khai có kết quả thật, commands chưa verified bị khóa; màn demo có nhãn; renderer không thao tác DOM/bí mật. **Gate G4-B:** native/live E2E có bằng chứng riêng; chưa đủ G2 gates thì BLOCKED/NOT_TESTED, không đổi thành PASS do UI/fixture chạy được.

### G5 — Bản thử Windows và nghiệm thu

1. Đóng gói sau khi đã pin dependency và kiểm tra license attribution của phần tái sử dụng.
2. Thử clean install, đường dẫn có dấu/khoảng trắng, port bị chiếm, nâng cấp và uninstall; uninstall không tự xóa profile đăng nhập nếu chưa có lựa chọn riêng.
3. Chạy toàn bộ acceptance bên dưới với phiên bản IDE và account cụ thể.
4. Xuất release notes ghi hỗ trợ thực tế, lỗi còn lại, cách gỡ route, giới hạn quota/context chưa đo.
5. CI build xanh và smoke launcher chỉ là bằng chứng đóng gói; chỉ gắn “native integration verified” cho tổ hợp đã thử thật.

**Gate G5:** có báo cáo nghiệm thu và bản build kiểm tra được; chưa tự publish hoặc thay cấu hình máy khác.

## 6. Công việc giao diện song song

Gemini có thể làm UI mock trong thời gian Codex thực hiện G0 khi người dùng giao việc. Công việc không phụ thuộc G0: navigation, onboarding states, connection cards, session list, activity log, settings, responsive và accessibility.

Tạm để disabled/“Chưa kiểm chứng”: install native route, model picker thật, MCP setup cụ thể, context/quota chính xác. Không dựng một ô chat mới làm tính năng chính để thay mục tiêu IDE.

Handoff chi tiết: [GEMINI_UI_HANDOFF.md](GEMINI_UI_HANDOFF.md). Prompt gửi Gemini: [GEMINI_UI_PROMPT.md](GEMINI_UI_PROMPT.md).

## 7. Phân chia thư mục dự kiến

```text
apps/launcher/main/                 Codex: Electron lifecycle, IPC, preload
apps/launcher/renderer/             Gemini: UI, mock client, assets, package riêng
packages/contracts/                Codex: schema/types dùng chung
packages/runtime/                  Codex: control service, lifecycle, storage
packages/native-antigravity/       Codex: integration/route, protocol host
packages/gemini-browser/            Codex: browser/session/prompt/response
packages/model-bridge/              Codex: context, tool calls, streaming
tests/integration/                  Codex: integration và failure scenarios
docs/                              Kế hoạch/hợp đồng do Codex; UI notes trong renderer
```

Gemini chỉ sửa subtree renderer và không sửa root lockfile, runtime, preload hay contracts. Đề xuất đổi contract ghi vào `apps/launcher/renderer/CONTRACT_REQUESTS.md`; chưa được chấp thuận thì không tự đổi tên field. Nếu hai bên cùng Git checkout, stage theo danh sách file của mình; không dùng `git add .`.

## 8. Nghiệm thu tối thiểu

| Nhóm | Ca cần thử | Bằng chứng |
|---|---|---|
| Native route | Prompt từ đúng chat IDE, trả text, model binding đúng | Trace có cùng session/turn ID |
| Gemini thật | Đăng nhập, model selection, 3 lượt liên tiếp, markdown | Browser và output đối chiếu |
| Tool | Read → patch → test; test lỗi; tham số sai; tool không được cấp | Kết quả file/exit code thật, rejection rõ |
| Quyền | Ghi ngoài workspace, traversal/symlink, từ chối approval, stale token | Host policy chặn; runtime không nới quyền |
| Vòng đời | Cancel trước/sau Send, trong tool, đóng tab/app, mất kết nối | Không orphan work, không tự chạy lại |
| Context | Gần giới hạn, vượt giới hạn, đổi model, handoff nếu hỗ trợ | Không cắt ngầm; phục hồi được hoặc báo lỗi rõ |
| Cấu hình | Install, disconnect, config conflict, rollback, uninstall | Diff đúng phần sở hữu, dữ liệu trước được giữ |
| UI | Demo/live, empty/loading/error, reconnect, thao tác bàn phím | UI smoke và ảnh các viewport |
| Phát hành | Clean install, upgrade, checksum, license notices | Báo cáo build và test theo version |

Khi đánh giá độ ổn định, chạy tối thiểu 10 tác vụ nhỏ liên tiếp và ghi tất cả failure, latency, retry; đây là acceptance ban đầu, không phải chứng nhận production. Không đặt tỷ lệ thành công giả trước khi có dữ liệu.

## 9. Rủi ro và cách ra quyết định

- **IDE không có extension point phù hợp:** dừng nhánh native ở G0; CLI/SDK chỉ là lựa chọn thay đổi phạm vi cần người dùng chốt.
- **Google login không chạy trong embedded browser:** thử trình duyệt được hỗ trợ với profile riêng; nếu vẫn không đạt thì chưa qua G0-B.
- **Gemini không có MCP cho account:** thử tool envelope có schema qua native protocol, đo độ tin cậy trước khi cho sửa file.
- **DOM thay đổi hoặc không xác minh model:** trả lỗi có hướng khắc phục; không âm thầm chuyển model hoặc transport.
- **Mất trạng thái sau Send/tool write:** dừng với outcome unknown và đối chiếu; không retry thao tác không idempotent.
- **Quyền bị nới rộng do bridge:** executor của host là thẩm quyền; prompt không được tự tạo workspace/tool mới.
- **UI hoàn thành sớm hơn backend:** tiếp tục giữ demo mode riêng và capability-driven UI; không đưa badge Connected giả vào live mode.
- **Quota và chi phí:** chưa hứa tiết kiệm cụ thể; kiểm tra provider route, request background và số lần gửi thực tế, không suy diễn “Web” đồng nghĩa không giới hạn.

## 10. Tham khảo và tái sử dụng

Repo tham khảo: https://github.com/miuuyy/codex-chatgpt-web/tree/889f291d06339400a8b9c2941473f65cd47d4830

Nên học: integration journal (`src/codex-integration*.ts`), turn binding/cancel (`src/adapters/chatgpt-web/turn-broker.ts`), browser lifecycle (`launcher/electron/browser-host.cjs`), tách renderer/main, DEV profile và phân biệt CI với live acceptance.

Không bê nguyên: selector ChatGPT, Codex Responses schema, tên connector/tunnel, model catalog, context budgets, auth profile và hướng dẫn đăng nhập. Gemini được tham khảo UI/flow của launcher; code tái sử dụng phải ghi file/commit gốc, giữ thông báo MIT và kiểm tra license của asset/dependency. Không đưa thương hiệu hoặc hình ảnh demo ChatGPT vào UI như của dự án này.

Tài liệu chính thức đã kiểm tra ngày 14/10/2026:

- CLI custom endpoint: https://antigravity.google/docs/cli/install/
- SDK local endpoint: https://antigravity.google/docs/sdk/local-models/
- Antigravity MCP: https://antigravity.google/docs/mcp
- Gemini custom apps và điều kiện account: https://support.google.com/gemini/answer/17209137?hl=en-VU

Ước lượng công việc chỉ được chốt sau G0; hiện chưa có đủ bằng chứng về native protocol để hứa ngày hoàn thành. Ưu tiên là giảm rủi ro tích hợp trước khi đầu tư launcher đầy đủ.
