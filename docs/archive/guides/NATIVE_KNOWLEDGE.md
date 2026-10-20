# Nguồn tham chiếu dự án — P6a/P6b, source 35

P6a đã có import **file local được chọn** và ghi provenance của **GitHub checkout local** qua CLI/native owner. Source 35 thêm P6b: màn hình **Nguồn dự án**, import file qua chooser ở Electron main, xem file/version và chọn nguồn riêng theo chat/tài khoản. Mặc định tắt. Web GitHub import, các adapter Gem/Notebook/Drive, đánh giá chất lượng với repo thay đổi và executor IDE thật vẫn chưa nghiệm thu.

Runtime chính được đọc health ngày 18/10 vẫn revision 29/manual, không có lượt active. Cửa sổ Google đang chờ người dùng xác minh; source 35 chưa được nạp vào runtime đó. Không restart cửa sổ đang xác minh để thử các lệnh bên dưới.

## Bật sau khi runtime được cập nhật

Chỉ sau khi xác minh hoàn tất và runtime được cập nhật lúc idle theo [runbook](../../NATIVE_RECOVERY_RUNBOOK.md):

```powershell
$env:AG_NATIVE_KNOWLEDGE_EXPERIMENTAL = '1'
npm run native:start
npm run native:knowledge
```

Nếu owner hiện tại quá cũ hoặc mất kết nối, CLI báo lỗi; không tạo worker khác hoặc ghi cấu hình offline để thay thế owner.

## Dùng trong launcher

Launcher cần owner source 35 trở lên. Mở **Nguồn dự án** sau khi proxy mới đã nạp:

1. Chọn **Thêm file từ máy**, nhập tên nguồn và chọn file trong hộp thoại Windows. Renderer không được truyền root/file paths tùy ý; main cấp tập file từ chooser, suy ra root chung và gửi selection tới owner. Import metadata chưa gửi prompt.
2. Mở **File đã chọn và phiên bản** để xem relative filenames/hash. **Kiểm tra độ mới** chỉ kiểm tra bytes/commit local, không xác nhận quyền Web hoặc chất lượng model.
3. Tại chat IDE muốn nhận nguồn, gửi một yêu cầu rồi đọc lại trạng thái. Chọn **Chat vừa xử lý**, đúng tài khoản, đánh dấu tối đa 8 nguồn và **Lưu lựa chọn cho chat/tài khoản**. Từng account cần binding riêng; mode tự động cũng không tự chuyển nguồn của A sang B.
4. Khi file local đổi, **Chấp nhận bản local mới** cập nhật snapshot cho mọi binding đang dùng nguồn đó. GitHub checkout có dirty/untracked overlay mới vẫn cần chọn overlay tường minh qua CLI. Nguồn stale không tự refresh.
5. **Bỏ nguồn khỏi chat/tài khoản này** xóa binding đó. **Xóa metadata** chỉ bật khi không còn binding; giữ nguyên các file. Hủy chooser, lỗi/owner thay đổi, busy hoặc mất kết nối không tự import/bind/retry.

Các nguồn Web chưa có adapter hiển thị rõ **chưa xác minh** và không được chọn mới từ UI. Các đăng ký cũ qua CLI vẫn có thể bỏ binding tường minh. Nếu chưa có chat native, vẫn import được nguồn nhưng chưa gắn nguồn cho một task tùy ý. Registry đổi sẽ tải lại draft selection; status poll cùng revision giữ lựa chọn đang sửa.

Test Electron/IPC/HTTP thật đã pass, browser và grant chooser giả lập; chưa coi đó là nghiệm thu giao diện hộp thoại Windows thật hoặc Web/IDE. [Báo cáo P6b và ảnh sáng/tối](../../evidence/g4-native-p6b-project-knowledge-ui.md).

## Import và chọn nguồn

Chọn rõ từng file tương đối; không quét cả thư mục:

```powershell
npm run native -- knowledge:import --label 'Tài liệu dự án' --root 'D:\MyProject' --file README.md --file docs/architecture.md
npm run native -- knowledge:check 'SOURCE_ID_FROM_IMPORT'
```

