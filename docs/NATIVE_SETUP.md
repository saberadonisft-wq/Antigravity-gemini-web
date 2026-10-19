# Gemini Web trong chat native Antigravity IDE

**Source 39 / worker 25 (19/10/2026):** có preview ZIP ở launcher và `native:imports:check -- ACCOUNT_ID` quan sát trang import đang mở, mặc định tắt (`AG_NATIVE_IMPORTS_EXPERIMENTAL=1`); [hướng dẫn](NATIVE_CHAT_IMPORT.md), [chạy và test nhanh](NATIVE_TEST_QUICKSTART.md). Không upload Google. Giữ lựa chọn thử nghiệm `AG_MCP_NODE_SEMI_SPACE_MB=8|16|off`, mặc định tắt, có fingerprint và kiểm tra startup/status trước Send. [Hướng dẫn bộ nhớ Node](NATIVE_NODE_MEMORY.md). Các đoạn revision cũ dưới đây là lịch sử, không phải nghiệm thu source mới trên Web thật.

Quan sát read-only ngày 19/10: health tại cổng 9236 không kết nối trong hai lần đọc, PID trong descriptor trả `ESRCH`. Không tự khởi động lại hoặc tác động browser. Mốc runtime 29 ở các báo cáo ngày 18/10 là quan sát lịch sử, không phải xác nhận proxy hiện còn chạy.

**Cập nhật source 36 / worker 23 (18/10/2026):** P8a sửa bound cleanup/ownership leak, queue BUSY và shutdown; [evidence](evidence/g4-native-p8a-pool-lifecycle.md). P6a/P6b có CLI và màn hình Nguồn dự án, mặc định tắt; [hướng dẫn](NATIVE_KNOWLEDGE.md). Electron/IPC/HTTP fixture pass với browser và chooser grant giả lập; lần thử chooser Windows thật chưa hoàn tất selection, không ghi PASS. P5 đã kiểm thử CLI/child owner/Electron và TTL thật với browser giả lập. Runtime chính đọc health vẫn 29/manual, giữ cửa sổ Google chờ xác minh; chưa reload source mới. Các đoạn revision 22/27 bên dưới là mốc lịch sử, không phải chứng nhận runtime hiện tại. Gate Web thật, hai account và executor IDE vẫn mở.

**Runtime revision 22 / browser fingerprint 13 (16/10/2026):** sửa giới hạn cache 128 lượt tại native và MCP, cache Ajv theo inventory, rút gọn mô tả lặp và chờ composer trước khi nhập/gửi lượt tiếp theo. Build, typecheck, 125 kiểm thử liên quan PASS. Batch vẫn mặc định tắt; khi bật hỗ trợ 2–8 lệnh `view_file`/`list_dir`/`grep_search` độc lập trong `ANY`, `AUTO`, `VALIDATED`. Xem [bằng chứng và giới hạn live](evidence/g4-native-runtime-optimization-validation.md). Các kết quả revision 21/20 dưới đây là lịch sử.

Cache kết quả native và MCP giữ tối đa 32 entry nhàn rỗi, hết hạn sau 10 phút và được thu hồi khi có hoạt động tiếp theo. Request có người đang chờ không bị thu hồi ở native. Retry còn kết quả trả lại kết quả đó; retry đã thu hồi trả `OUTCOME_UNKNOWN`, không gửi lại. Từ source 26, physical receipts của browser MCP dùng SQLite WAL, không còn cap 2.048 request của store JSON cũ; migration vẫn kiểm tra cap và giữ backup của định dạng cũ. Receipt được tính theo tin Web vật lý, gồm cả fragment và commit. Không xóa ledger/fences để giải phóng cache; xem [P4 ledger](evidence/g4-native-p4-physical-ledger.md).

**Tối ưu context 16/10 — runtime revision 21 / browser fingerprint 12:** Web editor trên profile này cắt tin nhắn ở khoảng 32k ký tự. Native giữ cap context đầy đủ 262.144 ký tự, tự chia đoạn tối đa 27k, yêu cầu ACK đúng từng đoạn rồi mới gửi lượt chốt riêng. Mỗi tin nhắn browser MCP tối đa 28k. Nhập liệu được kiểm tra trước Send; các lượt tiếp theo vẫn dùng append/patch. Context tổng hợp 78.642 ký tự và vòng tool → functionResponse → final đã PASS trên Gemini thật, lượt tiếp theo chỉ gửi 1.247 ký tự. 118 tests liên quan PASS; chưa retest UI/executor IDE thật. [Bằng chứng và giới hạn](evidence/g4-native-context-delivery-validation.md).

