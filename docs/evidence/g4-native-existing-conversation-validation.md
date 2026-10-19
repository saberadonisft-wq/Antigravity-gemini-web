# Tiếp tục cuộc trò chuyện Web hiện tại

Ngày 16/10/2026. Native runtime revision **11**, browser fingerprint **9**. Triển khai theo yêu cầu không phải tạo chat Gemini Web mới khi tiếp tục sau lỗi/restart.

## Cơ chế

- `npm run native:resume -- --url "https://gemini.google.com/app/ID"` đăng ký tiếp tục task gần nhất của proxy. Sau restart phải dùng `--next-turn` tường minh để gắn request IDE mới kế tiếp. Endpoint `/__native/resume` yêu cầu owner token, từ chối khi active; không gửi prompt và không tạo/navigate tab.
- Chọn đúng một tab qua URL exact trong browser riêng, xác minh origin, signed-in, composer trống và không generating. Không chọn tab gần nhất hoặc theo tiêu đề. Tab đang có lease khác bị từ chối.
- Request tiếp theo rebind bằng full context/nonce hiện tại trong chính chat đã chọn. Những lượt sau dùng revision/append/patch. Native request cần session/conversation ID thật; caller/task/model policy vẫn cách ly.
- Receipt cũ không replay dù resume được đăng ký. Đăng ký hết hạn sau 5 phút sẽ chặn request mới cho đến khi re-arm/clear, không âm thầm tạo chat mới. URL chỉ giữ trong RAM; health chỉ báo boolean resumeArmed, không in URL/token/prompt.
- Giữ lịch sử và draft người dùng. Tab được chỉ định chỉ bị tháo liên kết, không đóng bởi lease cleanup; khi Stop chưa xác nhận thì fail closed. Thoát cả browser sở hữu vẫn có thể đóng cửa sổ. URL không còn mở phải được người dùng mở lại từ lịch sử trước khi tiếp tục.

## Kiểm chứng local/fixture

Build/typecheck/lint PASS. `npm test`: **226/226 PASS**, 0 fail/skip/cancelled (contracts 8, browser 30, MCP 32, model-bridge 4, native 39, runtime 80, launcher 33). Log local `.tmp/g4-followup-{build,test,typecheck,lint}.log`. Bài real-CDP được sửa để đợi page ready trước khi seed fixture; bản chạy cuối toàn suite đã pass.

- HTTP: owner authentication, URL validation, task scope, một lần tiêu thụ đăng ký, full rebind → append cùng lease, expiry, clear, missing task ID, cached retry và lỗi attach không fallback.
- MCP: gọi openExistingConversation đúng URL, không gọi openFreshConversation; continuation revision, từ chối delta+resumeUrl và không gửi khi target thiếu.
- Real CDP trên DOM fixture: có sẵn một lượt chat → adopt cùng target → gửi follow-up → responseCount từ 1 thành 2; tổng tab vẫn là 1. Draft nguyên vẹn khi bị từ chối, duplicate URL bị từ chối, lease đã đóng không xóa tab chỉ định.
- Không dùng Gemini account hoặc gửi prompt thật trong kiểm thử. Không coi fixture là nghiệm thu model Web nhớ context đúng.

Hướng dẫn tại [NATIVE_SETUP](../NATIVE_SETUP.md#tiếp-tục-cuộc-trò-chuyện-web-đang-có). Bản proxy quan sát trước reload vẫn là revision 9; chưa thay tiến trình cũ để tránh cleanup của nó đóng chat đang có. Người dùng cần lưu URL, reload native/MCP rồi mở lại cùng URL và đăng ký tiếp tục. Không commit/push, chưa G5.