`knowledge` trả source ID, revision/hash, selected relative filenames, số file/byte và trạng thái; không trả root tuyệt đối hoặc nội dung file. Sau một lượt native thuộc chat cần gắn nguồn, lấy `lastTaskScope` từ status, chọn account ID từ `npm run native:accounts`, rồi gắn tường minh:

```powershell
npm run native -- knowledge:bind --account 'ACCOUNT_ID' --task 'TASK_SCOPE_64_HEX' --source 'SOURCE_ID_FROM_IMPORT'
```

Có thể lặp `--source` tối đa 8 nguồn. Binding áp dụng cho lượt mới tiếp theo; retry request cũ giữ nguyên kết quả/fence và không gửi một lượt mới chỉ vì vừa chọn thêm nguồn. Mỗi task/account có binding riêng và identity epoch phải còn khớp. Đổi sang B không tự cấp dữ liệu đã gắn cho A; nếu chưa gắn B, native core vẫn hoạt động và báo `SOURCE_ACCOUNT_NOT_BOUND`. Việc người dùng gắn local source cho B là lựa chọn gửi các file đó bằng tài khoản B.

Binding chỉ kiểm soát phần reference mà bridge bổ sung. Native context/lịch sử do IDE gửi vẫn được truyền đủ theo request gốc; nếu nội dung nguồn đã có trong lịch sử đó, đổi sang B vẫn có thể đưa phần lịch sử ấy cho B. Bridge không lọc mất lịch sử để thực hiện source binding. UI nêu rõ điều này khi chọn chat/tài khoản.

## Checkout GitHub, commit và local overlay

```powershell
npm run native -- knowledge:import --label 'Checkout tại commit hiện tại' --root 'D:\MyProject' --github 'https://github.com/OWNER/REPO' --file src/example.ts --file docs/design.md
```

Đây là đọc checkout có sẵn trên máy, **không gọi Web import, clone, fetch hoặc GitHub API**. `origin` phải khớp repository, root phải là top-level của checkout, HEAD hợp lệ và không là partial clone. Manifest giữ commit cùng SHA-256 của từng file. Các lệnh đọc Git không dùng filters/textconv/fsmonitor của repo; fixture có command bẫy đã kiểm tra không bị thực thi.

File khác commit hoặc chưa được Git theo dõi cần được chọn cả ở `--file` và `--overlay`. CRLF/LF khác nhau được đánh dấu riêng; bytes gửi đi và hash vẫn là bytes local chính xác. Refresh giữ tập file đã chọn; có thể chỉ định lại overlay:

```powershell
npm run native -- knowledge:refresh 'SOURCE_ID' --overlay src/example.ts
npm run native -- knowledge:check 'SOURCE_ID'
```

Refresh là chấp nhận một snapshot local mới, không đồng bộ Web ngầm. File đổi/rename/xóa, HEAD đổi hoặc repository không khớp làm nguồn cũ bị loại khỏi lượt mới. Các file khác ngoài selection không được thêm vào gói.

## Giới hạn và trạng thái

Các giới hạn sau là của bridge thử nghiệm: tối đa 128 file/nguồn, 1 MiB/file, 8 MiB/nguồn; phần reference trong context tối đa 32.768 ký tự canonical. Tổng prompt native vẫn giới hạn 262.144 ký tự UTF-16. Nguồn quá lớn bị bỏ kèm `SOURCE_BUDGET_EXCEEDED`; context gốc của IDE không bị cắt để nhét nguồn vào. Không lấy các số này làm giới hạn upload của Google.

Chỉ nhận UTF-8 hợp lệ, giữ BOM/CRLF/Unicode. Chặn traversal, Windows device/ADS, symlink/junction/hardlink, credential filenames, VCS/cache/build và một số mẫu credential trong nội dung. Đây không phải scanner nhận diện mọi bí mật; người dùng cần xem lại các file được chọn trước khi gắn nguồn.

`current` có nghĩa bytes/commit vừa được kiểm tra tại máy, không chứng nhận model đã dùng nguồn đúng. Quan sát status hết hạn sau 30 giây; mỗi lần chuẩn bị context, trước một physical submission và trước khi chấp nhận câu trả lời đều kiểm tra lại dữ liệu được dùng. Nguồn thay đổi giữa lượt làm lượt dừng; nếu đã có Send thì giữ hàng rào outcome unknown, không tự gửi lại. Cached reply có dữ liệu từ nguồn đã đổi cũng bị thu hồi, không Send lại.

