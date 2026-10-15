# G4 continuation — Review Codex

Ngày 15/10/2026. Review snapshot báo cáo “G4-A hoàn tất, 133 tests”. Các acceptance còn thiếu khi review nay đã có [bằng chứng riêng](g4-acceptance-validation.md): **148 tests PASS, G4-A launcher/control/fixture VERIFIED**. Phần trạng thái bên dưới là lịch sử tại thời điểm review; G4-B vẫn BLOCKED / NOT_TESTED.

## Findings và remediation

| ID | Mức | Phát hiện | Bản vá / giới hạn |
|---|---|---|---|
| G4-C1 | High | Facade vẫn await engine/browser/export trước ack; chỉ đổi ID không tạo early ack. | Reserve queued operation + ack bền vững trước dispatch; browser/check/export/cancel trả sớm, settings sync giữ rejection semantics. |
| G4-C2 | Critical | Terminal receipt save lỗi bị catch rỗng; vẫn báo success và tiếp tục mutation. | Commit operation trước event; lỗi persistence thành outcome_unknown và chặn mutation mới. Read operation vẫn được. |
| G4-C3 | High | confirm/fail cancellation kết thúc mọi running cancel, không ràng buộc turn; callback muộn có thể mở lại terminal; UI pending chỉ theo turnId. | Binding session/turn/operation, guard terminal/stopped, failure khôi phục state trước cancel. UI đợi terminal có budget và dùng composite identity. |
| G4-C4 | High | Restore ghi đè key do người dùng sửa sau apply. | So sánh giá trị owned keys trước restore; conflict giữ nguyên bytes; unrelated edits được bảo toàn. |
| G4-C5 | High | Config service nhận path bất kỳ, journal nuốt lỗi, install có thể tái tạo file bị xóa; TTL/schema chưa validate. | Fixture root trong OS temp, path/link checks, bounded previews, JSON/TTL/revision checks, journal fsync trước effect; terminal evidence lỗi → unknown/block. Restore cần confirmation. |
| G4-C6 | Medium | Cleanup retry 10s rồi warning biến failure thành pass. | Retry tối đa 5s, validate owned profile trước delete và throw khi vẫn locked. Không khẳng định mọi transient đã hết. |
| G4-C7 | High | Settings effect reset draft mỗi revision; test chỉ gọi mock client, không mount form. | Giữ dirty draft và base revision, explicit discard/reconcile; smoke React thật cho external revision + conflict cả vi/en. |
| G4-C8 | Medium | Contrast test dùng literal màu, số báo cáo không khớp; secondary trên tertiary chỉ 4.499918:1. | Sửa màu thành #5f6770; unit đọc CSS và desktop đo 18 foreground/background pairs. Không chứng nhận WCAG toàn ứng dụng. |
| G4-C9 | Medium | English labels có nhưng lỗi vẫn render raw message tiếng Việt; template có thể render raw exception. | Localized typed error templates, giữ code, không raw exception; English error flow được smoke. Diagnostic/provider text không được giả dịch thành dữ liệu khác. |
| G4-C10 | Medium | E2E button chỉ disabled khi đang chạy, dù route unverified. | Disabled theo native capability; main/backend rejection vẫn giữ. SDK smoke kiểm tra button. |
| G4-C11 | Medium | Second-instance test copy if/show/focus, không chạy production handler. | Test gọi helper dùng bởi main. Chưa có SDK two-process acceptance; không gọi unit test là desktop second-instance proof. |
| G4-C12 | High | State publication lỗi có thể ngắt stop trước cleanup; browser focus chưa gọi CDP và target có thể race port guard. | Cleanup tiếp tục khi publication lỗi; Page.bringToFront cho owned target, racing external target chỉ detach. Unit proof, chưa chứng minh OS foreground/reconnect thật. |

## Bằng chứng

[Validation mới](g4-codex-followup-validation.md), [runtime followup tests](../../packages/runtime/src/g4-followup.test.ts), [cleanup tests](../../packages/gemini-browser/src/fixture-cleanup.test.ts), [renderer tests](../../apps/launcher/src/renderer/g4-behavior.test.ts), [desktop smoke](../../apps/launcher/src/main/desktop-smoke.ts).

13 behavioral tests mới: runtime 9, browser cleanup 2, renderer 2. Không skip, không đổi deadline để che failure.

## Trạng thái

Desktop control và các flow được liệt kê đã VERIFIED. G4-A acceptance đầy đủ vẫn **PARTIAL**: còn actual second-instance/window lifecycle pending, owned-browser focus/crash/reconnect fixture và đủ 10 UI scenario flows/native Save dialog/keyboard/contrast coverage. Native inference/Google live/host tools **BLOCKED / NOT_TESTED**.

Không G5, installer, commit/push hoặc sửa IDE chính.
