# Khôi phục Native Gemini Web

Tài liệu vận hành cho source Native **38 / browser worker 24**, gồm các thủ tục từ source 33 về sau. Đây là một phần P8; chưa chứng nhận toàn bộ migration, rollback, Windows restart hoặc soak. Đối chiếu [kế hoạch](NATIVE_UPGRADE_PLAN.md), [P4 ledger](evidence/g4-native-p4-physical-ledger.md) và [P5](evidence/g4-native-p5-account-management.md) trước khi kết luận hệ thống đã nghiệm thu.

Source 37 có [tùy chọn semi-space Node](NATIVE_NODE_MEMORY.md), mặc định tắt. Khi bật, worker phải xác nhận đúng startup flag; config conflict không được xử lý bằng tự động kill worker, xóa profile/fences hoặc replay request. Thay cấu hình cần quy trình dừng/khởi động khi nhàn rỗi. Giữ cửa sổ Google đang chờ người dùng xác minh.

Source 38 có [preview ZIP nhập lịch sử](NATIVE_CHAT_IMPORT.md), mặc định tắt. Job chỉ sống trong RAM, tối đa tám preview, một worker và TTL 15 phút theo đồng hồ monotonic. Hủy/đổi tài khoản vẫn giữ slot cho đến khi worker thật thoát; shutdown đợi worker tối đa năm giây và báo lỗi nếu còn pending. Sau proxy restart cần chọn lại file, không phục hồi hay tự gửi archive. Xóa preview chỉ bỏ metadata, không xóa ZIP gốc. Chưa có upload/receipt nhập Google; không diễn giải preview `ready` thành import thành công.

## Đọc trạng thái trước khi thay đổi

Chạy từ thư mục repo trong PowerShell:

```powershell
npm run native:status
npm run native -- accounts
npm run native -- accounts:status
npm run native -- routing
```

`native:status` cho biết revision/PID, lượt đang hoạt động, leases, account và phase gần nhất. `accounts:status` cần runtime có management API từ revision 32; lỗi khi đang chạy bản cũ không phải bằng chứng cần xóa dữ liệu. Không suy ra browser đã dừng chỉ từ `counters.active=0`: lease có thể còn giữ cho một thao tác backend đang kết thúc.

Mục **Tài khoản Web** của launcher dùng owner API hiện có. UI hết dữ liệu mới sẽ khóa thao tác. Với `CONFIG_CONFLICT`, `STALE_AUTHORITY` hoặc `OWNER_MISMATCH`, đọc lại trạng thái; không sửa revision/owner ID trong request để ép lệnh chạy.

## Chọn cách xử lý theo lỗi

| Lỗi/trạng thái | Hành động | Điều kiện để tiếp tục |
|---|---|---|
| `BUSY`, còn active lease | Chờ lượt hiện tại hoặc yêu cầu hủy bằng owner/IDE | Backend thực sự kết thúc; không chỉ HTTP đã đóng |
| `BROWSER_USER_ACTION_REQUIRED`, Google `/sorry/index` | Hoàn thành xác minh trực tiếp trong profile đang mở, quay lại Gemini | Kiểm tra lại danh tính; không tự gửi lại lượt cũ |
| `BROWSER_LOGIN_REQUIRED`, `LOGIN_REQUIRED` | Mở đúng profile và đăng nhập | `account:verify` đúng account, không chỉ avatar xuất hiện |
| `ACCOUNT_IDENTITY_CHANGED` | Đăng nhập lại identity đã đăng ký, hoặc tạo profile riêng cho tài khoản khác | Không ghi đè fingerprint của profile cũ để hợp thức hóa việc đổi account |
| `MODEL_UNAVAILABLE` | Kiểm tra model/effort đang chọn và policy router trên account đó | Dùng đúng model đã yêu cầu; không âm thầm đổi model xử lý chính |
| `MODEL_RESTORE_PENDING` | Mở lại browser trên cùng account để khôi phục model chính đã ghi trong journal | Model/effort đã khôi phục và journal được worker hoàn tất hợp lệ |
| `CONVERSATION_NOT_OPEN`, `CONVERSATION_CHANGED`, `REBIND_REQUIRED` | Kiểm tra đúng URL/account/tab và xem lịch sử trước khi nối | Dùng resume tường minh cho một request IDE mới |
| `CONTEXT_FRAGMENT_ACK_FAILED`, lỗi file processing | Ghi nhận phase/delivery; kiểm tra lượt trên Web | ACK không rõ không cho phép retry tự động hay đổi account |
| `OUTCOME_UNKNOWN`, mất kết nối sau Send | Tra receipt, kiểm tra Web và kết quả workspace | Không phát lại tool hoặc prompt cũ để “lấy lại kết quả” |
| `REQUEST_LEDGER_BUSY`, lock còn lại sau crash | Giữ lock và metadata; kiểm tra owner/process, dùng chế độ tra cứu | Chưa có lệnh tự động xóa lock hoặc tiếp tục attempt cũ |
| `REQUEST_LEDGER_UNAVAILABLE`, SQLite/metadata hỏng | Dừng mutation, giữ nguyên bộ file, tra bản sao đã kiểm chứng | Không thay bằng backup cũ nếu chưa chứng minh giữ đủ các fence mới hơn |

