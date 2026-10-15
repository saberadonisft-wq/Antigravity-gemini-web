# Bản vá Codex sau review V1–V8

Ngày: 14/10/2026. Người dùng yêu cầu sửa trực tiếp các lỗi còn lại và tạo prompt G3.

## Đã sửa

- **Reservation trước await:** duplicate dùng chung submission Promise; conflict/BUSY bị chặn trước DOM. Submission thất bại không được trả accepted trên retry. Input failure giải phóng slot; mất Send acknowledgement giữ outcome unknown, không resend.
- **Poll/cancel chạy đồng thời:** request hủy khác xác nhận hủy. Stop false/throw không làm poll thành cancelled; poll cũ không ghi đè cancel đã xác nhận. Poll/cancel coalesce, terminal commit một lần và trả bản sao để caller không đổi cache. Cancel trước Send không gửi prompt.
- **Cleanup epoch:** cleanup vô hiệu hóa pending operations; late poll không phát completion của instance cũ. Cleanup thất bại giữ yêu cầu cleanup trước khi submit mới.
- **Ownership/open/close:** open idempotent, giữ CDP/ownership khi mở lại; queued open bị close vô hiệu hóa. Cleanup dùng budget chung và giữ process reference khi chưa xác nhận đã thoát. Attached browser chỉ disconnect.
- **Surface:** một URL policy dùng chung cho target và DOM; exact Gemini origin/path `/app`, fixture cần loopback allowlist tường minh. DOM mutation kiểm tra lại surface/account/generation và nút visible/enabled. SignOut không còn bị coi là SignIn; bỏ model label từ button bất kỳ có chữ Gemini.
- **Logging:** chỉ trích xuất port/protocol/severity, không chuyển tiếp raw LS message. Quoted cookie/prompt/JSON, unknown flags/path bị loại khỏi metadata. Live status probe không dump target list/conversation URL/title; lỗi trả nonzero.
- **HTTP cleanup:** absolute body deadline và size cap, stop ngắt active socket của fixture, shutdown/join có budget. Test cleanup không nuốt lỗi; kiểm tra temp path trước xóa. Cancel fixture dùng response đủ dài để kiểm chứng Stop.

13 tests mới tại [concurrency.test.ts](../../packages/gemini-browser/src/concurrency.test.ts). Trước vá, 11 ca concurrency/lifecycle ban đầu đều FAIL; sau vá tất cả đạt. Hai ca bổ sung kiểm tra URL policy và queued open/close. Các tests dùng driver/DOM/socket fixtures, không dùng credential/account thật.

## Checks đã chạy

| Lệnh | Kết quả | Phạm vi |
|---|---|---|
| `npm run build` | PASS, khoảng 4,68s | 5 workspaces |
| `npm test` | **50/50 PASS**, khoảng 5,59s | contracts 8; browser 20; bridge 4; native 1; runtime 17 |
| `npm run typecheck` | PASS, khoảng 4,11s | `tsc --noEmit` |
| `python -m unittest tools/probes/g2/test_probe_safety.py` | **4/4 PASS** | Queue/metadata/dripping HTTP body |
| `python tools/probes/g2/verify_probe_timeout.py` | **3/3 PASS**, khoảng 4,25s | Sanitization, incomplete body, fake-child cleanup |
| `node --check tools/probes/g2/probe_live_gemini.mjs` | PASS | Syntax, không chạy live profile |

Silent-child scenario budget 3s, cleanup budget 2s; elapsed khoảng 3,07s. Npm test có watchdog ngoài 90s. Sau checks không thấy Chrome profile `gemini-driver-test-profile-*`/`gemini-v3-test-profile-*`, shim hoặc fake child còn chạy. Đây là quan sát các ca đã chạy, không phải cam kết zero-orphans trong mọi trường hợp.

`lint` hiện là alias typecheck, không có lint rules độc lập. Shim source hash vẫn `F7CD5F15F5F94A91B6457098DB51274C19D0B48E661F1CD422730308C7552EF8`, không sửa trong lượt này. Shim 9/9 và G0 6/6 là kết quả lượt kiểm chứng trước, không rerun ở đây.

## Giới hạn và bàn giao

- Native raw artifact vẫn 4 lần `TIMEOUT_OR_NO_PORT`, chưa RPC. Thiếu IDE handshake/init contract là **giả thuyết** chưa được chứng minh bằng controlled comparison.
- Gemini báo live profile needs_user_action trước lượt sửa. Codex không refresh/login/send prompt live trong lượt này.
- **G2 native/browser E2E chưa nghiệm thu.** Theo yêu cầu mới, G3-A resilience/context có thể làm độc lập; Gate G3 live vẫn cần Gate G2 thật.
- Generation chưa xác định đã dừng giữ BUSY; cần cleanup/reconciliation trước lượt mới. Recovery G3 không được resend accepted/unknown prompt.
- Không thay IDE chính, patch binary/trust store, commit/push hoặc triển khai G4–G5.

Prompt: [GEMINI_G3_PROMPT.md](../GEMINI_G3_PROMPT.md).
