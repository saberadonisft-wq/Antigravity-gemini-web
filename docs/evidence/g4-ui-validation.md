# G4 — UI validation

Cập nhật 15/10/2026. [Validation hiện tại](g4-acceptance-validation.md), [review trước](G4_CONTINUE_CODE_REVIEW.md). **G4-A UI/desktop/fixture VERIFIED**, G4-B BLOCKED / NOT_TESTED.

Lỗi cache khi mở launcher được sửa riêng tại [startup cache validation](g4-electron-cache-validation.md); đóng instance cũ và chạy lại `npm run launcher` để áp dụng.

33 launcher tests PASS. Electron smoke thực tế kiểm tra:
- Live thiếu preload fail closed; demo chỉ explicit.
- Settings save/theme reload, dirty draft tồn tại sau external revision và conflict.
- English được lưu, document.lang=en qua reload; 5 English headings và English CONFIG_CONFLICT error.
- Native E2E disabled theo capability; backend vẫn gate.
- 5 views × logical 1280×800/1024×720/800×600 không horizontal viewport overflow; Tab focus.
- 18 CSS text/background pairs ≥4.5:1. Light secondary đổi #656d76 → #5f6770 vì tertiary background chỉ 4.499918:1 trước sửa; sau sửa 4.92:1.

[JSON](g4-desktop-smoke/desktop-smoke.json), [English/light](g4-desktop-smoke/launcher-english-light.png), [1280×800](g4-desktop-smoke/launcher-1280x800.png), [1024×720](g4-desktop-smoke/launcher-1024x720.png), [800×600](g4-desktop-smoke/launcher-800x600.png). Ảnh Overview; Windows scaling ảnh khác logical size. Hidden compositor được cập nhật trước capture.

Acceptance tiếp theo có [10 rendered scenario flows](g4-desktop-smoke/desktop-ui.json), 576 computed contrast measurements trên 32 combinations (minimum 4.5166:1), long workspace tại ba actual viewport sizes, system dark, reduced-motion duration 0.01ms trên 12 controls, Tab/focus-visible/Enter navigation và Settings labels. Demo subtitle opacity và dark Cancel hover contrast đã sửa; picker đủ nhãn VI/EN. [Tools light](g4-desktop-smoke/launcher-fixture-tools-light.png), [tools dark](g4-desktop-smoke/launcher-fixture-tools-dark.png).

Copy/error templates vi/en; observed diagnostics/provider strings giữ nội dung nguồn. [Native Windows Save/Cancel](g4-desktop-smoke/desktop-dialog.json) và [actual second-instance/pending lifecycle](g4-desktop-smoke/desktop-lifecycle.json) đã thử. Owned Chrome crash/reconnect fixture có runtime test riêng. Không chứng nhận full WCAG, screen-reader audit, Windows foreground cho Chrome hoặc native/Google live. G4-B BLOCKED / NOT_TESTED.

Ngày 15/10: sửa `windowsHide` trong script start sau khi phát hiện smoke không bao phủ visibility của lần mở đầu tiên. Đã chạy chính `npm run launcher` với owner mới và quan sát cửa sổ thật tự hiện, Runtime ready. [Bằng chứng và giới hạn kiểm chứng](g4-launcher-first-window-validation.md).


