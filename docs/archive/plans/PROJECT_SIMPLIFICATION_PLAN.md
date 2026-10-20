# Kế hoạch tinh gọn Antigravity Gemini Web

Ngày rà soát: 20/10/2026. Source native revision 44, browser worker fingerprint 26.

## 1. Mục tiêu và phạm vi

Sản phẩm phục vụ một luồng: chat trong Antigravity IDE, dùng Gemini Web trong các hồ sơ Chrome cá nhân đã ghép extension. Launcher có đúng ba màn hình, giao diện sáng:

1. **Tài khoản:** thêm, ghép, xác minh, chọn, tạm ngưng, xóa.
2. **Đoạn chat:** xem trạng thái hội thoại đã lưu, tài khoản phục vụ, URL Web và trạng thái tiếp tục; hủy lượt hoặc nối lại khi đủ điều kiện.
3. **Kết nối:** xem trạng thái launcher, native owner, connector của từng tài khoản và hoạt động IDE quan sát được.

Kế hoạch đã được người dùng duyệt và đang thực hiện trong revision 45 / worker 27. Phần phát hiện bên dưới giữ nguyên mốc review revision 44. Kết quả thực hiện và giới hạn hiện hành được ghi ở [báo cáo triển khai](../../evidence/simplification-r45.md). Working tree có nhiều thay đổi chưa commit từ các đợt trước.

Không lấy số bài test từng PASS làm bằng chứng rằng phiên bản hiện tại chạy được chat thật. Lần review này không chạy lại suite, không gửi prompt, không khởi động lại ứng dụng.

## 2. Những phần rườm rà và vấn đề đã xác minh

### F1 — Cao: Hai nguồn trạng thái khiến các màn hình không nhất quán

- `apps/launcher/src/main/index.ts:74` tạo `RuntimeFacade`; dòng 90 tạo thêm `NativeOwnerClient`.
- `packages/runtime/src/runtime-facade.ts:65` vẫn tạo adapter Chrome do bridge quản lý; dòng 67 dùng `FakeRuntimeEngine` cả trong chế độ live.
- `packages/runtime/src/fake-runtime.ts:95` khởi tạo live snapshot với browser đóng, tài khoản unknown, integration unverified và sessions rỗng.
- `packages/native-antigravity/src/index.ts:28` có `LiveNativeAntigravityAdapter.checkStatus()` luôn trả về `unverified`, không đọc native owner thật.
- Kết nối và thanh trạng thái dùng snapshot của runtime cũ. Tài khoản dùng native management. Đoạn chat dùng cả hai.

**Hệ quả:** trạng thái connector/account ở trang Tài khoản không cập nhật trực tiếp các thẻ Kết nối. Bấm làm mới snapshot cũ không tự biến adapter stub thành kiểm tra native thật. Danh sách session cũ cũng không phải danh sách hội thoại của native proxy.

**Đề xuất:** native owner là nguồn dữ liệu chính cho tài khoản, chat và connector; sức khỏe Electron/IPC là trạng thái riêng. Chỉ báo IDE hoạt động khi có quan sát thực tế, kèm thời điểm; không đổi mọi `unverified` thành xanh.

### F2 — Cao: “Bỏ Chrome riêng” mới hoàn thành ở form tạo tài khoản

- `NativeAccountsView.tsx` đã chỉ gửi `browserTransport: "extension"`.
- `packages/native-antigravity/src/native-cli.ts:21` vẫn gọi `ensureDefault()` khi lấy registry.
- `packages/native-antigravity/src/account-registry.ts:146` tạo `Default Account` nếu danh sách rỗng, không khai báo extension transport.
- `packages/native-antigravity/src/native-cli.ts:312` vẫn có launch flow gọi mở browser và thông báo đăng nhập trình duyệt riêng.
- MCP CLI và backend pool còn fallback transport `cdp`.

**Hệ quả:** xóa hết tài khoản rồi chạy đường CLI/start có gọi `getRegistry()` có thể tạo lại tài khoản mặc định. Giao diện và khởi động chưa cùng một mô hình sản phẩm.

**Đề xuất:** registry rỗng là trạng thái hợp lệ; người dùng thêm hồ sơ extension đầu tiên. Bỏ mặc định tạo Chrome riêng, cập nhật launch và CLI. Tài khoản CDP cũ cần quy trình xử lý rõ ràng trước khi bỏ hỗ trợ; không tự đổi transport của dữ liệu cũ.

