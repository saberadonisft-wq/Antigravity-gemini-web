# Review G2 transparent shim

Ngày: 14/10/2026. Review source C#, Python tests và báo cáo mới. Chỉ chạy shim với Python synthetic child/fake child; không mở IDE, gọi inference hoặc thay cấu hình người dùng. Không sửa code trong lượt review.

## Kết luận

Shim có thể khởi chạy child và suite hiện tại đạt, nhưng **chưa nghiệm thu tính trong suốt hoặc native IDE launch hook**. Các khẳng định “100% args”, “bảo toàn byte stream”, “token không bị log” và “không còn child mồ côi” cần sửa/giới hạn bằng chứng.

Inference và browser/live E2E vẫn unresolved/not tested như báo cáo. Không chuyển G3. Prompt tiếp tục: [GEMINI_G2_SHIM_HARDENING_PROMPT.md](../archive/prompts/GEMINI_G2_SHIM_HARDENING_PROMPT.md).

## Bằng chứng đã chạy

- `npm run build` và `npm run test`: PASS, 31 tests TypeScript, trong đó runtime 17 tests gồm A1/A2 regressions. Đây là scaffold, không live/native acceptance.
- `python -m unittest tools/probes/g2/shim/test_shim.py`: PASS, 4/4 tests hiện có.
- SHA256 của binary shim đang thử khớp báo cáo: `8DAF2AF292DF018280F6C989170843BA64198C8C8080CB29C59139F52A891CC5`.
- Target được override bằng Python echo/byte writer synthetic; log trong temp riêng chỉ có dữ liệu giả, không dùng credential thật.

| Controlled reproduction | Quan sát |
|---|---|
| Empty arg + tail | 2 tokens thành 1 token |
| Một arg có tab | 1 token thành 2 tokens |
| Đường dẫn có space, kết thúc backslash + tail | 2 tokens thành 1 token |
| Backslash ngay trước quote | Token count giữ nhưng nội dung khác |
| `--csrf_token=SYNTHETIC_CSRF_EQUALS_FOR_REVIEW` | Giá trị synthetic xuất hiện nguyên trong log |
| Slow stdout consumer, child viết 12.000 byte | Shim exit 0, chỉ nhận 0 byte trong lượt thử |
| Cùng child 12.000 byte chạy trực tiếp, slow consumer | Nhận đủ 12.000 byte, exit 0 |
| Slow consumer với 24.000 byte | Nhận đủ; lỗi drain phụ thuộc timing/pipe buffering, không phải mọi output đều mất |

## Findings

### S1 — [P1] Reconstruct Windows argv không giữ nguyên token

Vị trí: `tools/probes/g2/shim/AntigravityShim.cs:174–188`.

Code chỉ quote khi có space hoặc double quote, bỏ sót empty/tab. Quote escaping chỉ Replace dấu quote, không xử lý đúng runs of backslashes trước quote hoặc closing quote. Đây là lỗi forwarding thực tế, không chỉ style.

`FakeChild.cs:45–46` chỉ ghi số lượng args. `test_shim.py:63–65` chỉ kiểm tra count 11, nên không chứng minh từng token nguyên vẹn.

Sửa: Windows argv quoting đã được kiểm tra, bảo toàn empty/whitespace/Unicode/backslash/quote; fake child xuất JSON từng token rồi assert equality đầy đủ. Không sửa bằng join/raw interpolation qua shell.

### S2 — [P1] Redaction bỏ lọt flag dạng equals

Vị trí: `AntigravityShim.cs:96–120`, logging `:153–154`.

Redaction chỉ nhận ba exact token dạng `--key value`. Go-style `--csrf_token=value`, `--extension_server_csrf_token=value`, `--api_key=value` đi qua nguyên vẹn. Controlled test đã xác nhận synthetic secret trong log.

Không xác nhận token thật đã bị lộ trong các lần chạy trước. Nhưng code cho phép lộ khi sử dụng dạng flags hợp lệ khác; không thể gọi logging đã bảo đảm không có token.

Sửa: ưu tiên metadata allowlist, không dump nguyên argv; nếu ghi flag thì nhận cả split/equal và sanitize mọi giá trị nhạy cảm. Dùng synthetic token tests cho stderr/log/exception path; không dump real argv/stdout/stderr vào evidence.

### S3 — [P1] Output drain timeout làm mất dữ liệu nhưng vẫn exit success