**Cập nhật lỗi nhận response 16/10/2026:** runtime revision **20**, browser fingerprint **11** chờ dấu hoàn tất của đúng phản hồi mới nhất và nội dung ổn định để tránh đọc JSON dở. Lượt lỗi cũ giữ dấu chống gửi lặp riêng, không chiếm chỗ chat mới. 112 tests liên quan và vòng functionCall → functionResponse → final trên Gemini Web thật với caller tổng hợp đã PASS; chưa retest executor/UI IDE. Lượt lỗi trong ảnh đã kết thúc, hãy tạo chat IDE mới rồi gửi yêu cầu mới. [Chi tiết kiểm chứng](evidence/g4-native-response-completion-validation.md).

Adapter dùng cấu hình jetski.cloudCodeUrl trên **Antigravity IDE 2.5.5 / VS Code 1.107.0**, commit ecfbad74d93962fc8ca485d93ab9b4f3d4cb6cf8. Native chat và một vòng view_file đã được kiểm chứng trên IDE và Gemini Web thật ngày 15/10/2026. [Bằng chứng ban đầu](evidence/g4-native-provider-validation.md). Ở mốc revision 22, vòng browser/protocol mới đã PASS với caller tổng hợp; còn cần nghiệm thu UI/executor IDE lại.

## Chạy trên máy này

~~~powershell
cd D:\Antigravity-gemini-web
npm run build
npm run native:check
npm run native:launch
~~~

Lệnh launch khởi động proxy 127.0.0.1:9236, mở browser Gemini Web và **Gemini Web Native Test**. Profile IDE riêng: %USERPROFILE%\.gemini\antigravity-gemini-web-live\app_data\native-route\ide-profile. Lần đầu người dùng tự xác nhận workspace và đăng nhập Google. Thông tin đăng nhập không được sao chép từ IDE chính.

`npm run native:browser` mở/attach lại phiên Gemini Web của browser MCP bằng profile đã có khi cần kiểm tra riêng. Người dùng tự đăng nhập nếu cần. Account signed_in nhưng composer đang tải có thể tạm báo needs_user_action. Generation cũng tự mở lại browser đóng và chờ readiness trước khi gửi prompt; nếu cần đăng nhập, trả BROWSER_LOGIN_REQUIRED/HTTP 412, không submit và không tự gửi lại.

Trong cửa sổ **Gemini Web Native Test**, chọn **Gemini Web (Local)** ở menu model rồi gõ yêu cầu bình thường. Không cần yêu cầu agent gọi gemini_submit. IDE chính giữ cấu hình/model cũ.

## Tự kiểm tra tiếp trên máy này

Tạo fixture tổng hợp, không ghi đè file sẵn có:

~~~powershell
npm run native:g4:acceptance -- prepare
~~~

Để kiểm tra sửa file và executor thật, người dùng tự dán prompt sau vào native chat, rồi xử lý approval mà IDE hiển thị:

~~~text
Chỉ thao tác trong D:/Antigravity-gemini-web/.tmp/native-g4-acceptance.
Đọc read-me.txt bằng native tool.
Tạo result.txt chứa nguyên nội dung đó nối thêm _PATCHED, không thêm nội dung khác.
Sau đó dùng native run_command chạy:
node D:/Antigravity-gemini-web/.tmp/native-g4-acceptance/check.mjs
Báo nguyên văn kết quả test thực tế.
Không dùng công cụ MCP browser để gửi hộ và không sửa file ngoài thư mục fixture.
~~~

Sau khi native IDE đã hiện tool receipt cho thao tác đọc, ghi và chạy lệnh, kiểm tra file cùng test độc lập:

~~~powershell
npm run native:g4:acceptance -- verify
~~~

Kết quả command do native executor chạy cần có `AG_NATIVE_TEST_PASS`; script verify độc lập kiểm tra byte file chính xác và chạy lại checker local. Chỉ câu trả lời của model ghi PASS chưa đủ; cần receipt tool và file thực tế. Ca này hiện chưa nghiệm thu. Fixture là dữ liệu tổng hợp dành riêng cho kiểm tra.