**Phân biệt quan trọng:** extension vẫn sử dụng giao thức CDP qua `chrome.debugger.sendCommand` (`extensions/chrome-profile-connector/background.js:75`). Bỏ việc tự mở Chrome riêng **không đồng nghĩa xóa CDP client**; connector hiện tại cần lớp đó.

### F3 — Trung bình: 3 tab hiển thị nhưng vẫn giữ 8 màn hình

- `apps/launcher/src/renderer/App.tsx` vẫn import và route đủ 8 view.
- 5 mục bị che bằng `.nav-hidden`: Onboarding, Activity, Settings, Native Knowledge, Native Chat Import.
- Tổng 5 file view này là 752 dòng hiện tại; chưa tính store, IPC, CSS và tests liên quan.
- `OverviewView.tsx:138` vẫn điều hướng nút đăng nhập tới `onboarding` nếu không được truyền callback riêng. `App.tsx` hiện truyền callback điều hướng chung.
- `SessionsView.tsx:349` còn đường sang Activity.

**Hệ quả:** không chỉ có mã không dùng; một số màn hình phụ vẫn có đường truy cập. Sản phẩm chỉ được thu gọn thanh menu.

**Đề xuất:** giữ đúng ba route thật. Đưa chẩn đoán cần thiết vào phần chi tiết của Kết nối/Đoạn chat; đổi nút đăng nhập sang Tài khoản. Sau đó xóa view, route, icon, copy, styles và IPC không còn người dùng.

### F4 — Cao: Tính năng đã ẩn vẫn có thể chặn thao tác chính

- `packages/native-antigravity/src/native-proxy.ts:427` kiểm tra knowledge bindings trước khi xóa account, kể cả khi tính năng knowledge không bật.
- UI Nguồn dự án đã bị ẩn; người dùng bình thường không có đường điều hướng rõ ràng để gỡ liên kết đó.

**Hệ quả có điều kiện:** tài khoản có knowledge binding cũ có thể bị `ACCOUNT_BOUND` khi xóa. Đây là vấn đề đọc được từ mã; chưa khẳng định dữ liệu hiện tại đang có binding gây chặn.

**Đề xuất:** trước khi gỡ knowledge/import, kiểm kê metadata tồn tại. Chuyển liên kết cũ sang bản lưu không còn tham gia đường chạy hoặc cung cấp thao tác gỡ rõ ràng trong màn hình hiện hữu. Migration phải chạy lại an toàn và không tự xóa tệp nguồn.

### F5 — Trung bình: Thao tác chat bị lặp ở hai màn hình

- `NativeAccountsView.tsx:315` có nối hội thoại; dòng 351 có ghim/bỏ ghim.
- `SessionsView.tsx` cũng có ghim, resume, trạng thái lượt, lỗi gần nhất.
- Hai view tự tạo `NativeAccountStore`; store đọc lại mỗi 3 giây. Chuyển tab tạo lại store.

**Đề xuất:** Tài khoản chỉ quản lý account. Chuyển phục hồi, ghim và hủy lượt về Đoạn chat. Dùng một store chung ở cấp ứng dụng, vẫn giữ kiểm tra độ mới dữ liệu và revision/owner trước thao tác.

Danh sách chat cần API đọc metadata hội thoại native có phân trang; không chỉ hiển thị sticky bindings và một `lastOutcome`. Không cần lưu lại toàn bộ nội dung chat nếu mục tiêu chỉ là lưu trạng thái tiếp tục.

### F6 — Trung bình: Kiểm thử còn bảo vệ giao diện cũ

- `native-knowledge-desktop.ts:19` và `native-chat-import-desktop.ts:20` dùng JavaScript `.click()` vào nút điều hướng bị ẩn.
- `native-knowledge-desktop.ts:47` còn xác nhận chính nút đó không hiển thị.
- App ép light theme nhưng `SettingsView.tsx:121` vẫn có chọn system/light/dark; `App.tsx` giữ callback đổi theme rỗng và CSS còn dark/system.
- `apps/launcher/package.json:8` luôn build acceptance fixture trong build thông thường.
- Các workspace hiện đặt `lint` bằng chính `tsc --noEmit`, trùng typecheck.

