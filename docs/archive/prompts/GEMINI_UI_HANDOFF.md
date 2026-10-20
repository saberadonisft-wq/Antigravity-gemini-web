# Bàn giao phần giao diện cho Gemini

Trạng thái: thiết kế phạm vi công việc, chưa giao diện nào được triển khai. Người dùng sẽ giao tài liệu này cho Gemini. Đọc cùng [kế hoạch](../plans/IMPLEMENTATION_PLAN.md) và [hợp đồng dữ liệu](../guides/UI_RUNTIME_CONTRACT.md).

## 1. Sản phẩm cần thể hiện

Ứng dụng desktop hỗ trợ nối Gemini Web vào chat native của Antigravity IDE. Launcher phụ trách thiết lập, kết nối, trạng thái tác vụ và chẩn đoán. Không xây thêm một chat app làm màn hình trung tâm.

Tên hiển thị tạm: **Antigravity · Gemini Web**. Đây là phần mềm độc lập; không thể hiện là sản phẩm chính thức của Google. Không hứa “unlimited”, “zero risk”, “không tốn quota” hoặc “native connected” khi chưa có bằng chứng runtime.

Gemini được tham khảo repo https://github.com/miuuyy/codex-chatgpt-web.git, ưu tiên snapshot `889f291d06339400a8b9c2941473f65cd47d4830`. Tham khảo cách tổ chức launcher, onboarding, activity và settings; không giữ nội dung ChatGPT/Codex, model list, connector hay quota của repo đó.

## 2. Ranh giới sở hữu

**Gemini sở hữu:** `apps/launcher/renderer/**` gồm React components, CSS/assets, mock client, UI tests, package.json và lockfile độc lập của renderer, README chạy UI, UI_NOTES và CONTRACT_REQUESTS.

**Codex sở hữu:** Electron main/preload, backend/runtime, browser automation, Antigravity adapter, root workspace và lockfile, shared contracts, cấu hình tích hợp, installer, tài liệu kế hoạch.

Gemini không sửa `packages/**`, `apps/launcher/main/**`, root package/lockfile, cấu hình người dùng, browser profile hoặc repository-wide rules. Không cài MCP/tunnel hay đổi route IDE. Thay đổi ngoài ownership phải ghi đề xuất để ghép, không tự triển khai.

Trước khi bắt đầu, kiểm tra file/AGENTS.md mới đã xuất hiện trong workspace. Nếu renderer đã có thay đổi của người khác, giữ nguyên và trao đổi thay vì ghi đè. Khi commit, chỉ stage file sở hữu.

## 3. Cách dựng độc lập

- React + TypeScript strict + Vite; CSS variables cho theme, spacing và typography. Không phụ thuộc Electron để chạy bản demo trong browser.
- Khởi tạo package riêng tại renderer nếu chưa có; các script tối thiểu `dev`, `build`, `typecheck` và test UI cho behavior quan trọng.
- Mọi thao tác đi qua `LauncherClient`. Component không chứa URL backend và không truy cập `window.require`, filesystem, shell hay Gemini DOM.
- Dựng `MockLauncherClient` bám hợp đồng; chọn mock/live bằng cấu hình rõ ràng. Live thiếu preload phải báo lỗi, không tự tạo dữ liệu thành công.
- Mock chỉ chứa dữ liệu synthetic. Scenario switch chỉ xuất hiện trong demo/dev.
- Chưa chốt Electron browser host thì dùng vùng hiển thị trạng thái và nút “Mở trình duyệt đăng nhập”; không nhúng Gemini bằng iframe.
- Chỉ thêm dependency phục vụ trực tiếp UI. Ghi lại package/version và phần code/asset lấy từ upstream trong UI_NOTES; giữ attribution nếu tái sử dụng.

## 4. Các màn hình v0.1

### A. Thiết lập lần đầu

Luồng ba bước: kiểm tra Antigravity → đăng nhập Gemini → kiểm tra kết nối và xem thay đổi tích hợp.

- Kiểm tra IDE hiển thị phiên bản nếu runtime có; chưa tìm thấy khác với phiên bản không hỗ trợ.
- Browser mở được khác với đăng nhập thành công. Khi có challenge, chỉ rõ người dùng cần hoàn tất trong browser.
- Route native chưa được xác minh thì không cho nhảy sang “Hoàn tất”. Cho xem trạng thái và log lý do.
- Kiểm tra end-to-end có thể gửi một tin nhắn thử: nêu rõ ở nút/description trước khi chạy.
- Cài route: hiển thị preview tác động do backend cung cấp, nút xác nhận, tiến trình và kết quả. Nếu config conflict, giữ lỗi và hướng xem chi tiết.

### B. Tổng quan

- Bốn trạng thái độc lập: runtime, Antigravity integration, browser/account, model.
- CTA theo trạng thái: mở browser, kiểm tra lại, xem lỗi, xem trước tích hợp. Không hiện tất cả nút như đều dùng được.
- Tóm tắt tác vụ đang chạy và thời điểm kiểm tra gần nhất.
- Capability chưa kiểm chứng dùng “Chưa kiểm chứng”; không dùng dấu xanh hoặc số 0 thay unknown.
- Không có gauge quota/context giả. Chỉ hiển thị nếu runtime cung cấp dữ liệu và nhãn nguồn đo rõ ràng.

