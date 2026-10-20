# Prompt G2 — kiểm chứng transparent shim và browser gate

Prompt đề xuất để người dùng giao Gemini. Lượt review chỉ tạo tài liệu; chưa tạo shim hoặc thay route IDE.

---

Tiếp tục G2 tại `D:\Antigravity-gemini-web`. Ưu tiên nghiên cứu transparent wrapper/shim qua launch hook của Antigravity IDE trong môi trường thử riêng, đồng thời hoàn tất browser gate khi người dùng login. Chưa làm G3.

Đọc AGENTS.md có hiệu lực, `docs/evidence/G2_GATE_REVIEW_ADDENDUM.md`, báo cáo gates/end-to-end, ADR 0002 và `docs/GEMINI_G2_CONTINUE_PROMPT.md`. Nếu có `.codegraph/`, dùng CodeGraph trước khi tìm/đọc code; không tự index. Giữ thay đổi của người khác.

Mục tiêu giữ nguyên: Gemini Web trong chat native IDE với executor/approvals/workspace của IDE. Chưa được thay bằng Gemini API, agent độc lập hoặc MCP tool hỏi model phụ.

## 1. Sửa bằng chứng và hai lỗi còn thiếu

- A1: deferred inFlight rejection không được tạo unhandledRejection khi leader-only command failure; test cả duplicate waiters/error/cleanup.
- A2: async resync phải thật sự chờ authoritative snapshot, buffer events và replay theo epoch/sequence; test delayed snapshot, restart và timeout.
- Gate adapter contract khác live driver. G2-C.6 phải ghi đúng mức contract/stub cho đến khi có runtime browser thật.
- Lỗi external-server helper không chứng minh IDE đóng kín toàn bộ. Native prompt/response/tool loop chưa thử phải NOT TESTED/unverified; không kết luận từ TLS hoặc catalog.

## 2. Khảo sát launch hook trước khi viết shim

- Xác nhận version/hash và source của `codeiumDev.languageServerBinaryPath`, cách đọc setting, precedence và kiểu binary mà IDE spawn.
- Kiểm tra args/env/working directory, stdio, startup port discovery/CSRF/certificate metadata, exit/terminate và restart contract. Không in giá trị token/key hoặc user payload; log allowlist metadata.
- Không patch `extension.js`, binary hoặc hosts; không chặn TLS hay thay trust store. Không thay cấu hình IDE đang dùng.
- Trước hết dùng executable fixture/doubles để đo spawn contract, không gọi model thật và không dùng quota như bằng chứng provider routing.
- Không mặc định wrapper cần implement toàn bộ LanguageServer RPC. Đánh giá wrapper transparent khởi chạy language server gốc và giữ executor; nếu cần protocol proxy thì lập phương án riêng dựa trên schema xác minh được.

## 3. Prototype transparent wrapper trong repo

- Chỉ tạo trong `tools/probes/g2/shim/`, có build/run/cleanup docs và tests; pin toolchain đã kiểm tra.
- Forward args/env/working directory/stdio đúng hợp đồng; secret được pass khi cần cho child nhưng không ghi log hoặc đưa vào artifact.
- Giữ port discovery và exit status của language server gốc. Terminate/kill/wait chỉ process tree của mình; không giết theo tên process chung.
- Chạy trước với fake child để thử startup/stdio/exit/error/cancel. Tạo snapshot cấu hình thử/rollback cụ thể trước khi nối IDE.
- Sau đó thử IDE với user-data/workspace profile tách biệt nếu sản phẩm hỗ trợ. Không copy credential/profile đang dùng. Nếu cần login native profile mới, hỏi người dùng thao tác và tiếp tục việc độc lập.
- Nếu không thể cô lập setting khỏi IDE chính, chuẩn bị diff/backup/rollback và dừng việc apply để người dùng quyết định.

Gate shim-launch: IDE khởi chạy wrapper, wrapper khởi chạy language server gốc, port discovery và shutdown hoạt động. Gate này chỉ chứng minh launch hook, không chứng minh model route.

## 4. Tìm inference hook riêng

- Xác định request suy luận phát sinh từ UI hay language server, dựa trên source/config/protocol có nguồn; phân biệt control-plane, executor và model backend.
- Chỉ chọn đường đổi endpoint/adapter có thể kiểm chứng với server/fixture do mình sở hữu. Không thu raw request chat người dùng, OAuth token hay cookie để suy đoán giao thức.
- Chứng minh prompt synthetic từ native chat đến local fixture, trả response đúng chat, rồi read-only tool request/result qua executor gốc.
- Wrapper chỉ truyền mọi thứ về server gốc mà chưa đổi inference không được tính hoàn thành. Không gán label Gemini Web/no quota vào kết quả passthrough.
- Nếu không tìm được inference hook, ghi đúng launch hook đạt/inference chưa đạt, phương án tiếp theo và giới hạn. Không viết lại toàn bộ server một cách suy đoán hoặc kết luận toàn sản phẩm bất khả thi từ một probe.

## 5. Browser gate độc lập

- Người dùng login bằng profile riêng `C:\Users\vhc\.gemini\gemini_web_probe_profile`; không lấy cookie profile cá nhân, không tự điền credential/vượt MFA.
- Sau login, kiểm tra account/composer/model đúng URL, 3 lượt chat thật, markdown/code fence và cancel. Giữ response binding đúng lượt; accepted Send không tự resend.
- Ghép driver thật vào `GeminiBrowserAdapter`, không chỉ sửa interface. Runtime checkStatus/open/submit/poll/cancel/cleanup phải phản ánh hành vi browser.
- Phân biệt probe login, browser automation và account MCP eligibility. MCP hoặc login đạt không tự chứng minh native executor đã nối.

## 6. Bàn giao G2

Tạo `docs/evidence/g2-shim-feasibility.md`: launch contract, source/version/hash, fake-child checks, isolated IDE outcome, inference-hook evidence, thay đổi và rollback.

Cập nhật native/browser gates và end-to-end report. Sau khi native fixture + browser thật đạt mới ghép read → patch → test PASS/FAIL → final reply và cancel theo prompt G2 gốc.

Chạy build/typecheck/tests và probe regressions. Mock tests, shim-launch, inference route, browser account và E2E là các nhóm evidence riêng. Không báo G2 complete từ test xanh hoặc chỉ chạy qua wrapper.

Không commit/push/publish, đổi cấu hình IDE chính, patch source cài đặt hoặc chuyển G3–G5. Dừng sau evidence kết luận phương án shim và phần G2 thực tế đã đạt/chưa đạt.
