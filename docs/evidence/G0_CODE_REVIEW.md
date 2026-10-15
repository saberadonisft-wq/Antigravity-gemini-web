# Review code và bằng chứng G0

Ngày review: 14/10/2026. Phạm vi: bốn probe Python trong `tools/probes/g0/`, báo cáo `native-feasibility.md`, transcript người dùng cung cấp và đối chiếu tài liệu Google.

Đây là review chỉ đọc mã. Không sửa probe, không chạy `agy.exe`, không mở browser, không thay cấu hình IDE/tài khoản. Chỉ thêm báo cáo này và prompt bàn giao G1.

## Kết luận

**G0 chưa qua gate để triển khai native integration.** Đã có dấu hiệu route một request control-plane và mở được trang Gemini, nhưng chưa chứng minh request suy luận, phiên Gemini đã đăng nhập, tool loop hay kết quả cuối trong chat IDE.

Quyết định “chưa cho triển khai native” là hợp lý theo tiêu chí gate. Các khẳng định “Gemini Web không có MCP”, “endpoint suy luận đã chuyển hướng” và “native chắc chắn không thể làm được” vượt quá bằng chứng hiện có. Cần sửa nội dung báo cáo trước khi dùng nó làm quyết định kiến trúc.

Có thể chuẩn bị G1 ở phạm vi contracts/scaffold/mock độc lập sau khi giải quyết lỗi probe; native adapter phải báo `unverified`/không sẵn sàng. Việc này không đồng nghĩa G0 đã đạt hoặc được đổi mục tiêu sang CLI/SDK.

## Findings theo mức độ

### R1 — [P1] Kết luận không có MCP trên Gemini Web sai so với tài liệu chính thức

Vị trí: `docs/evidence/native-feasibility.md:25–26`, `:124–126`, `:165–166`.

Báo cáo ghi Gemini Web hoàn toàn không có MCP client. Google đang có hướng dẫn kết nối custom app qua URL MCP trên Gemini web; điều kiện gồm account cá nhân, khu vực, tuổi, tiếng Anh và Keep Activity. Một số phiên bản ngôn ngữ còn giới hạn custom apps trong Gemini Spark, nên phải kiểm tra đúng product surface và tài khoản thay vì suy ra áp dụng cho mọi chat.

Probe dừng trước login. Vì vậy khả dụng trên tài khoản này là **NOT TESTED**, không phải một kết luận UNSUPPORTED cho toàn sản phẩm. URL MCP ở cloud cũng không tự chứng minh gọi được localhost hoặc executor của IDE.

Sửa: ghi rõ tính năng được tài liệu mô tả, eligibility theo ngày kiểm tra, trạng thái chưa thử trên account; còn đường MCP → đúng IDE executor vẫn cần bằng chứng riêng.

Nguồn chính thức đã tra cứu ngày review:

- https://support.google.com/gemini/answer/17209137?co=GENIE.Platform%3DDesktop&hl=en-TZ
- https://support.google.com/gemini/answer/17209137?co=GENIE.Platform%3DAndroid&hl=en-GB
- https://support.google.com/gemini/answer/13695044?hl=en-GB

### R2 — [P1] Chưa chứng minh endpoint suy luận; ba biến môi trường bị thử cùng lúc

Vị trí: `tools/probes/g0/test_start_cascade_details.py:50–53`, `:84–102`; báo cáo `native-feasibility.md:21`, `:77–78`, `:98–101`.

Probe đặt `AICODE_ENDPOINT_URL`, `JETSKI_SERVICE_ENDPOINT_URL` và `GOOGLE_VERTEX_BASE_URL` đồng thời. Request được ghi nhận là `fetchUserInfo`; `StartCascade` trả lỗi validation. Chưa có prompt sinh nội dung tới local server, chưa có stream hay tool result. Không xác định được biến nào có tác dụng riêng, cũng không chứng minh `PredictionService` đã chạy trong lượt thử này.

Không thấy custom-model field trong extension config, một catalog response và RPC 501 chỉ cho thấy chưa tìm được extension point trong đường khảo sát; chưa loại trừ mọi đường model routing. Định dạng protobuf/gRPC riêng tạo thêm việc kiểm chứng, không tự chứng minh toàn bộ native integration bất khả thi.

Sửa: tách `control_plane_route_observed` và `inference_route_verified`; giữ inference là NOT TESTED/FAIL theo lần thử. Dùng baseline và matrix từng biến riêng; replay schema request đúng nếu có nguồn xác minh, không đoán đến khi được HTTP 200. Không cần đạt thêm model picker để ghi nhận một route đang nghiên cứu.

### R3 — [P1] Probe ghi nguyên header/body có thể lộ credential hoặc nội dung

Vị trí: `test_start_cascade.py:17–25`; `test_start_cascade_details.py:18–21`, `:108–112`; `test_aicode_endpoint.py:17–20`, `:93–96`.

`test_start_cascade.py` in mọi header. Synthetic reproduction xác nhận Authorization và Cookie xuất hiện nguyên văn trong output. Probe details che auth/token header nhưng bỏ sót Cookie và vẫn in body, stdout/stderr thô. App-data directory khác không tự chứng minh OS keychain, environment hay mọi credential của process đã được cô lập.