### C. Phiên và tác vụ

- Danh sách theo workspace/task, model, trạng thái và thời điểm; MVP chỉ một active turn.
- Chi tiết các giai đoạn chuẩn bị, gửi, đang phản hồi, đợi tool, chạy tool, hoàn tất hoặc lỗi.
- Nút hủy chỉ enabled khi `canCancel`; sau click hiển thị “Đang yêu cầu hủy”, chờ runtime xác nhận.
- `outcome_unknown`: giải thích chưa xác định thao tác đã hoàn tất chưa, dẫn tới Activity; không cung cấp retry tự động.
- Không cần hiển thị raw prompt, raw terminal output hoặc bản sao hội thoại IDE.

### D. Hoạt động và chẩn đoán

- Lọc theo mức độ lỗi và session, thứ tự thời gian ổn định, empty state rõ.
- Hiển thị summary và correlation ID, nút sao chép ID, xuất log an toàn khi capability cho phép.
- Long-running check hiển thị từng kết quả passed/failed/unsupported/not_run; không chỉ một spinner vô hạn.
- Mất runtime: giữ trạng thái cuối kèm timestamp, cho reconnect/check; không xóa log đang xem.

### E. Cài đặt

- Theme system/light/dark; ngôn ngữ Việt/Anh qua một lớp copy tập trung.
- Mức log normal/verbose redacted, kèm mô tả không ghi credential hoặc nội dung prompt.
- Model selector chỉ hiện lựa chọn từ runtime; trạng thái chưa xác minh thì disabled và có lý do.
- Disconnect/restore integration mở preview trước khi apply; không cho chạy khi runtime báo active turn.
- Hiển thị app version, contract version, host version nếu có và liên kết repo/license.
- Các tính năng chưa có như auto-update, multi-account, MCP wizard, logout/profile deletion không có nút giả. Có thể ghi roadmap trong UI notes, không cần cho vào UI.

## 5. Yêu cầu tương tác và trình bày

- Ưu tiên thông tin giúp người dùng hiểu đang kết nối gì, tác vụ ở bước nào và nên làm gì tiếp.
- Có trạng thái empty/loading/error/disabled/offline cho từng thao tác, không chỉ happy path.
- Desktop viewport kiểm tra: 1280×800, 1024×720 và 800×600; ở cửa sổ nhỏ cho nội dung cuộn, hành động quan trọng vẫn truy cập được.
- Điều hướng bàn phím, focus ring rõ, modal giữ/khôi phục focus, label cho icon button, hỗ trợ reduced motion.
- Màu không phải tín hiệu duy nhất; badge có chữ. Không animation hoặc progress phần trăm giả cho công việc chưa biết thời lượng.
- Chuỗi lỗi, workspace label và model name dài không phá layout. Thời gian hiển thị theo locale, dữ liệu gốc UTC.
- Demo luôn có nhãn “Demo · dữ liệu mô phỏng”, kể cả screenshot bàn giao.
- Gemini tự đề xuất hướng thị giác nhất quán; không cần bám pixel của launcher tham khảo, không đưa chi tiết giao thức nội bộ vào flow người dùng.

## 6. Kịch bản UI cần bàn giao

1. First-run, chưa kiểm chứng route và chưa đăng nhập.
2. Có browser nhưng cần thao tác đăng nhập/challenge.
3. Đã đăng nhập nhưng IDE không hỗ trợ native route.
4. Kết nối sẵn sàng, chưa có phiên.
5. Tác vụ đang tạo phản hồi và đang chạy tool.
6. Hủy đang chờ xác nhận; sau đó cancelled.
7. Config conflict/model unavailable/context too large.
8. Runtime mất kết nối rồi hồi phục bằng snapshot mới.
9. Thao tác ghi chưa rõ kết quả, không tự retry.

Các trạng thái “kết nối sẵn sàng” trong mock chỉ minh họa UI, không phải bằng chứng tích hợp native.

## 7. Nghiệm thu phần giao diện

- Có hướng dẫn chạy độc lập từ renderer, build và typecheck đạt.
- Có kiểm tra behavior quan trọng: cancel pending không thành cancelled sớm, unsupported chặn install, reconnect dùng snapshot, live thiếu preload không chuyển mock.
- Kiểm tra trực quan các viewport và kịch bản; có ảnh hoặc mô tả bằng chứng ghi rõ mock.
- Không có hardcoded success response trong component; không có credential thật, model/quota bịa hoặc network request tới Gemini.
- Có `UI_NOTES.md` ghi màn hình đã xong, check đã chạy, giới hạn, dependency và attribution.
- Có `CONTRACT_REQUESTS.md` nếu cần bổ sung field/event; không tự thay contract ngoài renderer.
- Chạy được mock UI là hoàn thành phần giao diện, không phải hoàn thành sản phẩm end-to-end.

## 8. Quy trình ghép với Codex

1. Gemini bàn giao renderer và hướng dẫn chạy; Codex kiểm tra ownership và contract.
2. Codex cung cấp shared schemas + preload adapter thật theo G1/G4.
3. Gemini thay local mock type bằng shared type, giữ mock client cho UI tests/demo.
4. Hai bên xử lý contract gaps qua thay đổi có version.
5. Chạy UI smoke với runtime thật và browser/account thật; ghi riêng kết quả mock và live.
