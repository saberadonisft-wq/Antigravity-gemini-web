# G3 — Kiểm chứng bản vá Codex

Ngày: 14/10/2026. Windows; Node v24.18.0, npm 11.16.0, Python 3.13.6. Không commit/push, không sửa cài đặt IDE hay profile Google của người dùng.

## Kết quả đã chạy

| Lệnh / bộ kiểm thử | Kết quả |
|---|---|
| `npm run build` | PASS, cả 5 packages |
| `npm test` | **84/84 PASS**: contracts 8, browser 20, bridge 4, native 1, runtime 51; lần cuối ~5.94s |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS; script hiện là `tsc --noEmit`, chưa có lint rules riêng |
| `python -B -m unittest tools/probes/g2/test_probe_safety.py` | **5/5 PASS** |
| `python -B -m unittest tools/probes/g2/shim/test_shim.py` | **9/9 PASS**, source shim không sửa |
| `python -B tools/probes/g2/verify_probe_timeout.py` | **3/3 kiểm chứng PASS**; silent child ~3.06s trong budget 3s + cleanup 2s |

Các command chạy với watchdog riêng: build 60s; npm tests 75s; static checks 45s/command; Python checks 20–45s. Khi timeout chỉ được dọn cây PID runner do kiểm thử tạo. Không có timeout trong lần kiểm chứng cuối.

Browser tests dùng Chrome với profile tạm riêng, DOM fixture và controlled drivers; cleanup assertion pass. Unit tests journal kiểm tra thư mục tạm nằm trong OS temp trước khi xóa. Không quan sát thấy fixture Chrome, shim hay fake child còn sống sau kiểm thử; không suy rộng thành kiểm toán mọi Node/Python/Chrome trên máy.

## Bản vá và thay đổi API

Chi tiết findings: [G3_CODE_REVIEW.md](G3_CODE_REVIEW.md).

- Hash ngữ cảnh/payload bao gồm toàn bộ dữ liệu; key order không đổi hash, array order và từng giá trị có ý nghĩa.
- Budget tính trên toàn bộ JSON envelope: `ceil(max(characterCount, utf8ByteCount) / 4)`, luôn `isEstimate: true`; cap mặc định 32.000 estimated tokens và 1.000.000 bytes. Đây là heuristic cục bộ, không phải tokenizer/quota Google.
- Enqueue kiểm tra workspace/session, context cùng prompt và model binding trước khi journal/dispatch. Model yêu cầu nhưng driver model unknown trả `REBIND_REQUIRED`.
- `SessionCoordinator.fingerprintPayload({ prompt, context? })` là nguồn digest cho queued item; không dùng hash giả hay hash bỏ qua nội dung.
- `transitionActiveTurn(turnId, state, epoch, errorCode?)` cần epoch. `verifyHostToolAuthority(toolName, authority)` cần binding đầy đủ lấy từ host-owned `getActiveAuthority()`; không đưa nonce này cho launcher renderer.
- `RecoveryJournal.record()` và `loadAndReconcile()` commit đồng bộ. Caller cũ có thể `await` kết quả, nhưng không dùng fire-and-forget hoặc nuốt lỗi. Journal là single writer trong một runtime process; không chứng minh an toàn cho nhiều writer/process đồng thời.
- Journal key gồm workspace/session/turn; `get(turnId, binding)` dành cho ID có thể trùng. Report clone dữ liệu, không trả mutable cache.
- File lỗi giữ nguyên và `replayBlocked=true`; không xóa evidence hoặc tự replay. Ghi lỗi không cấp quyền Send. Atomic rename + fsync file không phải lời hứa chịu mọi sự cố mất điện/filesystem.
- Queue cap mặc định 5, ledger cap 1000. Khi đầy từ chối việc mới, không quên ID rồi cho chạy lại. Disconnect fence epoch, dừng queue và đòi binding đã reconcile; chưa có API tự resume.
- Live control snapshot không có model/version/capability synthetic. Native adapter chưa đo host nên không điền hostVersion. Hoàn thành một diagnostic operation không đồng nghĩa tất cả gate đã passed.
- In-process client drop event đã có trong snapshot, dedupe replay, giữ waiter khi restart, giới hạn buffer/attempts/deadline; failure không tạo unhandled rejection.
- Probe server redacts unexpected handler errors và làm validation fail; expected owned shutdown không in traceback.

Contract UI vẫn `schemaVersion=0.1` của workspace chưa phát hành, được bổ sung turn phases/terminal helper. Renderer G4 phải import shared schema hiện tại; không dùng bản enum chép cũ.

## Trạng thái native/live

| Gate | Trạng thái và nguồn bằng chứng |
|---|---|
| Native launch hook | PASS theo evidence isolated IDE trước đó; không chạy lại IDE trong đợt review này |
| Native inference / native tool loop | **UNRESOLVED / NOT_TESTED**; standalone no-port và `rpc_attempted=false` không chứng minh nguyên nhân handshake hay bắt buộc TLS interception |
| Gemini browser fixture | PASS 20 tests; không phải chat Gemini live |
| Google profile login / chat live | Báo cáo trước là NEEDS_USER_ACTION; **không refresh profile và không gửi prompt live trong đợt này** |
| G3 recovery/context trên native E2E | **NOT_TESTED**; các lớp core chưa nối tới inference route thật |
| Launcher / IPC | `apps/launcher` chưa tồn tại tại thời điểm review; giao tiếp desktop chưa được triển khai |

Đã hash lại binary trên đĩa: `D:\Antigravity IDE\resources\app\extensions\antigravity\bin\language_server_windows_x64.exe`, 124.639.232 bytes, SHA-256 **78C4242BF9E5D84A3A0CA44675D44BE09A028056E54C3F0D85280A4D8700DEE4**.

Hash khác trong báo cáo G3 cũ không khớp file đo lại. JSON live cũ có `url/title/actionReason` cũng không phải output format của status-only probe hiện tại; không coi là bằng chứng mới của probe sau bản vá.

Có thể tiếp tục **G4-A launcher và IPC với capability gating**. G4-B native/live E2E vẫn phụ thuộc các gate thật. Prompt: [GEMINI_G4_PROMPT.md](../GEMINI_G4_PROMPT.md).
