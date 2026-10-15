# Kiểm tra G2 shim sau hardening

Ngày: 14/10/2026. Review source và báo cáo mới, build lại shim/fake child, chạy suite và controlled regressions. Không sửa source, mở IDE, thay config hoặc gọi inference thật trong lượt này.

## Kết quả được xác nhận

- `tools/probes/g2/shim/build.ps1` build thành công cả shim và fake child.
- `python -m unittest tools/probes/g2/shim/test_shim.py`: 7/7 PASS.
- Independent argv test: empty/tab/path-space-trailing-backslash/backslash-before-quote/Unicode được giữ đúng.
- Independent slow-reader 12.000 byte: nhận đủ 12.000 byte, exit 0; lỗi cũ đã hết trong ca này.
- Source main process của IDE có `codeiumDev.machineLanguageServerBinaryPath` tại offset 12837392 trong `resources/app/out/main.js` đọc ngày review.
- User-provided trace và báo cáo ghi IDE → shim → LS, port announcement và shutdown còn 0 shim/LS. Ghi nhận **IDE launch smoke, theo trace đã lưu**. Review không chạy lại IDE, không nâng kết quả thành native inference/tool acceptance.
- `.gitignore` đã loại generated executables và profile/tmp trong repo; profile thử được chuyển ra ngoài repo.

## Hai lỗi mới còn lại

### H1 — [P1] Logger vẫn dump giá trị không thuộc keyword blacklist, lộ query token trong URL

Vị trí: `tools/probes/g2/shim/AntigravityShim.cs:200–243`, `:286–288`.

Split/equal flags nhạy cảm đã được xử lý tốt hơn. Nhưng `--cloud_code_endpoint=https://example.invalid/rpc?token=...` có keyPart là cloud_code_endpoint nên giá trị nguyên được log. Đây chưa phải metadata allowlist như prompt yêu cầu.

Controlled test dùng Python echo child và `SYNTHETIC_ENDPOINT_QUERY_SECRET`: marker xuất hiện nguyên trong log. Không dùng real credential hoặc gửi request tới URL.

Sửa: chỉ log metadata/flag names đã cho phép; port có thể giữ sau numeric validation; endpoint chỉ origin/path được sanitize, bỏ userinfo/query/fragment. Không dump arbitrary positional values, prompt/path riêng hoặc exception chứa raw input. Thêm split/equal URL query/userinfo và unknown positional-value tests.

### H2 — [P1] Forwarding pipe error vẫn có thể trả exit success

Vị trí: `AntigravityShim.cs:374–424`, `:457–467`.

Worker lưu IOException nhưng main bỏ qua IOException; các exception khác chỉ log rồi vẫn trả child exit code. Join hoàn thành không có nghĩa bytes đã được chuyển thành công. Drain timeout 125 xử lý thời gian chờ, chưa xử lý lỗi write/read.

Controlled test: đóng stdout của wrapper từ parent trước khi synthetic child viết 512 byte. Shim trả exit 0, không báo forwarding failure. Không có IDE hay network trong test.

Sửa: định nghĩa pipe-closed là cancel/forwarding failure theo contract, dọn child của mình nếu cần và trả mã khác success khi mất bytes. Phân biệt EOF hợp lệ với IO exception. Test closed stdout/stderr, write failure và child-alive backpressure; các deadline không chỉ bắt đầu sau child.WaitForExit.

## Provenance và giới hạn

Report pinned hash khác binary tồn tại lúc bắt đầu review; việc build lại tiếp tục tạo checksum mới. Cập nhật hash theo artifact thực sự được nghiệm thu, không suy ra reproducible build chỉ từ một checksum.

Sau build trong lượt review:

- Source AntigravityShim.cs: `3309B4500C66946760867DE21C304955F320C4ACEEA6BAFF3179456356432B68`.
- Shim: `1975515909DB1F19F4E670ECB22165BE4DC9762D08445C5289CA327DC672CB27`.
- Fake child: `5CEA8A2527CADBC5EE159EA8DCF98C353694D1A527F428E21550032DEEED9A46`.

Job Object return checks và grandchild acceptance test tốt hơn trước. Process.Start vẫn trước AssignProcessToJobObject; broad guarantee “không có spawn race trong mọi trường hợp” chưa được chứng minh. Phạm vi PASS là test grandchild đã chạy, không universal proof.

Port announcement và process cleanup là launch smoke. Chưa có decoded native prompt/response fixture/tool read-only round-trip. Kênh UI ↔ LS TLS không tự chứng minh phải chọn MITM; cần khảo sát outbound provider hooks trên đúng binary trước.

Browser runtime vẫn contract/stub. User login profile riêng chỉ mở bước kiểm thử tiếp theo; cần driver thực sự rồi 3 lượt/cancel trước native/browser E2E.

## Bước tiếp theo

Sửa H1/H2, rồi ưu tiên inference/provider gate và browser driver. Không cần lặp lại toàn bộ scaffold/happy-path tests để thay việc kiểm chứng native. Chưa chuyển G3 hoặc gọi Gemini Web integrated từ launch smoke.

Prompt tiếp tục: [GEMINI_G2_INFERENCE_BROWSER_PROMPT.md](../GEMINI_G2_INFERENCE_BROWSER_PROMPT.md).