**Hệ quả:** test có thể PASS một màn hình người dùng không mở được bằng giao diện. Lặp build/check làm quy trình dài hơn mà chưa tăng độ tin cậy tương ứng.

**Đề xuất:** smoke sử dụng điều hướng nhìn thấy và kiểm tra đúng ba màn hình. Tách `build:app` / `build:test`, chuyển demo/fixture ra entry riêng, bỏ theme control đã vô hiệu. Chọn bỏ alias lint hoặc cấu hình lint thực sự, không tính hai lượt TypeScript là hai lớp kiểm tra độc lập.

### F7 — Trung bình: Các nhánh nghiên cứu vượt nhu cầu sản phẩm

Ứng viên đưa ra khỏi bản sản phẩm:

- Knowledge registry, nguồn dự án, Gem/Notebook/Drive metadata và ZIP chat import.
- Gateway OAuth/HTTPS và custom MCP app chiều Gemini gọi về host.
- Các probe G0/G2, prototype C# language-server shim.
- `packages/model-bridge`: tìm tham chiếu hiện chỉ thấy implementation/tests của chính package, dependency/TS reference trong runtime và script recovery-build; chưa thấy consumer production gọi `EnvelopeParser`.

**Phải phân biệt:** `packages/mcp-server` không phải toàn bộ là mã thừa. Native CLI khởi tạo pool bằng `packages/mcp-server/dist/cli.js`; browser service, receipt store, shared ownership vẫn nằm trên đường chạy thật. Giữ phần này. Host/gateway chỉ gỡ sau khi kiểm tra cấu hình MCP đang đăng ký, bao gồm cấu hình ngoài repo nếu có.

`packages/runtime` cũng chưa thể xóa nguyên thư mục: launcher vẫn dùng settings, lifecycle và IPC qua nó. Chuyển các phần cần giữ trước rồi mới bỏ runtime cũ.

### F8 — Thấp: Tài liệu và tệp tạm tích lũy

Đo tại thời điểm review:

| Vùng | Số lượng | Dung lượng | Nhận định |
|---|---:|---:|---|
| `.tmp` | 41.127 tệp | 808,13 MiB | Ứng viên dọn sau kiểm kê, không mặc định tất cả là rác |
| `.tmp-native-account-evidence` | 5 tệp | 0,39 MiB | Bằng chứng tạm, chưa được ignore |
| `docs/evidence` được Git theo dõi | 249 tệp | 8,58 MiB | Chủ yếu rườm rà khi tra cứu, không phải nguyên nhân tốn đĩa lớn |
| `tools/probes` được Git theo dõi | 50 tệp | 0,31 MiB | Nghiên cứu và kiểm thử trộn lẫn |

`.tmp` chứa 4 Git worktree đã đăng ký. Ba worktree sạch; `worktree-chrome-profile-connector` còn `docs/CHROME_PROFILE_CONNECTOR.md` chưa được Git theo dõi. **Không xóa hàng loạt `.tmp`**. Các thư mục lớn còn có Electron download khoảng 150,55 MiB, bản baseline và repo tham khảo.

`README.md:5` còn nói source 42/owner 41 và chưa ghép Chrome thật; các đoạn cuối tiếp tục ghi nhiều runtime revision khác. Source hiện là 44. README cũng vẫn mô tả 5 màn hình cũ. Nên tách hướng dẫn hiện hành khỏi lịch sử nghiệm thu.

Giữ `THIRD_PARTY_NOTICES.md` và giấy phép/attribution của mã còn dùng. Chưa có bằng chứng để kết luận `node_modules`, lockfile, tests hoặc toàn bộ ảnh evidence là rác.

## 3. Kiến trúc đích

```text
Launcher: Tài khoản | Đoạn chat | Kết nối
    |
    +-- Electron main/preload: IPC, clipboard, cài đặt tối thiểu
    |
    +-- Native owner: account registry, conversation metadata, trạng thái kết nối
             |
             +-- Account workers / browser MCP service
                       |
                       +-- Chrome Profile Connector
                                  |
                                  +-- Tab Gemini trong hồ sơ Chrome có sẵn

Antigravity IDE --> Native proxy --> Account worker --> Gemini
```