## Đăng nhập và chọn account

```powershell
npm run native -- account:browser "Default Account"
# Đăng nhập/xác minh trực tiếp trong cửa sổ vừa mở, sau đó:
npm run native -- account:verify "Default Account"
npm run native -- account:use "Default Account"
```

Đăng ký tài khoản khác bằng `account:add "Tên mới"`, mở và verify profile đó. Khi proxy đang chạy, `account:add` đi qua owner và tự cấp profile/state riêng. Custom `--profile`, `--state`, `--port` chỉ dùng lúc owner offline; không trỏ hai account vào cùng profile/state.

Kiểm tra danh tính chỉ có hiệu lực ngắn tại thời điểm kiểm tra, không phải chứng nhận model/IDE sẵn sàng. Giữ model chính đã chọn; 3.8 Flash chỉ là staging context ban đầu và phải được khôi phục trước COMMIT. Tắt staging không xóa hoặc vượt qua một model-restore journal đang chờ.

## Hủy và kết quả chưa rõ

```powershell
npm run native:cancel
npm run native:status
```

`browserStopConfirmed=true` là xác nhận từ backend. `false` hoặc `browserStopConfirmationPending=true` không chứng minh browser đã dừng. UI có thể đã đóng HTTP trong khi account vẫn bận. Nếu cần, kiểm tra nút Stop/lịch sử trong đúng tab Web; không đóng hoặc kill một Chrome không xác định ownership.

Tra logical request ID lấy từ lỗi/diagnostics, kể cả khi đã chọn account khác:

```powershell
npm run native -- receipt native_<64_hex_request_id>
```

Lệnh tra cứu không Send. Nó kiểm tra physical receipts theo account/identity epoch/attempt gốc, không theo account đang chọn. Sau restart hoặc hết TTL, kết quả RAM có thể không còn; receipt vẫn giữ `replayAllowed=false`. `resultAvailable=false` không cho phép gửi lại. Nếu có tool/mutation đã chạy, đọc file và output thật trong IDE trước khi tạo bước tiếp theo.

## Nối lại đúng hội thoại

1. Chọn account gốc và kiểm tra identity. URL từ A không được đem sang B để đoán rằng lịch sử đã chuyển.
2. Giữ đúng một tab đã dừng tại URL hội thoại trong profile đó; không để draft đang soạn bị ghi đè.
3. Đánh dấu nối cho chat hiện tại, hoặc cho request IDE mới kế tiếp sau restart:

```powershell
npm run native -- resume --url https://gemini.google.com/app/CONVERSATION_ID
# Sau restart, khi chưa có task scope hiện tại:
npm run native -- resume --url https://gemini.google.com/app/CONVERSATION_ID --next-turn
# Bỏ đánh dấu nếu đã chọn nhầm:
npm run native -- resume --clear
```

Gửi một yêu cầu **mới** trong chat IDE dự định nối; khi dùng `--next-turn`, không gửi đồng thời từ chat IDE khác. Resume không phát lại request cũ, không phục hồi nguyên văn toàn bộ context RAM sau restart và không vượt fence của một kết quả chưa rõ.

Với sticky binding cần bỏ ghim, đọc task hash từ routing/diagnostics rồi chạy `routing:unbind <64_hex_task_scope>`. Bỏ ghim không xóa lịch sử hay replay fence. Một identity epoch đã đổi cần xử lý tường minh; không tự sửa entry để tái sử dụng cache cũ.

## Cache đầy hoặc hết hạn

