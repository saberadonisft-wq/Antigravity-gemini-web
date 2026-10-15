# Báo Cáo Kiểm Chứng Browser Driver và Tích Hợp Gemini Web (G2-C)

**Cập nhật sau bản vá Codex:** browser 20/20 và monorepo 50/50 tests pass, gồm concurrent submit/poll/cancel, cleanup epoch, ownership và URL policy. Xem [g2-codex-remediation-validation.md](g2-codex-remediation-validation.md). Các số 7 tests dưới đây là mốc trước bản vá; live snapshot do Gemini ghi trước lượt sửa, Codex không refresh hoặc chạy chat live.

**Ngày kiểm chứng:** 14/10/2026  
**Mục tiêu:** Kiểm chứng trình điều khiển trình duyệt (`GeminiBrowserDriver`), bộ chọn DOM bằng chứng dương (`gemini-selectors.ts`), khắc phục triệt để các phát hiện review V2–V6, vòng đời tiến trình, và kiểm thử toàn diện trên DOM fixture cùng trạng thái tài khoản thực tế.

---

## 1. Khắc Phục Lỗ Hổng & Thắt Chặt Kỹ Thuật (V2–V6 Remediations)

1. **V2 (Ownership Tracking & Attached Browser Cleanup):**
   - Phân biệt tường minh: `isOwnedProcess` (tiến trình do driver tự spawn) vs `isAttachedTarget` (chỉ kết nối CDP vào phiên/tab có sẵn).
   - Khi driver chỉ attach vào target ngoài: hàm `close()` chỉ ngắt kết nối WebSocket CDP; **tuyệt đối không gửi lệnh `Browser.close` và không gọi `taskkill`** để không ảnh hưởng đến các cửa sổ hoặc tab khác ngoài ownership.
   - Khi tiến trình là do driver tự spawn (`isOwnedProcess = true`): gửi `Browser.close` với timeout 2.0s, thực hiện `taskkill /F /T /PID` với timeout 3.0s, chờ thoát với deadline hữu hạn, và kiểm tra xác nhận tiến trình đã thoát thực sự.

2. **V3 (Surface & Origin Validation + Account & Model Detection):**
   - Xác minh nguồn gốc URL (origin allowlist):
     - Chế độ Live: bắt buộc origin phải là `https://gemini.google.com`. Bất kỳ bề mặt nào không thuộc allowed origin (như `https://example.invalid/support` hoặc trang có generic textarea khác) đều bị từ chối với `isAllowedSurface = false`, `browserState = "closed"` (hoặc `"unsupported_surface"`), `accountState = "unknown"`.
     - Chế độ Fixture: tách biệt tường minh qua cờ `fixtureMode: true` và `allowedOrigins: [...]`. Không bao giờ fallback vào fixture shortcut trong môi trường live.
   - Nhận diện tài khoản: chỉ báo `signed_in` khi có bằng chứng dương (avatar). Tuyệt đối không suy diễn `signed_in` chỉ từ việc tìm thấy composer.
   - Nhận diện model: trích xuất từ phần tử `MODEL_INDICATOR` nếu có; nếu không tìm thấy để `undefined`, **tuyệt đối không tự điền hay giả mạo `"Gemini 1.5 Pro"`**.

3. **V4 (Completion Semantics & Partial Timeout Handling):**
   - Chỉ trả `status: "completed"` khi và chỉ khi thế hệ đã hoàn tất đầy đủ (`pollRes.completed === true`).
   - Khi timeout xảy ra nhưng đã nhận một phần văn bản (partial text stream): status trả về là `"failed"` kèm mã lỗi `TIMEOUT`, giữ lại văn bản dở dang trong trường `text` để chẩn đoán. Tuyệt đối không đánh tráo partial stream thành `completed`.
   - Hàm `sendPrompt()` reject ngay lập tức khi phát hiện trạng thái không phải `completed`.

4. **V5 (Cancellation: Requested vs Confirmed & Terminal Immutability):**
   - Tách biệt hai trạng thái: `cancel_requested` và `cancel_confirmed`.
   - Khi `clickStop()` trả về `false` hoặc ném ngoại lệ: báo `cancelled: false`, không tự chuyển đổi turn thành `cancelled`.
   - Khi click thành công: kiểm tra xác nhận trên DOM trong tối đa 2.0s để chắc chắn `isGenerating === false` mới xác nhận `cancelled: true`.
   - Bảo vệ trạng thái terminal: Từ chối yêu cầu hủy trên turn đã hoàn tất hoặc đã terminal (`completed`, `failed`, `cancelled`).
   - Kết quả terminal là bất biến (immutable): các lần gọi `pollResponse()` tiếp theo trên cùng một turn luôn trả về kết quả terminal nguyên vẹn, không đổi trạng thái.