Registry `knowledge.json` chỉ lưu metadata: root local riêng tư, relative paths, hash, commit, binding và revision. Không chia sẻ file registry nguyên trạng vì nó có root/file IDs. Source bytes không nằm trong registry; chúng đi vào context RAM. Nếu bật transport snapshot upload P3 riêng, transport đó có thể tạo file tạm theo cơ chế lease/cleanup hiện có; P6a không thay đổi vòng đời đó.

Nguồn chỉ là dữ liệu tham chiếu. Không cấp tool, thay nonce, approvals hoặc function policy. Prompt yêu cầu native `view_file` lấy bytes hiện tại trước sửa, nhưng chưa có nghiệm thu executor IDE bảo đảm model luôn thực hiện bước đọc đó.

## Gem, Notebook, Drive và GitHub Web

```powershell
npm run native -- knowledge:register gem --label 'Gem hướng dẫn' --url 'https://gemini.google.com/gem/GEM_ID' --instruction-version 'v1'
npm run native -- knowledge:register notebook --label 'Notebook' --url 'https://notebook.google.com/notebook/NOTEBOOK_ID'
```

Các loại `gem`, `notebook`, `drive`, `github_web` hiện **chỉ đăng ký metadata**, luôn `not_verified / SOURCE_ADAPTER_NOT_LIVE_VERIFIED`. URL phải đúng provider và không có credentials/query/hash. Gem cần version hướng dẫn ổn định; dynamic tool policy không được gắn vào Gem/memory. Không đọc quyền truy cập, thêm source, chia sẻ, upload hay điều hướng browser khi chạy lệnh register. Binding một nguồn metadata chưa xác minh không đưa nội dung nguồn đó vào context và không chặn native core.

Giới hạn từng tích hợp cần kiểm chứng độc lập. [Google mô tả GitHub import là snapshot, không sync thay đổi về sau](https://support.google.com/gemini/answer/16176929?hl=en). [Gems có thể nhận file/Drive](https://support.google.com/gemini/answer/15235603?hl=en); chưa suy ra mọi loại Knowledge luôn tự cập nhật. [Tài liệu Notebook mô tả Drive source auto-sync vài phút và yêu cầu quyền xem](https://support.google.com/gemininotebook/answer/16215270?hl=en); điều đó không chứng nhận các adapter chưa triển khai của bridge đã hoạt động.

## Bỏ chọn và rollback

```powershell
npm run native -- knowledge:clear --account 'ACCOUNT_ID' --task 'TASK_SCOPE_64_HEX'
```

Bỏ binding ảnh hưởng lượt mới, không xóa lịch sử Gemini, source file, receipt hoặc replay fence. Để tắt toàn tính năng, bỏ `AG_NATIVE_KNOWLEDGE_EXPERIMENTAL` khi cập nhật owner lúc idle; metadata vẫn giữ. Không xóa ledger/conversation state để thử gửi lại request đã chấp nhận.

`knowledge:remove 'SOURCE_ID'` chỉ xóa metadata của nguồn không còn binding nào. Nếu vẫn được task/account khác chọn, trả `SOURCE_STILL_BOUND`; cần bỏ các binding đó tường minh. Lệnh này không xóa file local hoặc tài liệu trên Web.

## Kiểm chứng

[Báo cáo P6a](../../evidence/g4-native-p6a-project-knowledge.md) và [P6b](../../evidence/g4-native-p6b-project-knowledge-ui.md) phân biệt test local/CLI/Electron/Native/MCP với Web thật. Chạy fixture sau build:

```powershell
node tools/probes/native-knowledge-fixture.mjs
npm run test:desktop-native-knowledge
```

CLI fixture dùng project tổng hợp trong temp riêng, CLI production, child owner, MCP và SQLite thật; browser giả lập, chặn transport CLI ngoài loopback, không gửi dữ liệu dự án lên Google. Desktop fixture dùng Electron/preload/HTTP thật với browser và main chooser grant giả lập. P6 vẫn IN PROGRESS cho các adapter và gate chất lượng/live còn lại trong [kế hoạch](../plans/NATIVE_UPGRADE_PLAN.md).
