# Prompt Gemini: sửa G0 và thực hiện nền tảng G1 có điều kiện

Copy nội dung bên dưới vào phiên Gemini có quyền truy cập repository. Đây là nhiệm vụ triển khai giao cho Gemini; không phải chỉ dẫn cho lượt Codex đang review tự sửa code.

---

Bạn thực hiện G1 cho repository `D:\Antigravity-gemini-web`, bắt đầu bằng xử lý các findings review G0.

## Mục tiêu và điều kiện

Mục tiêu sản phẩm vẫn là dùng **Gemini Web trong chat native Antigravity IDE**, giữ executor và quyền công cụ của tác vụ IDE. Người dùng chưa đổi mục tiêu sang CLI/SDK, Gemini API hoặc launcher có executor riêng.

G0 hiện **chưa qua gate native**. Không dùng báo cáo NO-GO hiện tại làm bằng chứng rằng native chắc chắn bất khả thi; có khẳng định sai và các bước chưa thử. Lần này được làm phần G1 độc lập gồm scaffold/contracts/runtime fake, không triển khai route native thật hoặc G2. Nếu native vẫn chưa được chứng minh, ghi `G1 foundation complete; G0/native gate unresolved`, không báo đã hoàn tất G1 native theo kế hoạch gốc.

Đọc trước:

1. AGENTS.md có hiệu lực nếu có.
2. `docs/evidence/G0_CODE_REVIEW.md` — findings và reproductions đã xác minh.
3. `docs/evidence/native-feasibility.md` — báo cáo G0 cần hiệu chỉnh.
4. `docs/IMPLEMENTATION_PLAN.md` — mục tiêu và gate.
5. `docs/UI_RUNTIME_CONTRACT.md` — hợp đồng v0.1 dự thảo.
6. Source `tools/probes/g0/` và git status để giữ nguyên thay đổi của người khác.

Nếu có `.codegraph/`, dùng CodeGraph trước khi tìm/đọc code. Không tự index. Được tham khảo https://github.com/miuuyy/codex-chatgpt-web.git tại commit `889f291d06339400a8b9c2941473f65cd47d4830`; giữ attribution/license cho phần tái sử dụng.

## Bước 0 — Xử lý review G0 trước khi dùng kết quả làm kiến trúc

Sửa R1–R6:

- Tra tài liệu Google mới nhất về custom apps/MCP. Gemini Web có tài liệu MCP nhưng còn eligibility/product constraints; account chưa đăng nhập phải ghi NOT TESTED. Không suy ra MCP nối được localhost hay IDE executor.
- Tách control-plane request `fetchUserInfo` khỏi inference route. Thử endpoint env theo baseline và từng biến độc lập; không gán tác dụng cho một biến khi bật ba biến cùng lúc.
- Lỗi validation của StartCascade chưa phải một inference request thành công. Mọi schema request phải có nguồn đối chiếu.
- Redact bằng metadata allowlist; bỏ raw header/body/prompt và child stdout/stderr chưa sanitize.
- Health/RPC failure trả nonzero; kết quả JSON có status/criterion/observed facts. Mã NOT TESTED phải phân biệt PASS.
- Cleanup server/thread/socket/process và webdriver trong finally, kill rồi wait, output bounded; không bỏ cleanup khi Popen/HTTP/screenshot lỗi.
- Thêm probe README, dependency lock/manifest, flags executable/profile/artifact/timeout, identity checks và hướng dẫn resume login. Bỏ path user/port cố định.

Viết kiểm tra với doubles cho HTTP failure, spawn failure, screenshot failure và redaction synthetic. Không dùng credential thật. Chỉ chạy live probe đã sửa khi cần chứng minh điều mới và có thể cô lập hợp lý. Nếu cần login, hỏi người dùng thao tác rồi tiếp tục việc độc lập; không lấy cookie profile đang dùng.

Cập nhật `native-feasibility.md` theo observed facts, không xóa lịch sử kết quả; thêm review addendum và nguồn/ngày. Nếu chưa đủ bằng chứng, giữ gate native chưa đạt. Không cố ép nhận HTTP 200 bằng response mock rồi gọi đó là inference verified.

## Bước 1 — Scaffold tối thiểu

- TypeScript strict + Node LTS phù hợp máy Windows, npm workspaces. Pin dependency và ghi phiên bản kiểm tra; không đổi runtime toàn máy.
- Tạo `packages/contracts/`, `packages/runtime/`, `packages/native-antigravity/`, `packages/gemini-browser/`, `packages/model-bridge/` ở mức interface/stub khi chưa có implementation đã chứng minh.
- Root scripts tối thiểu: build, typecheck, lint, test và dev:mock.
- Native và browser live stubs trả lỗi rõ `NATIVE_ROUTE_UNVERIFIED`/`LOGIN_REQUIRED` hoặc capability unverified. Không trả success bằng mock khi gọi live adapter.
- Chưa thêm inference protocol REST/Responses/gRPC vào runtime dựa trên suy đoán; ghi phần còn thiếu trong ADR.

