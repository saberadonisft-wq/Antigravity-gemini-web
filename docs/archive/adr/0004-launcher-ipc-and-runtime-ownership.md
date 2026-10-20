# ADR 0004 — Electron IPC và runtime ownership

Ngày cập nhật: 15/10/2026. Quyết định triển khai desktop control; **G4-A launcher/control/UI/fixture VERIFIED** theo [acceptance mới](../../evidence/g4-acceptance-validation.md), native/live G4-B chưa nghiệm thu.

## Bối cảnh

Báo cáo G4 ban đầu chỉ có abstraction/main source tests, thiếu Electron bootstrap và dependency. Renderer có thể tự fallback demo, bridge kiểm tra origin prefix, settings/export chưa bền và facade chỉ export G3 classes. [Review](../../evidence/G4_CODE_REVIEW.md) ghi findings và [validation](../../evidence/g4-codex-remediation-validation.md) ghi kết quả bản vá.

## Quyết định

1. Electron main ESM sở hữu window, single-instance lock, runtime và Save dialog. Sandbox preload bundle CJS; renderer Node integration tắt, context isolation/sandbox/web security bật. Production app://local protocol chỉ serve files trong dist-renderer.
2. Public LauncherClient v0.1 giữ 6 methods. Main derive frame/sender/origin từ event thật, đăng ký sender và allowlist exact origins; không tin context do renderer khai báo.
3. Validate schema input/output, redact diagnostic data và typed reply envelope giữ error codes. Subscribe/unsubscribe và preload-ready private, không expose generic ipcRenderer/fs/shell.
4. Settings/receipts/journal là runtime single-owner stores. Atomic temp/fsync/rename, external edit/corruption fail closed. Request fingerprint/reservation ghi trước effect; crash pending thành unknown, không tự replay.
5. Main cấp chooser activity export; facade ghi đúng destination, cancellation/epoch retired không ghi. Renderer không đưa arbitrary file path.
6. ContextManager/RecoveryJournal/SessionCoordinator compose trong host-only fixture; native host tool execution chưa có. Stop tăng epoch, thông báo disconnect rồi cleanup-owned-browser kể cả khi coordinator lỗi.
7. Default browser adapter nhận ownership sau app spawn; status không tự attach CDP ngoài, occupied port fail closed. Reload dispose sender subscriptions; runtime sống theo main owner. Cleanup lỗi thoát nonzero.
8. Explicit demo có nhãn và temp data riêng; thiếu preload live là lỗi. Live app data/profile khác profile probe G2; không migrate cookie.

## Hệ quả và giới hạn

Desktop SDK smoke có đường gọi thật, atomic settings/reload và metadata export tests. Đây là launcher control core, chưa phải chat native inference. Redaction theo policy/known fields, không cam kết nhận diện mọi secret tùy ý.

Browser/check/export/cancel reserve queued operation bền vững rồi ACK trước external wait. Terminal persistence có trước event; fail → unknown/block. Settings sync giữ known rejection. Export Cancel là terminal failed/CANCELLED. Config service chỉ fixtureRoot trong OS temp, journal trước effect và restore check owned-key conflicts. UI/errors vi/en, draft giữ baseRevision; CSS contrast được đo. SDK two-process, pending reload/navigation/close, owned Chrome reconnect, native Windows dialog và 10 UI scenarios đã kiểm chứng trong [acceptance hiện tại](../../evidence/g4-acceptance-validation.md).

Acceptance controls ở main và isolated renderer bundle chỉ hoạt động khi smoke dùng owned temp userData; production protocol chỉ serve dist-renderer và fixture window không có preload/sender IPC quyền. Không thêm public LauncherClient methods hoặc mở native capabilities. Chrome page activation không chứng minh Windows foreground hay live inference.

Xem [prompt tiếp tục G4](../prompts/GEMINI_G4_CONTINUE_PROMPT.md).