Nếu proxy còn chạy bản cũ: khi generation đang rảnh, chạy `npm run native:stop`, rồi `npm run native:launch`. Native backend yêu cầu maxPromptChars=28000 cho từng tin Web (context native đầy đủ tối đa 262144 ký tự được tự chia đoạn), cùng freshConversationSupported, retainedConversationSupported, progressStreamingSupported và conversationUrlCheckpointSupported. Fingerprint browser runtime hiện là 22; cấu hình không khớp bị từ chối thay vì dùng nhầm runtime cũ. Sau launch bản build mới, `npm run native:status` phải báo `runtimeRevision: 30`, `catalogModel: custom-antigravity-gemini-web` và `contextModelSelection: { model: "3.8 Flash" }`.

CLI mặc định chỉ dùng **3.8 Flash cho bước nạp context đầy đủ ban đầu**. Bước này chỉ được trả ACK chính xác. MCP lưu model/Thinking level chính, chuyển sang 3.8, rồi khôi phục model chính trước khi COMMIT được gửi. Patch/follow-up dùng model chính. Model chính vẫn theo lựa chọn trên Web hoặc model policy đã cấu hình cho router; không được đổi sang model khác nếu 3.8 không khả dụng. Để tắt staging riêng, đặt `$env:AG_NATIVE_CONTEXT_MODEL = 'off'` trước khi start/launch; có thể cấu hình tên khác bằng biến này hoặc effort nạp context bằng `AG_NATIVE_CONTEXT_EFFORT`.

Nếu khôi phục model bị ngắt, metadata nhỏ được giữ ở state của worker và chặn Send mới. Mở browser để khôi phục đúng model trên cùng account, không phát lại request cũ; metadata hỏng hoặc account khác vẫn bị chặn. Google đưa browser sang `/sorry/index` thì người dùng cần hoàn thành xác minh trực tiếp, quay lại Gemini rồi mới tiếp tục. Không tự xử lý hoặc né bước xác minh. Ngày 18/10 bản context revision 30 (có trong source 33) còn chờ nghiệm thu live; runtime 29 đang giữ cửa sổ xác minh, chưa restart để tránh đóng cửa sổ đó. Xem [bằng chứng context model](evidence/g4-native-context-bootstrap-model.md).

## Luồng

### Chat IDE mới dùng chat Gemini mới

Mỗi `conversationId`/`conversation_id` khác nhau tạo một khóa task và một chat Gemini Web mới, kể cả khi IDE giữ nguyên `sessionId`. ID được đọc từ envelope hoặc request, dạng camelCase/snake_case. Các lượt tiếp theo trong đúng chat IDE vẫn dùng chat Gemini đó và cập nhật context bằng revision.

Nếu kết quả một lượt chưa rõ, chỉ chat IDE có cùng định danh bị chặn để tránh gửi lại prompt có thể đã được Gemini nhận. Chat IDE mới không kế thừa hàng rào đó. `native:resume` gắn với chat cũ cũng không chặn chat mới; lượt của chat mới dùng chat Gemini mới, còn lệnh resume vẫn dành cho đúng chat cũ. Ngoại lệ là `--next-turn`: lựa chọn này chủ ý gắn URL vào request native kế tiếp, nên hãy chỉ dùng khi request kế tiếp thuộc chat IDE cần tiếp tục.

### Tiếp tục cuộc trò chuyện Web đang có

Bản build **native revision 12 / browser fingerprint 10** giữ metadata hội thoại để tự gắn lại đúng tab sau khi proxy khởi động lại. Nếu metadata hết hạn, tab đã đóng hoặc không thể xác minh đúng URL thì gửi lỗi, không tự tạo tab mới cho lượt đó. Lệnh `native:resume` vẫn dùng khi người dùng muốn chỉ định rõ một URL khác.

1. Mở đúng cuộc trò chuyện từ lịch sử Gemini trong browser profile riêng của bridge. Chỉ để **một tab** mang link đó; chờ Gemini dừng và giữ ô soạn thảo trống. Sao chép link dạng `https://gemini.google.com/app/CONVERSATION_ID`.
2. Nếu proxy còn biết task hiện tại:

   ```powershell
   npm run native:resume -- --url "https://gemini.google.com/app/CONVERSATION_ID"
   ```

   Sau restart, dùng `--next-turn` để cho phép gắn **request IDE mới kế tiếp** vào cuộc trò chuyện đã chọn:

   ```powershell
   npm run native:resume -- --url "https://gemini.google.com/app/CONVERSATION_ID" --next-turn
   ```