## Bước 2 — Biến contract dự thảo thành schema dùng chung

- `packages/contracts` là nguồn chuẩn: Zod runtime schemas + inferred TypeScript types + exports.
- Schema cho snapshot, capability, session/turn, command/ack, operation, event, errors và pagination đúng tài liệu.
- Dùng discriminated unions cho command/result; reject unknown command/field và dữ liệu sai. Không dùng any hoặc result tùy ý để tránh validation.
- Version `0.1`, runtimeInstanceId, revision/sequence và timestamp phải có semantics nhất quán.
- Giữ browser ready khác signed in; unverified khác unavailable; ack khác succeeded; cancel requested khác cancelled.
- Ghi thay đổi contract nếu cần vào changelog/ADR, cập nhật tài liệu cùng schema. Không âm thầm đổi field ở một đầu.

## Bước 3 — Runtime fake có hành vi thật của contract

- Dựng control service in-process cho mock, profile/config store, event subscription và operation lifecycle.
- Dedupe requestId trong phạm vi được ghi rõ: cùng ID + cùng payload trả operation cũ; khác payload trả conflict; concurrent duplicate không chạy hai lần.
- Settings dùng expectedRevision; stale revision bị từ chối.
- Snapshot có mốc event; duplicate/gap/restart có resync rõ. Không tự retry mutation khi chưa rõ kết quả.
- Fake scenarios explicit: first run, login required, native unverified, generating, tool pending/running, cancel pending, disconnected, config conflict, outcome unknown.
- Mọi scenario có mode demo. NativeRoute/modelSelection/toolExecution live giữ unverified trừ khi có evidence riêng thật.
- `integration.apply` live phải bị chặn khi chưa đủ capability; không sửa cấu hình người dùng trong G1. Mock chỉ đổi state demo.
- Tách DEV/live paths bằng hàm có test, không đưa session/profile vào repo. Hợp đồng bảo quản browser credential ghi ADR; chưa lưu credential thật.
- Nếu cần process listener để test collision/ownership, chỉ loopback, xác thực control riêng, startup/shutdown hữu hạn và reject process không thuộc mình. Không giết theo tên agy/Chrome chung.

## Bước 4 — Handoff transport và renderer

- Tạo LauncherClient adapter qua contract; validate request và response tại boundary.
- Ưu tiên in-process transport để chứng minh contract. Nếu làm Electron preload thì API hẹp, không Node trong renderer, không generic execute JS/shell/filesystem.
- Làm renderer harness tối thiểu hoặc demo script gọi đúng client; chưa cần thiết kế UI đầy đủ.
- Kiểm tra trước xem có renderer do người khác đang làm. Không ghi đè. Khi cần UI bổ sung, ghi yêu cầu trong tài liệu handoff và ghép qua interface.
- Live thiếu preload/runtime phải báo disconnected, không fallback mock. Demo có nhãn “Demo · dữ liệu mô phỏng”.

## Bước 5 — Kiểm tra và bàn giao

Test behavior có ý nghĩa:

1. Schema sai/command không được cấp/version sai bị reject.
2. Dedupe đúng cả concurrent duplicate; conflict payload và revision.
3. Ack cancel không chuyển terminal sớm; outcome unknown không retry.
4. Event duplicate/gap/restart và snapshot resync.
5. DEV/live paths không trùng; shutdown dọn tài nguyên sở hữu.
6. Redaction và failure exit/cleanup của probe.
7. Live adapter/preload không có thì không xuất dữ liệu thành công giả.

Chạy build/typecheck/lint/test và demo mock trong môi trường ghi rõ. Kết quả mock/unit không thay live acceptance của G0. Chưa cần test đối xứng từng dòng implementation hoặc coverage giả.

Tạo `docs/evidence/g1-foundation-validation.md` gồm file đã thay đổi, commands, kết quả checks, ADR decisions, limitations và bảng gate. README hướng dẫn clone/install/run mock; không thêm bước đăng nhập/key bắt buộc chỉ để chạy nền tảng mock.

Chỉ sửa trong phạm vi bước 0 và G1 nêu trên; root scaffold/contracts/runtime được phép trong nhiệm vụ này. Không patch IDE binary, đổi route tài khoản, publish hay tự commit/push. Giữ thay đổi của người khác, không dùng `git add .`.

Dừng sau báo cáo G1 foundation. Liệt kê công việc native còn chặn G2 và bước kiểm chứng tiếp theo. Không tự đổi mục tiêu sản phẩm hoặc chuyển sang G2–G5.
