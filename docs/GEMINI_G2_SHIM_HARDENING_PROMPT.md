# Prompt Gemini — sửa shim và kiểm chứng launch hook thật

Copy phần dưới vào Gemini có quyền truy cập repository. Nhiệm vụ vẫn thuộc G2, chưa làm G3.

---

Tiếp tục G2 ở `D:\Antigravity-gemini-web`. Đọc AGENTS.md có hiệu lực, `docs/evidence/G2_SHIM_CODE_REVIEW.md`, `docs/evidence/g2-shim-feasibility.md`, `docs/GEMINI_G2_SHIM_SPIKE_PROMPT.md` và source shim/tests. Nếu có `.codegraph/`, dùng CodeGraph trước khi tìm/đọc code; không tự index. Giữ thay đổi của người khác.

31 tests TS và 4 tests shim hiện có xanh, nhưng reviewer đã tái hiện argv corruption, flag-equals secret logging và output loss khi slow reader. Không dùng các test hiện tại để tiếp tục khẳng định shim “100% transparent”. Launch hook trong IDE chưa được chứng minh bằng direct --help.

## 1. Sửa S1–S4 trước khi thử IDE

- **S1:** Implement Windows argv quoting đúng và có tests round-trip từng token. Bao phủ empty string, space/tab/newline, Unicode, paths kết thúc backslash, backslash runs trước quotes, quotes embedded. Fake child xuất token JSON cho test so equality, không chỉ count.
- **S2:** Bỏ raw argv logging, dùng metadata allowlist; che cả `--key value` và `--key=value`. Test synthetic csrf/extension token/API key trên log, exception và diagnostic paths. Không test bằng real credential.
- **S3:** Output workers phải drain EOF đầy đủ hoặc trả forwarding failure rõ. Không Join 500ms rồi exit 0 với pending bytes. Test slow consumer, burst > pipe capacity, stdout/stderr đồng thời, binary payload, early exit và closed pipe. Dùng deadline/backpressure có semantics, tránh wait vô hạn.
- **S4:** Check CreateJobObject/SetInformationJobObject/AssignProcessToJobObject return + GetLastError. Cleanup handles/process trong finally và fail-closed nếu ownership không enforce. Đánh giá suspended launch → assign job → resume. Fake child spawn grandchild; assert child/grandchild đều dừng khi wrapper graceful/forced exit. Test failure path không chỉ wrapper PID.

Chạy regression từ source build mới, ghi hash compiler/source/artifact. `build.ps1` phải build cả fake child hoặc có script riêng được tài liệu hóa; không dựa vào executable cũ tình cờ đã có. Output/artifacts generated không nằm trong source commit mặc định.

## 2. Sửa gate labels và profile boundary

- Giữ direct child passthrough khác IDE launch hook. Trước khi thực nghiệm IDE, ghi `IDE_LAUNCH_NOT_PROVEN`.
- Profile thử ngoài repo. Nếu dùng đường dẫn trong repo thì ignore trước khi tạo; không đưa login/cache/generated binaries vào Git.
- Rollback revert setting phần mình sở hữu, đóng đúng processes và giữ profile/login nếu người dùng cần. Không xóa profile toàn bộ như thao tác mặc định.

## 3. Chứng minh IDE → shim → LS trong profile riêng

- Xác nhận đúng surface/version/source setting, giá trị binary path và precedence.
- Chuẩn bị command/profile/settings fixture tách biệt; không thay IDE chính, không patch source/binary hoặc hosts/trust store.
- Thực sự khởi chạy IDE thử qua wrapper sau tests đạt. Không copy credential/profile hiện dùng. Nếu cần user login, hỏi thao tác cụ thể rồi tiếp tục phần độc lập.
- Thu sanitized metadata chứng minh IDE spawn shim, shim spawn LS gốc, startup readiness/port discovery và shutdown/cancel hoạt động. Không log CSRF args, raw prompt/tool output hoặc network auth.
- Kiểm tra model native và read-only fixture của LS gốc vẫn hoạt động nếu account thử đủ điều kiện. Điều này chỉ là compatibility/launch acceptance, chưa Gemini Web.
- Nếu chỉ chạy --help/CLI fixture, ghi đúng giới hạn, không đánh dấu IDE gate PASS.

## 4. Khảo sát inference hook đúng binary, chưa MITM

- Xác định outbound inference trong LS gốc, đọc schema/flags/config có nguồn. Báo cáo có `generative_service_addr`, `model_api_client_type`, `cloud_code_endpoint`: thử baseline và từng override độc lập trên đúng `language_server_windows_x64.exe`, không lấy kết quả `agy.exe` thay cho nó.
- Tách userInfo/auth/catalog/control-plane khỏi request suy luận và tool executor. Local mock chỉ metadata synthetic, không thu credential hoặc prompt thật.
- Không mặc định phải giải mã UI ↔ LS TLS hoặc fake toàn bộ LanguageServerService. Tìm đường provider/endpoint phù hợp trước.
- Khi có đường khả thi, chứng minh native prompt → local fixture response → tool read-only qua executor gốc; sau đó mới chuyển fixture model sang Gemini Web. Nếu chưa có hook, ghi UNRESOLVED/NOT_TESTED và blocker chính xác, không nâng capability.

## 5. Browser và E2E G2

Người dùng tự login profile riêng; hoàn tất composer/account/model, 3 lượt/cancel và ghép driver thật vào GeminiBrowserAdapter. Login probe không thay runtime acceptance.

Chỉ khi native inference + browser gates thật đạt mới ghép read → patch → test PASS/FAIL → final reply/cancel theo prompt G2 gốc. Giữ executor/approvals/workspace của IDE, không thay bằng API hoặc agent shell riêng.

## 6. Báo cáo và dừng

Cập nhật remediation S1–S6, source/artifact hashes, controlled tests, IDE launch trace/rollback, inference flags evidence và browser/E2E gates. Phân biệt direct child, IDE launch, inference route, browser driver và full E2E.

Không tự commit/push/publish, không sửa cấu hình IDE chính hoặc chuyển G3–G5. Dừng sau report G2 cho biết phần nào đã đạt, phần nào chưa và cần người dùng thao tác gì.