3. Trong đúng chat IDE cần tiếp tục, gửi một follow-up mới. Không bấm retry lượt lỗi cũ. Lệnh resume chỉ đăng ký liên kết trong 5 phút, không tự Send. Không gửi yêu cầu từ task khác trong lúc đăng ký `--next-turn`.

Hủy đăng ký bằng `npm run native:resume -- --clear`. `native:status` có `resumeArmed`; không xuất URL cuộc trò chuyện. Với đúng chat đã gắn resume, hết hạn, tab mất/trùng, draft chưa gửi hoặc generation còn chạy sẽ trả lỗi, không fallback sang tab mới. Chat IDE khác vẫn bắt đầu chat Gemini riêng.

Lần nối lại gửi một full snapshot để xác lập quyền/context hiện tại **trong cùng chat Web**; các lượt sau dùng append/patch như thường. Không tự thực thi lại tool call cũ. Tab được người dùng chỉ định không bị đóng bởi cleanup riêng của lease. Nếu không xác nhận được Stop, bridge chặn thao tác tiếp và người dùng cần dừng tab đó. Việc thoát toàn bộ browser do ứng dụng sở hữu vẫn có thể đóng cửa sổ.

Khi nâng từ bản cũ, **lưu link chat trước khi stop/restart**: bản cũ có thể đóng tab trong cleanup. Sau khi reload native/MCP, mở lại link từ lịch sử trong browser riêng rồi dùng lệnh trên; đây vẫn là cùng cuộc trò chuyện Web. [Bằng chứng fixture và giới hạn live](evidence/g4-native-existing-conversation-validation.md).

~~~text
Chat native / executor IDE
 → proxy local nhận Cloud Code request
 → canonical system/context/history/tool declarations đầy đủ
 → browser MCP, một owned tab cho mỗi native task
 → full context đầu phiên, append/patch có revision ở lượt tiếp theo
 → JSON phản hồi có nonce riêng
 → native text stream hoặc functionCall đã kiểm tra đầy đủ
 → IDE thực thi công cụ theo quyền hiện hành
 → functionResponse trong request kế tiếp
 → Gemini Web tiếp tục trả lời
~~~

Proxy chỉ phát functionCall cho tool và schema được IDE cấp trong request hiện tại. Native executor đọc/sửa file và chạy công cụ; proxy không có executor filesystem/shell riêng.

Revision 12 giữ canonical context trong RAM và metadata hội thoại riêng tư trên đĩa. Cache chỉ lưu task ID đã băm, conversation key, revision/hash, URL Gemini và dấu reservation chưa có kết quả; không lưu prompt, lịch sử tool/file hay cookie. Dữ liệu ổn định hết hạn sau 30 ngày. Trước browser operation, proxy ghi reservation băm nguyên tử; nếu restart xảy ra khi chưa biết Send đã được nhận chưa, task bị quarantine và yêu cầu `native:resume` tường minh. Sau restart với checkpoint ổn định, request mới gắn vào cùng URL bằng một full snapshot, rồi các lượt sau quay về append/patch. Nếu request trùng đúng revision đã hoàn tất trước khi proxy restart, trả `OUTCOME_UNKNOWN` để tránh gửi lặp. Các lỗi ở checkpoint/model selection chỉ giữ base khi delivery được xác nhận `not_sent` và snapshot vẫn khớp; sau khi Send đã bắt đầu, kết quả không chắc chắn sẽ không tự retry.

Append/patch vẫn được dựng và kiểm tra khôi phục đúng trên bản đầy đủ. Revision 14 rút ngắn mô tả dài của mọi tool và mô tả thuộc tính trong JSON Schema trên đường truyền (giới hạn lần lượt 320/220 ký tự); schema gốc đầy đủ vẫn dùng để validate bằng Ajv. Revision 15 bổ sung nhận dạng ID hội thoại camelCase/snake_case và tách chat IDE mới khỏi hàng rào kết quả chưa rõ của chat cũ. Nội dung lịch sử và chỉ thị không bị cắt. `toolDescriptionCharsSaved` đo số ký tự mô tả đã giảm, không phải token/quota. Batch mặc định tắt; nếu IDE/process môi trường nhận `AG_NATIVE_BATCH_TOOL_CALLS=1` trước khi native proxy khởi chạy, ở revision 22 cho phép 2–8 lệnh `view_file`, `list_dir`, `grep_search` độc lập trong `ANY`/`AUTO`/`VALIDATED`, với schema hợp lệ và tham số không trùng. `native:status` hiển thị `batchToolCallsEnabled`; không batch ghi/sửa/chạy lệnh. Hỗ trợ batch mới ở proxy; khả năng IDE thực thi nhiều functionCall trong một phản hồi chưa được nghiệm thu live.