Vị trí: `AntigravityShim.cs:245–293`, `:310–318`.

Output workers là background threads. Main chỉ Join 500ms cho mỗi luồng rồi exit bằng child code, không kiểm tra Join result; pipe exception bị nuốt. Child đã exit nhưng parent consumer chậm có thể còn bytes chưa được chuyển, worker bị dừng khi wrapper thoát.

Repro 12.000 byte với reader chờ 1,5 giây: shim exit trước reader, stdout nhận 0 byte. Direct-child baseline nhận đủ. Suite 51-byte hiện tại không bao phủ backpressure/drain.

Sửa: đợi output EOF/drain thực sự; timeout/backpressure phải có semantics rõ, không trả transparent success sau timeout hoặc forwarding error. Test burst > pipe capacity, slow reader, stdout/stderr đồng thời, binary bytes và early exit; tránh wait vô hạn khi peer đã đóng.

### S4 — [P2] Job Object errors không được kiểm tra; suite chưa kiểm child/grandchild

Vị trí: `AntigravityShim.cs:68–94`, `:193–211`; `test_shim.py:122–145`.

SetInformationJobObject và AssignProcessToJobObject trả bool nhưng code bỏ qua. CreateJobObject/interop failure là “non-critical fallback”. Child chạy trước khi được assign job, nên chưa có bảo đảm descendants sinh trong khoảng đó thuộc job. Không có fail-closed cleanup/diagnostic khi assignment thất bại.

Test terminate chỉ assert wrapper đã chết, không lấy/đợi child/grandchild PID. Review chưa tái hiện orphan thực tế; đây là thiếu bảo đảm và thiếu acceptance test, không phải kết luận Job Object luôn thất bại.

Sửa: kiểm mọi Win32 return/GetLastError, quản lý handles trong finally, fail có kiểm soát khi không enforce ownership; đánh giá tạo suspended → assign job → resume để đóng race. Fake child có grandchild, test cả graceful/forced termination và native-call failure doubles; chỉ kill cây của mình.

### S5 — [P1, gate] Chạy shim --help trực tiếp chưa chứng minh IDE launch hook

Vị trí: `docs/evidence/g2-shim-feasibility.md:87–104`, `:123–136`, `:147–149`.

Bằng chứng thực thi được ghi là direct `antigravity_shim.exe --help`, không phải IDE → wrapper → LS. Cấu hình profile được trình bày như hướng dẫn. Thời điểm review không có `tmp_ide_user_data`; việc thư mục không tồn tại không tự chứng minh chưa từng chạy/đã cleanup, nhưng repo cũng thiếu trace native startup/handshake/cancel/rollback để đối chiếu.

Sửa gate thành `DIRECT_CHILD_PASSTHROUGH_TESTED; IDE_LAUNCH_NOT_PROVEN` đến khi có controlled IDE launch trace, parent/child ownership, startup readiness/port discovery và shutdown test. Không dùng chữ “có thể cấu hình” thay runtime evidence.

### S6 — [P2] Profile thử được hướng dẫn đặt trong repo nhưng chưa được ignore

Vị trí: `docs/evidence/g2-shim-feasibility.md:125–135`, `.gitignore`.

Profile IDE có thể chứa login/cache/credentials. Hướng dẫn tạo `tmp_ide_user_data` trong repo trong khi .gitignore chưa loại profile này hoặc generated executables. Hiện chưa thấy profile thật ở đó; chưa xác nhận secret vào Git.

Sửa: tạo profile/artifacts riêng ngoài repo hoặc ignore rõ trước khi chạy; ghi nguồn/hash binary generated và chính sách artifact. Không xóa profile người dùng khi rollback; chỉ revert setting phần mình sở hữu và đóng đúng processes.

## Inference direction

Passthrough LS gốc vẫn chưa có đường Gemini Web. TLS trên kênh UI ↔ LS không tự chứng minh phải chọn MITM. Báo cáo đã tìm thấy cờ `generative_service_addr`, `model_api_client_type`, `cloud_code_endpoint`; cần khảo sát nguồn, semantics và per-flag routing trên **đúng language server binary** thay vì suy ra từ probe agy.exe của surface khác.

Không đề nghị chặn TLS hoặc patch IDE trong bước tiếp theo. Trước hết sửa transparency và chứng minh IDE launch; sau đó chốt inference hook bằng evidence, song song browser/login/driver gate.