Không xác nhận credential thật đã bị lộ trong lần chạy trước; đây là lỗi code đã tái hiện bằng dữ liệu giả.

Sửa: logging theo allowlist metadata (method, path đã sanitize, content type, byte count, status, synthetic IDs); không giữ raw header/body, không dump child stdout/stderr khi chưa redact. Kiểm thử bằng bearer/cookie/key/prompt synthetic; cô lập environment/config của probe và ghi rõ giới hạn OS keychain.

### R4 — [P1] Lỗi RPC/readiness không làm probe thất bại

Vị trí: `test_aicode_endpoint.py:68–90`, `test_start_cascade.py:64–91`, `test_start_cascade_details.py:74–102`.

Khi health check thất bại hết vòng lặp, code vẫn gọi RPC. RPC exception chỉ được print rồi luồng kết thúc bình thường. Synthetic reproduction buộc toàn bộ HTTP trả lỗi: cả ba file trả về bình thường, tương ứng exit code 0 nếu không có lỗi cleanup khác. Automation có thể coi đây là probe PASS.

Sửa: kết quả có schema, assertion đúng từng mục tiêu, readiness deadline và kiểm tra process còn sống; lỗi trả nonzero, NOT TESTED có mã riêng được ghi tài liệu. Không dùng status 200 hoặc độ dài response làm bằng chứng hoàn thành semantic của inference.

### R5 — [P2] Cleanup có đường bỏ sót process/browser/socket

Vị trí: `test_aicode_endpoint.py:45–67`, `:98–105`; `test_start_cascade.py:42–63`, `:99–106`; `test_start_cascade_details.py:44–73`, `:105–116`; `test_gemini_web.py:24–50`.

Server/thread được tạo trước khi vào `try`; Popen lỗi thì không shutdown. Browser chỉ gọi `quit()` ở happy path, exception sau tạo driver không dọn. Synthetic spawn failure xác nhận thiếu server cleanup; screenshot failure xác nhận driver không quit. Các nhánh kill thiếu wait, socket thiếu server_close; hai probe giữ PIPE nhưng không drain trong lúc chạy nên có thể kẹt khi child log nhiều.

Sửa: quản lý từ acquisition tới release bằng try/finally/context manager; terminate → timeout → kill → wait; server shutdown + close + join; driver quit trong finally. Drain child output theo cơ chế bounded/redacted, không dùng wait vô hạn.

### R6 — [P2] Probe chưa tái hiện độc lập và dễ bắt nhầm readiness

Vị trí: `test_aicode_endpoint.py:10`, `:54–61`; `test_start_cascade.py:10`, `:51–58`; `test_gemini_web.py:5–6`, `:20`, `:28–38`.

Path user/binary/profile và port bị hardcode; không có probe README/dependency manifest. Port cố định cùng health check không kiểm tra identity có thể đọc service khác. Login suy ra từ chữ “Sign in” trong toàn page_source và sleep 5 giây, chưa xác minh account/composer bằng semantic checks. Browser probe không có cơ chế giữ cửa sổ để người dùng đăng nhập rồi resume các bước chưa thử.

Sửa: flags cho executable/profile/artifact/timeout, dependency pin, port động với xử lý race, readiness identity nếu có; cơ chế user-action/resume hữu hạn và login check đúng surface. Profile không nằm trong repo, artifacts không chứa dữ liệu account thật mặc định.

## Kiểm tra đã thực hiện trong review

| Kiểm tra | Kết quả | Giới hạn |
|---|---|---|
| Compile in-memory 4 file Python | PASS | Chỉ syntax; không import Selenium/run app |
| Cả HTTP/readiness bị mock trả lỗi | 3/3 RPC probe kết thúc bình thường | Tái hiện lỗi đánh dấu thất bại, không nói backend thật |
| POST synthetic chứa bearer/cookie | Cả hai xuất hiện nguyên trong log | Không dùng credential thật |
| Popen synthetic ném OSError | Server cleanup không được gọi | Socket/thread/process đều mock |
| Screenshot synthetic ném OSError | Probe exit 1, driver quit không được gọi | Webdriver mock, không mở browser |
| Metadata package extension cài trên máy | Version 1.7.0, chưa có provider field trong contributed config | Không chứng minh tất cả cơ chế native đều bị đóng |
| Tài liệu Gemini custom apps | Có hướng dẫn MCP, kèm eligibility/product caveats | Chưa kiểm tra account người dùng |

Không chạy live probe trong review vì code hiện ghi dữ liệu thô và có lỗi cleanup; controlled fault reproduction đã đủ chứng minh các findings này.

## Yêu cầu bàn giao G1

Prompt chi tiết: [GEMINI_G1_PROMPT.md](../GEMINI_G1_PROMPT.md).

Thứ tự: sửa R1–R6 và bổ sung evidence → chốt schema/contracts → dựng runtime fake có lifecycle/dedupe → transport kiểm tra hai đầu → renderer harness tối thiểu nếu cần để chứng minh contract. Giữ native capability unverified và không apply route thật khi G0 chưa đạt. Không đổi Gemini Web thành Gemini API hoặc mục tiêu native thành agent riêng.