Kiểm tra tiết kiệm context **không dùng quota**: `node tools/probes/native-context-offline.mjs` sau build. Fixture 5 lượt giảm 78,77% ký tự gửi; không suy ra phần trăm quota Google. `native:status` có contextMode/contextReason/savedPromptChars/toolDescriptionCharsSaved để xem lượt thực tế. Các thay đổi revision 14 chưa nghiệm thu trên Web thật.

## Trạng thái và khôi phục

~~~powershell
npm run native:status
npm run native:cancel
npm run native:stop
npm run native:restore
~~~

Status trả counters/tên route, không trả credential hoặc prompt. Stop từ chối khi generation còn active và xác thực owner riêng. Restore gỡ giá trị adapter quản lý trong profile riêng, giữ sửa đổi không liên quan; endpoint bị sửa ngoài service gây CONFIG_CONFLICT.

Nếu IDE còn Working, thử Cancel của IDE. `npm run native:cancel` là đường dừng dự phòng: yêu cầu hủy các lượt đang chạy của proxy này, abort browser request và kết thúc SSE bằng terminal lỗi. Lệnh chờ tối đa 1,8 giây để nhận kết quả `gemini_cancel`; `browserStopConfirmed` phản ánh xác nhận DOM thật, còn `browserStopConfirmationPending` nghĩa là chưa có kết quả. Sau khi active về 0 mới dùng native:stop. Không cần kill IDE hoặc toàn bộ Chrome. Lượt bị mất kết quả không tự gửi lại; khi muốn thử lại, tạo yêu cầu mới một cách tường minh.

Lượt Working đã lỗi là terminal và không thể nhận SSE mới hồi tố hoặc tự gửi lại. Native runtime revision 14 không còn ép `4 Argon / Low`; proxy dùng lựa chọn model/effort đang hiện trên Gemini Web. Revision 19 tách ID của mục picker (`custom-antigravity-gemini-web`) khỏi enum `MODEL_PLACEHOLDER_M650`, chỉ advertises checkpoint khi có cấu hình đã kiểm chứng để tránh lookup placeholder cache không thuộc Gemini Web như `M36`, và bỏ metadata renderer ngoài contract trước khi kiểm tra nonce/tool/schema. Metadata đó không được đưa đến IDE executor; nonce đúng lượt, inventory hiện tại và Ajv schema gốc vẫn bắt buộc. Health sau khi nạp source hiện tại phải báo `runtimeRevision: 33`, `catalogModel: custom-antigravity-gemini-web` và `modelSelectionMode: user_selected_in_web`. Các lỗi startup được trả trước SSE; lỗi muộn hiển thị candidate có nhãn Gemini Web error rồi đóng stream, trong khi diagnostic vẫn failed. [Bằng chứng UI model menu từ revision cũ](evidence/g4-native-model-menu-validation.md). Revision 8 sửa BROWSER_TURN_FAILED khi tab gốc bị đóng: checkpoint vẫn bảo vệ tab task, cleanup không còn phụ thuộc tab gốc. [Bằng chứng](evidence/g4-native-retained-tab-validation.md).

Lượt người dùng báo bị treo ngày 16/10 đã gửi tới `streamGenerateContent` (HTTP 200), nhưng không nhận text trong 206 giây; lượt kết thúc `CANCELLED`, `delivery=unknown`, không tự gửi lại. Proxy cũ revision 13 trả `browserStopConfirmed=false` cố định nên không chứng minh được trang đã dừng. Source revision 14 sửa việc báo xác nhận này; chưa có live retest sau sửa.