5. **V6 (Turn Reservation, Idempotency & Overlapping Turn Prevention):**
   - Đặt chỗ lượt (`record.state = "reserved"`) trong `activeTurns` **trước khi thực hiện bất kỳ thao tác DOM nào** (`inputPrompt`, `clickSend`).
   - Chống gửi lặp: gọi lại cùng `turnId` với cùng nội dung prompt sẽ trả về receipt đã có một cách idempotent, không click Send ra DOM lần thứ hai.
   - Chống xung đột: gọi lại cùng `turnId` với nội dung prompt khác nhau sẽ bị từ chối với lỗi `CONFIG_CONFLICT`.
   - Chống xung đột song song: từ chối với lỗi `BUSY` nếu có một turn khác đang trong trạng thái non-terminal (`reserved`, `in_progress`, `cancel_requested`), đảm bảo tính tuần tự của phiên hội thoại browser.

---

## 2. Kết Quả Kiểm Thử Thực Nghiệm (`npm test --workspace=@antigravity-gemini-web/gemini-browser`)

Trước bản vá Codex, package `@antigravity-gemini-web/gemini-browser` đạt **7/7 tests PASS** trong các ca dưới đây:

1. `browser-driver.test.ts` (PASS, ~7.2s):
   - Vòng đời 3 lượt chat (Text, Markdown, Code fence block), hủy qua Stop button và dọn dẹp sạch trên DOM fixture độc lập.
2. `browser.test.ts` [F1 Regression] (PASS, ~250ms):
   - Kiểm chứng driver đóng kiểm soát (non-existent binary, closed port), báo chính xác `opened: false`, không bao giờ báo fake success.
3. `regressions-v2-v6.test.ts` (PASS, ~7.5s):
   - **Test 1 (V2):** Cleanup attached driver chỉ disconnect CDP, không gửi `Browser.close`.
   - **Test 2 (V3):** Bề mặt không hợp lệ (`https://example.invalid/support`) bị từ chối `ready`, account `unknown`, không tự điền model.
   - **Test 3 (V4):** Timeout dở dang có partial text trả về `status: "failed"` với mã `TIMEOUT`.
   - **Test 4 (V5):** Stop button thất bại báo `cancelled: false`; turn đã terminal từ chối hủy; terminal outcome bất biến.
   - **Test 5 (V6):** Gửi lặp cùng prompt là idempotent; gửi cùng ID khác prompt bị `CONFIG_CONFLICT`; gửi đè bị từ chối `BUSY`.

---

## 3. Trạng Thái Hồ Sơ Gemini Web Thực Tế & Thao Tác Cần Thiết

- **Hồ sơ riêng biệt:** `C:\Users\vhc\.gemini\gemini_web_probe_profile`.
- **Kết quả Probe Thực Nghiệm Mới Nhất (`tools/probes/g2/probe_live_gemini.mjs` - chạy lúc 19:12:26 14/10/2026):**
  ```json
  {
    "browserState": "needs_user_action",
    "accountState": "needs_user_action",
    "actionReason": "User authentication required",
    "url": "https://gemini.google.com/app",
    "title": "Google Gemini",
    "isAllowedSurface": true,
    "hasComposer": false,
    "cleanup_successful": true
  }
  ```
- **Phân tích thực nghiệm:**
  - Driver CDP tự khởi động Chrome headless, kết nối vào đúng surface `https://gemini.google.com/app`.
  - Nhận diện đúng surface (`isAllowedSurface: true`, `title: "Google Gemini"`).
  - Xác nhận chính xác chưa có phiên đăng nhập Google trên profile này (`hasComposer: false`, `accountState: "needs_user_action"`).
  - Vòng đời kết thúc và giải phóng sạch tiến trình Chrome trong ~2.3s, không để lại tiến trình mồ côi.

- **Thao tác người dùng (User Action Required):**
  1. Mở Google Chrome với profile độc lập này:
     ```powershell
     & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\Users\vhc\.gemini\gemini_web_probe_profile" https://gemini.google.com/app
     ```
  2. Đăng nhập tài khoản Google và hoàn tất xác thực 2 bước (MFA).
  3. Khi giao diện chat Gemini Web xuất hiện (có ô nhập prompt và avatar tài khoản), có thể để nguyên cửa sổ hoặc đóng lại để lưu cookie phiên vào profile này.

---

## 4. Tổng Kết Trạng Thái Gate G2-C

- **Nền tảng Browser Adapter & CDP Driver:** **20/20 fixture/regression tests PASS sau bản vá Codex**; không phải coverage hay live acceptance 100%.
- **Tích hợp live với tài khoản Google thật:** **NEEDS_USER_ACTION** (chờ đăng nhập thủ công trên profile riêng biệt).