Một nguồn trạng thái chính không có nghĩa gộp mọi tiến trình hoặc ledger thành một. Vẫn giữ worker cách ly theo account, quyền điều khiển đúng owner và hai loại receipt: yêu cầu IDE và lần gửi vật lý tới Web.

## 4. Kế hoạch thực hiện

### P0 — Chốt baseline và dữ liệu cần giữ

- Ghi danh sách thay đổi đang có; không reset hoặc commit gộp mã của các đợt trước.
- Kiểm kê account transport, conversation/binding và cấu hình MCP đang dùng, không ghi token/cookie vào báo cáo.
- Kiểm tra worktree, đối chiếu tệp chưa theo dõi trước khi phân loại dọn.
- Chốt API/dữ liệu tối thiểu cho ba màn hình và các case nghiệm thu bên dưới.

**Đạt khi:** có manifest rõ từng mục giữ, chuyển, bỏ; có phương án rollback dữ liệu cho mỗi migration.

### P1 — Thống nhất trạng thái và hoàn thiện đường extension

- Đưa native owner snapshot vào cả ba màn hình và sidebar.
- Bổ sung quan sát connector đã ghép/đang nối, tab Gemini, xác minh danh tính gần nhất, owner online/offline và hoạt động IDE gần nhất.
- Tách “chưa có kiểm chứng”, “mất kết nối”, “lỗi” và “dữ liệu cũ”; không suy ra trạng thái nối từ việc xác minh danh tính còn hiệu lực hay không.
- Bổ sung danh sách metadata chat native, gồm tài khoản/epoch, URL, trạng thái tiếp tục, lần cập nhật, lượt đang chạy.
- Dùng một store chung; hủy/pause/resume vẫn kiểm tra owner, revision, binding và kết quả gửi.
- Cho phép zero account; bỏ `ensureDefault` khỏi thao tác đọc/khởi động, sửa CLI/add/launch để dùng extension.
- Di chuyển settings/lifecycle thiết yếu khỏi runtime cũ.

**Đạt khi:** ba màn hình thống nhất với cùng native owner; native owner dừng thì cả ba báo đúng. Xóa tài khoản cuối rồi khởi động lại không tạo Default Account. Tài khoản legacy có hướng xử lý rõ ràng, không bị tự chuyển hoặc xóa.

### P2 — Gỡ giao diện và API thừa

- Xóa năm route/view phụ, không dùng CSS để giấu.
- Gộp ghim/resume/cancel vào Đoạn chat, bỏ bản sao tại Tài khoản.
- Giữ chi tiết lỗi và xuất chẩn đoán đã lọc trong Kết nối nếu còn cần hỗ trợ.
- Bỏ dark/system và giao diện Settings cũ; giữ cấu hình ngôn ngữ cần thiết ở vị trí nhỏ trong ba màn hình.
- Migration knowledge/import metadata cũ trước khi gỡ view/store/IPC/endpoint liên quan.
- Xóa các chuỗi dịch, icon, CSS và test chỉ dành cho chức năng đã bỏ.

**Đạt khi:** chỉ có ba route production và không có liên kết sang màn hình ẩn. Dữ liệu tính năng đã bỏ không còn âm thầm chặn xóa tài khoản. Không còn hai form nối cùng một hội thoại.

### P3 — Gỡ các nhánh thực thi ngoài phạm vi

- Sau P1/P2, bỏ runtime demo/coordinator cũ khỏi entry production; giữ fixture tối thiểu ở test entry.
- Gỡ `model-bridge` nếu kiểm tra consumer/build xác nhận không dùng; cập nhật workspace, TS references, lockfile và recovery-build cùng lúc.
- Tách/gỡ host/gateway/custom-app route sau khi xử lý cấu hình đăng ký. Giữ browser MCP broker, receipt store và worker ownership.
- Bỏ nhánh tự spawn Chrome/profile riêng sau khi tài khoản legacy đã được xử lý; giữ CDP abstractions connector dùng.
- Đưa shim/probe cũ ra khỏi lệnh chạy/test mặc định. Chỉ giữ công cụ chẩn đoán tái sử dụng.
- Tách `native-proxy.ts` (922 dòng hiện tại) theo HTTP handlers, management và inference orchestration; giữ nguyên thứ tự kiểm tra authority, receipt và submission. Đây là refactor, không phải lý do tự viết lại giao thức.