Model và thinking level do người dùng chọn trực tiếp trên Gemini Web. Model xử lý chính theo lựa chọn đang hiện trên trang, hoặc policy rõ ràng của router. Ngoại lệ là bước staging context ban đầu dùng 3.8 Flash rồi khôi phục model chính trước COMMIT; xem phần model context bên trên. Hãy chọn model/effort trước khi gửi prompt; nếu trang đang bận, chưa đăng nhập hoặc chưa sẵn sàng thì proxy từ chối trước Send. AG_NATIVE_STALL_TIMEOUT_MS mặc định 300000; AG_NATIVE_MAX_DURATION_MS mặc định 1800000, tối đa 1800000. Giữ progress không vượt hard limit; heartbeat không được tính là model progress.

`node tools/probes/native-stream-smoke.mjs` chỉ xem metadata. Thêm `--live` gửi dữ liệu fixture tổng hợp sang Google, thử full/delta và owner cancellation, ghi metadata vào docs/evidence/mcp/native-latency-live.json. Probe này gọi protocol loopback, không thay kiểm thử bấm Cancel trong IDE thật.

`node tools/probes/native-autostart-smoke.mjs --live` gửi một prompt tổng hợp để kiểm tra browser readiness và phản hồi. Metadata ghi cả trạng thái CDP trước khi gửi; chỉ trường hợp trước đó không reachable mới là bằng chứng cold startup. Không có `--live` thì chỉ đọc health. Probe không thao tác native tools hay chứng nhận native UI.

## Ranh giới

- Adapter thử nghiệm cho đúng build IDE đã kiểm tra, chưa installer/G5. Gate native tổng quát trong launcher/MCP cũ vẫn thận trọng; xem bằng chứng native riêng.
- Nhận text và lịch sử native function. Attachments/image/file URI bị từ chối, không cắt ngầm context. Cap local là 262144 ký tự prompt đầy đủ, không phải cam kết context window Google.
- Catalog dùng 100000 làm giá trị tương thích bộ kiểm tra checkpoint IDE 2.5.5. Model/effort UI được xác minh; quota, context window và compaction live chưa được đo.
- Text của nonce-bound final envelope được stream khi DOM cập nhật; không phải token stream trực tiếp từ API Google. Tool call chờ response hoàn chỉnh và validation.
- Chỉ model Gemini Web (Local) được xử lý generation. Model khác, kể cả tác vụ phụ đặt tên chat của IDE, bị từ chối thay vì fallback sang Google API. Metadata ngoài allowlist có thể báo 404, gồm ACL/analytics chưa hỗ trợ.
- Sign-in và metadata đi tới Cloud Code chính thức bằng credential IDE. Credential không đi vào prompt Gemini Web hoặc endpoint tùy ý.
- Tab task được giữ tối đa 5 task; resume yêu cầu revision/transcript/model không đổi. Tab gốc/draft được giữ. Không có task ID thật thì dùng full-context fresh tab. Restart hoặc mất kết quả không tự gửi lại.
- Reverse custom MCP connector của Google vẫn độc lập và chưa kết nối. Đường native này trả functionCall trực tiếp cho executor, không phụ thuộc connector đó.