Native và MCP giữ tối đa 32 kết quả RAM, TTL 10 phút. Source 33 rút kết quả hết hạn ngay ở các đường đọc health/status/result/receipt liên quan; receipt bền vững vẫn được giữ. Đây là thu hồi kết quả, không phải xóa danh tính Send.

`QUEUE_FULL` với lượt thực sự đang hoạt động cần chờ hoặc hủy. `REQUEST_LEDGER_FULL` của Native là guard số identity trong phiên (65.536), khác store physical receipt SQLite đã bỏ trần 2.048. Khi idle và đã xác minh các thao tác kết thúc, restart cùng bản tương thích có thể giải phóng chỉ mục RAM; ledger bền vững phải giữ nguyên. Không xóa `native-turn-ledger` hoặc receipt database để giải phóng capacity.

## Lưu bản sao và lỗi dữ liệu

Native state nằm trong `%USERPROFILE%\.gemini\antigravity-gemini-web-live\app_data\native-route`. Mỗi account có `statePath` riêng, xem bằng CLI `accounts` trên máy.

Chỉ sao chép metadata khi các writer của những store đó đã dừng và ownership được xác minh. Bộ cần giữ gồm:

- Native: `accounts.json`, `routing.json`, `native-model-identity.json`, `native-conversation-cache.json` cùng `.v1.backup` nếu có, toàn bộ `native-turn-ledger` và các lock còn lại.
- Trong từng account `statePath`: `receipts.json` marker, `receipts.json.sqlite`, WAL/SHM nếu còn, `receipts.json.v1.backup`, và `receipts.json.model-restore.json` nếu có.
- Lưu checksum và revision/fingerprint cùng bản sao, trong thư mục riêng tư ngoài repo. Không gom Chrome profile/cookie, `proxy-owner.json` chứa control token, hoặc credential IDE vào bản sao metadata chia sẻ.

Không copy riêng file `.sqlite` trong khi writer vẫn chạy rồi coi đó là bản backup nhất quán. Không xóa WAL, marker hay lock để “sửa” lỗi. Metadata hỏng hoặc fence thiếu phải được điều tra trên bản sao; chưa có workflow tự động merge/restore/repair được nghiệm thu cho mọi lỗi này.

File snapshot upload tạm có lease `gemini-native-snapshot-*` trong temp và có thể còn cần cho File API. Không dọn chỉ vì ACK đã về, hoặc chỉ vì PID ghi trên lease không còn. Chỉ dọn sau khi xác minh generation/Stop/owned target đã kết thúc và đúng đường dẫn lease; cleanup orphan sau crash chưa được nghiệm thu đầy đủ.

## Rollback bằng cấu hình hiện tại

Ưu tiên tắt tính năng bằng bản đọc được schema hiện tại, giữ tất cả fence. Khi idle:

```powershell
npm run native -- routing:set manual
npm run native -- routing
npm run native:stop
# Chỉ sau khi đã kết thúc thao tác/đăng nhập/xác minh đang cần giữ:
$env:AG_NATIVE_ROUTER_EXPERIMENTAL = '0'
$env:AG_NATIVE_ATTACHMENT_TRANSPORT = '0'
$env:AG_NATIVE_BATCH_TOOL_CALLS = '0'
# Nếu cần tạm bỏ staging riêng, vẫn giữ model chính và restore journal:
$env:AG_NATIVE_CONTEXT_MODEL = 'off'
npm run native:start
npm run native:status
```

Đưa router về manual trước khi bỏ cờ experimental; nếu giữ cấu hình auto rồi tắt cờ, generation cố ý báo lỗi thay vì tự đổi policy. Startup flags không làm mất result fences và không phục hồi model-restore journal bằng cách bỏ qua nó.

Không checkout/start một bản cũ chưa chứng minh hiểu ledger hiện tại. Logical ledger có v1/v2, physical store SQLite v2 và các journal có phiên bản riêng; một bản cũ chỉ có cache RAM có thể không giữ được các fence mới. [Cold restore và rollback module 36 ↔ 37](evidence/g4-native-p8e-baseline-recovery.md) đã PASS trên state fixture riêng, có WAL sau crash, chặn backup cũ/ảnh hỏng và giữ deadline/lịch sử attempt v2. Chat chưa rõ kết quả vẫn cần Resume tường minh; request cũ không được phát lại. Đây chưa phải nghiệm thu rollback stdio/shared-owner/browser hoặc dữ liệu production, không phải công cụ merge/repair tự động. Các baseline khác và rollback đầy đủ vẫn là gate P8.