**Đạt khi:** fresh build không phụ thuộc package/entry đã bỏ; native prompt, tool result, streaming và cancel vẫn qua đường browser broker hiện tại.

### P4 — Dọn build, tài liệu và tệp tạm

- Tách build sản phẩm và acceptance fixture; test dùng output vừa build, tránh PASS từ `dist` cũ.
- Đổi test script wildcard theo thay đổi cấu trúc, tách suite cần chạy thường xuyên khỏi probe nghiên cứu.
- Viết README ngắn: mục đích, cài đặt, chạy, ghép hồ sơ và xử lý lỗi phổ biến.
- Chuyển lịch sử revision/nghiệm thu sang mục archive có index; sửa liên kết sau khi chuyển. Giữ một bộ screenshot hiện hành.
- Dọn worktree bằng Git sau khi lưu thay đổi cần giữ, rồi mới dọn download/baseline/cache không dùng.
- Kiểm tra đường dẫn tuyệt đối, file đang được tiến trình dùng và đo lại dung lượng sau dọn; không đụng Chrome cá nhân hoặc state live chỉ vì nằm ngoài Git.

**Đạt khi:** hướng dẫn khớp ba màn hình/extension; không có import, script hoặc liên kết nội bộ hỏng. Báo dung lượng thực thu hồi, không hứa trước sẽ xóa đủ 808 MiB.

## 5. Những thành phần phải giữ

- Registry account và identity epoch; ràng buộc đúng tab/profile.
- Conversation checkpoints và context append/patch/fragment transport đang dùng.
- Nonce, kiểm tra tool inventory/schema và quyền executor của IDE.
- Receipt/ledger và dấu chặn gửi lại khi kết quả chưa rõ, kể cả sau xóa account.
- Cancel, timeout, cleanup, phục hồi sau restart và owner/revision checks.
- Extension pairing, xác thực kênh local, origin/surface allowlist và IPC validation.

Không đổi sang tự gửi lại prompt để che lỗi. Không coi hệ thống lưu dấu chống gửi trùng là “rác” dù người dùng không thấy trên màn hình.

## 6. Nghiệm thu và thứ tự ưu tiên

Ưu tiên P1 trước các đợt xóa diện rộng: trạng thái chính xác có giá trị hơn việc giảm số file.

| Ca kiểm tra | Kết quả bắt buộc |
|---|---|
| Khởi động khi chưa có account | UI hướng dẫn thêm hồ sơ, không tự mở Chrome riêng |
| Ghép account A/B | Hiển thị độc lập, đúng profile, không lấy trạng thái của A cho B |
| Đổi account | Chọn đúng tài khoản cho lượt sau theo policy; xử lý checkpoint rõ ràng |
| Chat mới và chat đã lưu | Có metadata đúng nguồn native; không báo “không có chat” chỉ vì runtime cũ rỗng |
| Owner/connector dừng hoặc restart | Trạng thái cũ được đánh dấu; mutation bị chặn đúng lý do |
| Xóa account có chat | Thực hiện sau xác nhận retire, không mất receipt fence |
| Xóa account cuối và mở lại | Danh sách vẫn rỗng; không xuất hiện Default Account |
| Metadata knowledge cũ | Có migration/gỡ hợp lệ; không có lỗi chặn không thể giải quyết qua UI |
| Cửa sổ hẹp, bàn phím | Ba tab và nút thao tác dùng được, không cần click DOM ẩn |
| Native IDE live | Prompt → phản hồi → tool → kết quả tool → phản hồi tiếp; streaming/cancel kiểm riêng |

Sau mỗi pha: build/typecheck và regression đúng phần bị tác động. Sau P3: chạy suite phần còn giữ và smoke ba màn hình. Cuối cùng mới nghiệm thu IDE + Gemini thật; fixtures không thay cho bước này.

Không tự đặt mục tiêu giảm 30%/50% mã hoặc tăng tốc suy luận khi chưa đo. Kết quả cần đạt là một đường chạy chính, dữ liệu nhất quán, ít thao tác, ít nhánh phải bảo trì và các tình huống lỗi xử lý được.