Tham khảo: [antigravity-add-model, fc5b91a](https://github.com/vahapogut/antigravity-add-model/tree/fc5b91a17125bf91bd59f3c1ab065aa58e6c0829), [license](../THIRD_PARTY_NOTICES.md).


## Tài khoản riêng và xác minh danh tính (revision 23)

```powershell
npm run native -- accounts
npm run native -- account:browser "Default Account"
# Đăng nhập thủ công trong đúng cửa sổ profile, sau đó:
npm run native -- account:verify "Default Account"
npm run native -- account:add "Secondary Account"
npm run native -- account:browser "Secondary Account"
# Sau khi đăng nhập tài khoản thứ hai:
npm run native -- account:verify "Secondary Account"
npm run native -- account:use "Secondary Account"
```

`account:browser` mở profile được chỉ định, không đổi lựa chọn đang phục vụ chat. `account:verify` không gửi prompt; nó kiểm tra email quan sát được và đăng ký fingerprint cho profile chưa xác minh. Profile đã gắn tài khoản khác bị từ chối; dùng profile riêng cho tài khoản khác. Account thiếu email quan sát được vẫn là unverified. `account:check` và `accounts` báo identityRegistered; health báo lần verify cùng observedAt, không dùng sự hiện diện của fingerprint để nhận là đang verified.

Worker native kiểm tra đúng profile tại cổng CDP và kiểm tra đúng account trước click Send. Cổng được cấp phát trong registry chưa có nghĩa là cổng trống trên OS; browser khác chiếm cổng phải bị từ chối. Sau nâng cấp source mới cần runtime revision 27 và browser worker fingerprint 19; runtime cũ không được dùng để gửi âm thầm.

Đổi/disable/enable bị từ chối khi generation hoặc verify đang chạy. Owner API hỗ trợ expectedRevision để chặn lựa chọn cũ. CLI dùng cùng owner API khi proxy đang chạy. Disable tài khoản cuối cùng giữ registry hợp lệ và profile/lịch sử; có thể enable lại qua CLI.

Cùng một request đã reserve hoặc gửi không được phát lại sau đổi account/restart. Ledger `native-turn-ledger/` chỉ giữ IDs/hash/account/phase/attempt, không lưu prompt hay kết quả. Chỉ delivery=not_sent mới cho phép thu hồi reservation. Không xóa ledger để xử lý lỗi. Metadata conversation v1 được backup thành `.v1.backup` trước migrate v2; phiên bản cũ phải dừng thay vì ghi đè metadata mới.

Nếu chat cũ có outcome_unknown, chọn lại tài khoản gốc, kiểm tra hội thoại trong profile đó, arm `native:resume` với URL chính xác và gửi follow-up mới trong đúng chat IDE. Không retry request cũ. Legacy metadata thiếu account không tự được gán cho account mới.

Nếu writer chết và để lại `accounts.json.lock`, registry dừng mutation với ACCOUNT_REGISTRY_BUSY. Kiểm tra PID trong lock và dừng các writer trước khi xử lý lock; không xóa một lock đang có owner sống. Tự phục hồi lock sau crash còn thuộc P8.

Nghiệm thu bằng caller tổng hợp và Web thật (chỉ dữ liệu test):

```powershell
node tools/probes/native-account-handoff-smoke.mjs --live '--account=Default Account' '--account=Secondary Account' '--account=Default Account' --output=docs/evidence/mcp/native-r23-account-handoff-live.json
```

Script kiểm tra marker, tool call, functionResponse và base context, rồi khôi phục lựa chọn account ban đầu. Đây không phải bằng chứng executor IDE đã đọc/sửa/chạy lệnh.


Revision 24 thêm trace context theo từng tin Web. Trường `lastTurn.transportTrace` trong health chỉ chứa số lượng/hash, kết quả readback và trạng thái Send/ACK. Xem [P3 context spike](evidence/g4-native-p3-context-transport-spike.md); revision 25 có contract và luồng upload native thử nghiệm, vẫn tắt mặc định. `AG_NATIVE_ATTACHMENT_TRANSPORT=1` chỉ bật khi khởi động runtime mới; health báo `snapshotAttachmentExperimental`. Các snapshot native 78k/145k/261k đã upload/Send nhưng không trả được tool call hợp lệ, nên chưa đạt gate live. Probe `node tools/probes/native-snapshot-matrix.mjs --live` dùng proxy tạm và dữ liệu tổng hợp, rồi khôi phục cấu hình owner cũ. Không gửi lại hoặc đổi model/account tự động khi lỗi.

## Physical receipt store từ revision 26

Browser MCP mới cần Node 22.13+ trong nhánh 22.x hoặc Node 24+ để dùng SQLite tích hợp. Khi worker 18 nạp lần đầu, `receipts.json` v1 được migrate sang `receipts.json.sqlite`; byte gốc nằm ở `receipts.json.v1.backup`, còn đường dẫn JSON trở thành marker version 2. Không xóa/khôi phục file backup để làm trống lịch sử: runtime cũ phải từ chối marker, và backup cũ không chứa các receipt phát sinh sau migration. Store mới giữ toàn bộ ID để chống replay; chỉ cache câu trả lời trong RAM bị thu hồi. Health MCP mới báo `receiptStore: sqlite_wal_v2`, `maxRequestIdentities: null`.

Sau khi đã nạp revision 26, có thể kiểm tra metadata một lượt bằng owner API qua CLI:

```powershell
npm run native -- receipt 'native_<64_hex_request_id>'
```

Lấy request ID từ diagnostic `lastTurn.requestId`. Lệnh này đọc logical/physical receipts của account và identity epoch gốc, không gửi prompt, không mở Chrome và không xóa fence. Receipt terminal không thay thế câu trả lời bị mất hoặc xác nhận executor đã chạy tool. Metadata cũ thiếu correlation được đánh dấu chưa đối chiếu; receipt thiếu cũng không cho phép gửi lại.

Đợt nghiệm thu local ngày 16/10 chỉ migrate bản sao 135 receipt đang dùng; ngày 17/10 ledger thật đã migrate và giữ đủ 135 receipt gốc. Source 31 có router thử nghiệm và failover hữu hạn; HTTP + MCP + SQLite fixture đã pass, chưa nghiệm thu hai account Web thật. Runtime chính vẫn revision 29/manual, upload và failover tắt, đang giữ cửa sổ Google để người dùng xác minh. Xem [P4 ledger](evidence/g4-native-p4-physical-ledger.md) và [failover](evidence/g4-native-p4-failover.md) để phân biệt source/build/fixture với runtime đang chạy.

Cập nhật 17/10: runtime cũ đã dừng (PID không tồn tại và cổng từ chối kết nối). Bản revision 26 đã khởi động lại bằng CLI thường, xác minh Default Account không Send; migration ledger thật 135 receipt và kiểm tra SQLite read-only đã pass. Upload thử nghiệm vẫn tắt. [Bằng chứng mới](evidence/mcp/native-r26-ledger-live-inspection.json). Đây không phải nghiệm thu native tool loop hoặc hai tài khoản thật.

## Router thử nghiệm từ revision 27

Runtime live ngày 17/10 hiện là revision 27 / worker 19, mode manual, cờ router tự động và upload đều tắt. `npm run native -- routing` đọc cấu hình/lease qua owner API. Có thể trở về lựa chọn tay bằng `npm run native -- routing:set manual` khi idle.

Sticky/priority yêu cầu runtime được bật `AG_NATIVE_ROUTER_EXPERIMENTAL=1` trước khi khởi động và cấu hình model/effort chính xác từ Web. Round robin còn cần `--round-robin-opt-in`. Không bật các chế độ này chỉ dựa vào trạng thái identityRegistered. Model được kiểm tra trước Send; không âm thầm thay model hoặc gửi lại trên account khác. `routing:unbind` chỉ xóa affinity của router; không xóa context, receipt hoặc hàng rào outcome unknown.

Một account chỉ có một lease; cùng chat IDE phải chờ lượt trước, hai chat độc lập có thể dùng hai worker trong chế độ thử nghiệm. Lease vẫn giữ khi HTTP đã hủy nhưng backend chưa kết thúc. Tại revision 27 chưa có failover; source 31 về sau đã có failover hữu hạn, mặc định tắt, chỉ khi có bằng chứng chưa Send và chưa nghiệm thu hai account Web thật. [Bằng chứng, câu lệnh và các gate còn mở](evidence/g4-native-p4-routing.md).

## Quản lý tài khoản trong launcher (source 32)

Sau khi proxy mới được nạp, chạy `npm run launcher` rồi mở **Tài khoản Web**. Profile mới được owner cấp đường dẫn; mở profile để đăng nhập, kiểm tra danh tính rồi chọn cho lượt sau. Trong mode tự động, tài khoản phục vụ do routing policy quyết định. Màn hình đọc trạng thái khi có lượt đang chạy và khóa thay đổi cho đến khi backend thực sự kết thúc. Danh tính vừa kiểm tra không phải chứng nhận model/suy luận IDE sẵn sàng.

`npm run native -- accounts:status` đọc cùng snapshot có schema qua owner API. `account:add` khi proxy chạy cũng đi qua owner; custom `--profile/--state/--port` chỉ dùng khi proxy đã offline. Nếu đang chạy runtime cũ, cập nhật sau khi lượt và thao tác xác minh hiện tại kết thúc; launcher không tự restart proxy. [Bằng chứng và gate còn lại](evidence/g4-native-p5-account-management.md).

## Cache hết hạn và phục hồi (source 33)

Cache Native/MCP tối đa 32 kết quả, TTL 10 phút. Source 33 kiểm tra hết hạn cả khi chỉ đọc health/status/result/receipt; ledger bền vững và replay fences vẫn giữ nguyên. Không dùng retry để lấy lại kết quả đã hết cache. Xem [runbook khôi phục](NATIVE_RECOVERY_RUNBOOK.md); backup/repair/rollback binary và nghiệm thu Web/IDE còn gate riêng.
