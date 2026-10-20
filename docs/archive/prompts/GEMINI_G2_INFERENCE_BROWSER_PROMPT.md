# Prompt Gemini — G2 inference/provider gate và browser driver

Copy phần dưới vào Gemini có quyền truy cập repository. Tiếp tục G2, chưa làm G3.

---

Tiếp tục tại `D:\Antigravity-gemini-web`. Đọc AGENTS.md có hiệu lực, `docs/evidence/G2_SHIM_HARDENING_REVIEW.md`, báo cáo gates/shim, `docs/GEMINI_G2_CONTINUE_PROMPT.md` và source hiện tại. Nếu có `.codegraph/`, dùng CodeGraph trước khi tìm/đọc code; không tự index. Giữ thay đổi người khác.

Hiện có shim launch smoke và regressions cũ đạt; chưa có inference hook hoặc browser driver thật. Mục tiêu vẫn Gemini Web trong chat native Antigravity IDE, giữ executor/workspace/approvals của IDE. Không đổi thành Gemini API, agent shell riêng hoặc MCP tool hỏi model phụ.

## 1. Sửa hai lỗi reviewer đã tái hiện

- **H1:** thay keyword-only argv filtering bằng metadata allowlist. Endpoint URL phải bỏ userinfo/query/fragment; chỉ giữ origin/path an toàn nếu cần. Không log arbitrary positional values/prompt/key. Test synthetic query token trên `--cloud_code_endpoint` cả split/equal, URL userinfo và unknown flags; không dùng credential thật.
- **H2:** worker IO exception phải có semantics cancel/failure, không chỉ log rồi trả child exit 0. EOF hợp lệ khác write/read failure. Test parent đóng stdout/stderr sớm, slow reader, child còn sống khi pipe hỏng và cleanup/deadline. Không báo drained success nếu bytes mất.
- Build mới, chạy focused regressions và shim suite; ghi source/binary hash của đúng artifact test. Giữ profile ngoài repo, không thay IDE chính.

## 2. Ưu tiên khảo sát outbound inference/provider hook

- Xác nhận flags/config trên đúng `language_server_windows_x64.exe` mà native IDE dùng; không lấy kết quả agy.exe của VS Code extension/CLI làm bằng chứng thay thế.
- Báo cáo đã thấy `generative_service_addr`, `model_api_client_type`, `cloud_code_endpoint`: xác minh semantics/schema/source của từng cờ trước khi thử.
- Baseline rồi từng override độc lập bằng local fixture do mình sở hữu, trong profile IDE thử. Chỉ ghi metadata đã sanitize; không lưu raw auth/request chat người dùng.
- Chỉ startup/userInfo/auth/catalog/health request không chứng minh inference. Gate phải có prompt synthetic từ native chat đến fixture, response decode đúng lượt và tool read-only round-trip qua executor gốc.
- Không mặc định cần MITM TLS UI ↔ LS hoặc giả lập toàn bộ LanguageServerService. Tìm đường model-provider phía LS và cơ chế native config trước.
- Không chặn TLS, patch IDE hoặc sửa trust store. Nếu thật sự chỉ còn phương án đó, chuẩn bị phương án cụ thể và evidence rồi trình người dùng; chưa triển khai mặc định.
- Nếu schema/route chưa chứng minh, ghi NOT_TESTED/FAILED/UNRESOLVED theo quan sát. Không đổi label, model quota hoặc capability để tạo success giả.

## 3. Làm browser driver thật song song, không phụ thuộc native gate

- User tự login/MFA profile riêng `C:\Users\vhc\.gemini\gemini_web_probe_profile`; không lấy cookie profile cá nhân. Nếu chưa login, hỏi thao tác cụ thể và tiếp tục việc native/driver độc lập trong lúc chờ.
- Driver lifecycle có thể dựng/test bằng owned DOM fixture trước, nhưng account/model/chat acceptance phải dùng Gemini Web thật và ghi riêng.
- Ghép driver vào GeminiBrowserAdapter: status/open/submit receipt/poll/cancel/cleanup có hành vi thực. Contract/stub compile không được tính browser gate PASS.
- Xác minh URL/composer/account/model bằng positive evidence trên đúng surface; không dùng generic textarea hoặc không thấy “Sign in” để suy ra account.
- Thử 3 lượt text/markdown/code fence và cancel; đúng task/turn response binding, không resend accepted prompt để chữa DOM. Cleanup chỉ browser/tab/process của mình.

## 4. Ghép G2 khi hai gate thật đạt

Native prompt → Gemini Web thật → read fixture bằng executor IDE → tool result về Gemini → patch fixture → test PASS và FAIL → final reply đúng exit code trong native chat.

Giữ host tool inventory/policy và binding session/turn/request/call ID; reject stale/duplicate/invalid/ambiguous requests. Mutation outcome unknown không retry. Completion đợi tool settled; cancellation chỉ terminal sau cleanup xác nhận.

## 5. Evidence và dừng

Cập nhật:

- `docs/evidence/g2-inference-provider-probes.md`: đúng binary/version/flag matrix/schema source/criterion results.
- `docs/evidence/g2-browser-live-validation.md`: fixture tests riêng, account/model/3 lượt/cancel thật hoặc blocker cụ thể.
- Native/browser gates và end-to-end report, ADR provider mapping/driver khi có evidence.
- H1/H2 remediation outcome, source/artifact hashes và checks thật; không claim coverage 100% từ test count.

Không redesign UI, làm installer/auto-update, commit/push/publish hoặc chuyển G3–G5. Không thay IDE chính hay đưa credential/profile vào Git. Dừng với phần G2 thực tế đã đạt/chưa đạt và thao tác người dùng cần làm nếu có.
