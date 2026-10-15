# Prompt giao Gemini làm giao diện

Copy phần dưới vào phiên Gemini có quyền truy cập repository. Đây là prompt để người dùng giao việc, không phải chỉ dẫn yêu cầu agent đang lập kế hoạch tự triển khai UI.

---

Bạn phụ trách phần giao diện cho dự án `D:\Antigravity-gemini-web`.

Trước khi viết code, đọc:

1. `docs/IMPLEMENTATION_PLAN.md`
2. `docs/UI_RUNTIME_CONTRACT.md`
3. `docs/GEMINI_UI_HANDOFF.md`
4. AGENTS.md có hiệu lực trong workspace nếu có.

Mục tiêu sản phẩm là dùng Gemini Web trong **chat native của Antigravity IDE**. Hiện khả năng native đang chờ Codex kiểm chứng. Phần bạn làm là launcher UI bằng dữ liệu mô phỏng, độc lập với backend. Không xây một chat app thay thế mục tiêu native, không thể hiện native đã kết nối thật.

Bạn được phép tham khảo https://github.com/miuuyy/codex-chatgpt-web.git, ưu tiên commit `889f291d06339400a8b9c2941473f65cd47d4830`, đặc biệt launcher và các flow setup/activity/settings. Repo này dùng MIT; nếu tái sử dụng code/asset thì giữ thông báo license và ghi rõ nguồn. Không sao chép model list, quota, connector, login flow hoặc thương hiệu ChatGPT sang sản phẩm này.

Phạm vi sửa của bạn chỉ là `apps/launcher/renderer/**`. Dùng React + TypeScript + Vite, package riêng để chạy mock UI độc lập. Nếu chưa có scaffold, tạo trong đúng subtree này. Không sửa root package/lockfile, `packages/**`, Electron main/preload, runtime, shared contracts hay cấu hình IDE/tài khoản.

Làm các màn: thiết lập lần đầu, tổng quan kết nối, phiên/tác vụ, activity/chẩn đoán và settings. Tự chọn hướng thị giác nhất quán, dễ đọc, phù hợp desktop Windows. Bao phủ loading/empty/error/disabled/offline, cửa sổ nhỏ, bàn phím và reduced motion.

Mọi component gọi `LauncherClient` theo hợp đồng, triển khai `MockLauncherClient` riêng. Mock có badge cố định “Demo · dữ liệu mô phỏng”. Không gọi Gemini Web, đọc cookie, chạy lệnh hoặc gắn backend giả trong component. Live mode thiếu preload phải báo chưa kết nối; không tự dùng mock.

Giữ những semantics sau: browser mở không có nghĩa đã đăng nhập; ack hủy không có nghĩa đã hủy; native route chưa kiểm chứng không được bật Install; `outcome_unknown` không tự retry. Không hiển thị quota/context/model không do runtime cung cấp.

Đề xuất thay contract ghi vào `apps/launcher/renderer/CONTRACT_REQUESTS.md`. Không tự sửa tài liệu contract hoặc đổi tên field chung. Giữ nguyên thay đổi hiện có của người khác, chỉ stage file thuộc phạm vi mình nếu được yêu cầu commit.

Bàn giao UI chạy độc lập, README lệnh chạy, typecheck/build và UI behavior checks, ảnh các trạng thái chính có nhãn mock, `UI_NOTES.md` ghi việc đã làm/chưa làm, dependency và attribution. Báo rõ đây là UI mock; native integration và tài khoản thật do Codex nghiệm thu ở bước ghép.