## Nguồn tham chiếu dự án (source 35)

`npm run native:knowledge` hoặc màn hình **Nguồn dự án** đọc source/binding metadata; không gửi prompt. CLI vẫn cần native owner hợp lệ. Hủy chooser không tạo nguồn, không tự mở lại dialog và không import lại. Lỗi/mất kết nối/owner thay đổi khóa source mutations cho đến khi có status mới; không đổi sang demo hoặc tự tạo worker.

Với `SOURCE_STALE`/commit đổi, kiểm tra file thực tế rồi chấp nhận snapshot mới bằng `knowledge:refresh SOURCE_ID` hoặc nút **Chấp nhận bản local mới**. Dirty/untracked Git overlay cần chọn tường minh qua CLI. Đây là cập nhật nguồn cho các lượt mới, không phải lý do retry lượt cũ hoặc bỏ hàng rào unknown.

`SOURCE_STILL_BOUND` yêu cầu bỏ từng binding tương ứng trước `knowledge:remove`; remove chỉ xóa metadata và giữ file. Registry metadata có root/relative paths và IDs riêng tư, không chia sẻ nguyên bản. Source 35 kiểm tra lại path/repository/URL khi đọc registry để không đưa metadata bị sửa sai qua IPC.

Với registry/lock hỏng, giữ nguyên file/journal để kiểm tra khi owner đã idle theo quy trình backup phía trên. Không xóa lock đang sống, ledger hoặc conversation cache để vượt lỗi. Có thể tạm tắt `AG_NATIVE_KNOWLEDGE_EXPERIMENTAL` ở lần cập nhật owner lúc idle; core tiếp tục với context IDE. Thao tác đó không xóa nguồn hoặc lịch sử Web. Không restart cửa sổ Google đang chờ xác minh chỉ để sửa nguồn.

Chi tiết CLI, UI, redaction và ranh giới file tạm P3: [NATIVE_KNOWLEDGE.md](NATIVE_KNOWLEDGE.md).

## Pool cleanup và giới hạn metadata (source 36)

`npm run native:status` trên source 36 trở lên có `backendResources`: lifecycle pool, số cached backend handles, conversation ownership, pending releases và account đang drain. Đây không phải số process Chrome, RAM hay chứng nhận tất cả tab đã đóng. Các giới hạn hiện tại: 32 cached handles, 256 ownership entries, 256 pending releases/account. Chúng là hard bounds, không phải mục tiêu RAM cho máy hoặc cơ chế tự evict worker đang nhàn rỗi.

Bound cleanup đi qua cùng hàng chờ của pool. BUSY được giữ cho đúng account và drain khi owner đó chuẩn bị/kết thúc generation tiếp theo; hoạt động account khác không dọn nhầm. Yêu cầu preserve=true đang pending không bị retry false hạ xuống. Cleanup lỗi không bị đổi thành bằng chứng chưa Send nếu generation đã bắt đầu.

`RESOURCE_LIMIT` khi admission/new conversation bị chặn cần kiểm tra queue và trạng thái backend. Không xóa request ledger, unknown fences hoặc model/upload journals để lấy lại chỗ. Nếu queue không tiến triển, kiểm tra Stop/receipt/phiên Web đúng owner theo các phần trên rồi cập nhật runtime lúc idle theo quy trình sẵn có. Shutdown thất bại vẫn báo lỗi; gọi close lần nữa không biến lần thất bại thành success. Pool đã đóng không được tái sử dụng; owner mới dùng instance mới và giữ durable fences.

Probe Node-only cho thấy ownership leak đã được sửa, nhưng RSS/heap samples không chứng nhận memory budget nhiều MCP/Chrome thật. [Evidence P8a](evidence/g4-native-p8a-pool-lifecycle.md). Runtime chính revision 29 chưa có diagnostics mới; tiếp tục giữ cửa sổ Google đang xác minh.

## Ghi nhận một lần khôi phục

Ghi source revision/worker fingerprint, owner PID/instance, account ID/epoch, request/attempt IDs, code/phase/delivery, Stop có xác nhận hay không, receipt lookup và kết quả kiểm tra file thật. Tách rõ fixture, Web thật và executor IDE thật. Không đưa prompt, cookie, token, raw model reply hay email account vào evidence công khai.
