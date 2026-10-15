# ADR 0003 — Session recovery và context policy

Trạng thái: chính sách đã triển khai/kiểm chứng bằng controlled tests; native integration chưa được chứng minh.
Ngày: 14/10/2026. Cập nhật theo [G3_CODE_REVIEW.md](../evidence/G3_CODE_REVIEW.md).

## Quyết định

1. Shared TurnStateSchema và canTransitionTurnState là nguồn state machine. Terminal completed/cancelled/cancel_confirmed/failed/interrupted/outcome_unknown bất biến. Cancel requested chưa phải cancel confirmed.
2. Dedupe đầy đủ request/turn/payload; giữ terminal tombstones. Queue mặc định 5, ledger 1000; đầy thì reject, không quên ID để chạy lại.
3. Authority thuộc host: inventory copy, mặc định deny, binding runtime/workspace/session/turn/request/nonce/epoch; tools chỉ ở tool phase. Runtime instance dùng UUID, không dùng epoch làm instance identity.
4. Context giữ cấu trúc/thứ tự array, hash toàn bộ nội dung. Windows path aliases có normalization; opaque/POSIX IDs không gộp hoa thường. Check session và budget cùng prompt trước dispatch.
5. Budget là heuristic có isEstimate=true trên toàn bộ serialized envelope, local cap mặc định 32.000 estimated tokens/1MB; không coi là quota hay tokenizer Google. Unknown requested model cần rebind; compaction chưa verified trả UNSUPPORTED_OPERATION.
6. Journal single-writer, metadata đã validate + SHA-256 digest, không ghi payload prompt/cookie/token. IDs do host cấp phải là metadata an toàn, không dùng nội dung người dùng làm ID/error.
7. Commit synchronous: write file tạm riêng, fsync, atomic rename. Rename lỗi phải fail; không copy/direct overwrite fallback, không nuốt lỗi rồi Send.
8. Journal key workspace/session/turn; terminal/cache/report bất biến đối với caller. Version không hỗ trợ, outcome sai phase và digest sai bị reject.
9. Recovery không tự replay. Có khả năng side effect (submitting/accepted/generating/streaming/tool/cancel pending hoặc receipt) thành outcome_unknown; pre-dispatch thành interrupted. Reused instance ID vẫn reconcile.
10. Read failure hoặc corrupt evidence chặn mutation. Giữ file hỏng qua restart để không quên blocker; xử lý/recovery không được mặc định xóa evidence.
11. Disconnect fence authority trước mọi thao tác khác, dừng queue. Tiếp tục cần binding đã reconcile; chưa có auto-resume API.
12. Resync replay chỉ sau snapshot watermark, contiguous và không duplicate; budget/buffer hữu hạn; lỗi đến caller, waiter không bị bỏ khi epoch đổi.

## Giới hạn và hệ quả

Native inference route chưa verified. SessionCoordinator đã compose context/journal nhưng chưa ghép vào task native thật; host provenance, IDE restart, browser conversation/account/model rebinding vẫn chưa nghiệm thu live.

Không hứa exactly-once xuyên crash, nhiều writer vào một journal hay chống mọi mất điện/filesystem failure. Metadata journal vẫn cần được bảo vệ trong app data riêng. Atomicity giúp không thay file đích bằng nội dung ghi dở, không phải quyền cấp phép replay.

G4 phải dùng services trên đường gọi runtime thật và owned fixtures; renderer chỉ có launcher control API, không nhận nonce, raw context hoặc quyền executor.

