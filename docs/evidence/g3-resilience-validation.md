# G3-A — Độ bền và phục hồi: kiểm chứng sau review

Ngày: 14/10/2026. Mốc hiện tại: [g3-codex-remediation-validation.md](g3-codex-remediation-validation.md). Báo cáo 59 tests trước review chưa phát hiện các lỗi tại [G3_CODE_REVIEW.md](G3_CODE_REVIEW.md).

## Kết quả

**84/84 TypeScript tests PASS**: contracts 8, browser 20, bridge 4, native 1, runtime 51. Build/typecheck/lint pass; lint hiện là tsc. Python safety 5/5, shim 9/9 và 3 probe verifications pass.

Runtime có 9 tests G3 ban đầu, thêm 20 regressions cho context/journal/coordinator/live diagnostics và 5 tests resync. Các tests G2 browser vẫn pass; không sửa source driver trong đợt này.

## Hành vi đã kiểm chứng

- Dedupe queue/active/terminal theo request/turn/full payload; payload conflict bị từ chối; cancel queued giữ tombstone; ledger đầy không tự evict.
- Workspace/session binding; Windows path aliases; opaque/POSIX IDs phân biệt hoa thường.
- Context preflight được gọi ngay trong coordinator enqueue, gồm prompt; reject oversized/foreign session/unknown requested model.
- Journal schema SHA-256, composite key và terminal bất biến; cache/report clones không làm đổi authority.
- Commit journal trước reservation/dispatch. Inject rename failure giữ file/cache cũ, không fallback direct overwrite, không để file tạm.
- Recovery classify submitting/accepted/streaming/tool/cancel pending thành outcome_unknown; queued thành interrupted, kể cả runtime ID bị tái dùng.
- Read failure/corrupt lines chặn mutation. Corrupt evidence giữ trên đĩa qua nhiều restart, không biến thành journal rỗng.
- Authority đủ runtime/workspace/session/turn/request/nonce/epoch; host inventory copy và deny-by-default. Disconnect retire epoch và dừng queue.
- Resync coalesce, watermark filtering/duplicate filtering, giữ waiter qua restart, báo lỗi ở caller. Tối đa 1000 buffered events, 3 fetch attempts và 1.5s/fetch; callback wait 0.5s.

Source: [g3-resilience.test.ts](../../tools/archive/packages/runtime/src/g3-resilience.test.ts), [g3-regressions.test.ts](../../tools/archive/packages/runtime/src/g3-regressions.test.ts), [g3-resync.test.ts](../../tools/archive/packages/runtime/src/g3-resync.test.ts).

## Phạm vi

Đây là controlled component/runtime tests và browser DOM fixtures. Chưa có native inference route gọi services này trên một task thật; không chứng minh native executor/tool loop, IDE restart recovery hay account/conversation rebinding live.

Journal single-writer; fsync file + atomic rename không phải bảo đảm mọi tình huống mất điện hoặc nhiều writer. Không hứa exactly-once xuyên crash.

Tests tự thoát và cleanup owned fixtures pass. Kiểm tra sau suite không thấy fixture Chrome, shim/fake child; không khẳng định kiểm toán mọi tiến trình Chrome/Node/Python trên máy.

