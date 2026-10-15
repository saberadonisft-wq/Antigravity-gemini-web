# Review G3 và các bản vá Codex

Ngày: 14/10/2026. Review source tại workspace, đối chiếu các đường gọi, không dùng báo cáo Gemini làm bằng chứng thay cho code. Người dùng đã yêu cầu sửa lỗi và chuẩn bị prompt G4.

## Findings đã sửa

| ID | Mức độ | Lỗi tái hiện hoặc xác định từ source | Bản vá |
|---|---|---|---|
| G3-R1 | High | Context fingerprint chỉ lấy 50 ký tự đầu/cuối, số message/tool; đổi message giữa hoặc tool output vẫn cho cùng hash. | Hash toàn bộ envelope đã validate; canonical object keys, giữ thứ tự array. |
| G3-R2 | High | Lowercase mọi workspace ID gộp opaque IDs hoặc POSIX paths khác nhau; enqueue không kiểm tra session. | Opaque IDs/POSIX phân biệt hoa thường; chỉ normalize absolute Windows paths. Kiểm tra cả workspace và session. |
| G3-R3 | High | Journal nhận `payloadHash` là chuỗi bất kỳ từ 8 ký tự, version không hỗ trợ, terminal outcome thiếu/sai phase và errorCode chứa nội dung tùy ý. | Digest SHA-256 hex 64 ký tự; version 1; ISO timestamps; error enum; terminal outcome khớp phase. |
| G3-R4 | High | Journal key chỉ có turn ID, có thể đè dữ liệu session khác hoặc đổi terminal thành nonterminal; recovery report trả tham chiếu mutable. | Composite workspace/session/turn key, terminal bất biến, snapshot clone, tra turn trùng cần binding. |
| G3-R5 | High | Rename lỗi sẽ copy/direct write lên file đích; coordinator nuốt lỗi journal bằng `.catch(() => {})`. | Write/fsync file tạm rồi rename; không fallback ghi đè. Commit lỗi trả lỗi, không cập nhật cache hay cấp quyền dispatch. |
| G3-R6 | High | Read lỗi được coi như journal rỗng; rewrite bỏ dòng hỏng làm restart tiếp theo quên blocker; instance ID trùng không reconcile; thiếu các phase có side effect. | Read lỗi chặn mutation; giữ nguyên file hỏng và replay blocker; reconcile cả ID bị tái dùng; streaming/tool/cancel pending có thể là outcome unknown. |
| G3-R7 | High | Enqueue trùng vẫn thêm việc, cancel không giữ tombstone; active item bị caller sửa; transition không kiểm tra đường đi; không có ledger cap. | Dedupe request/turn/full payload, conflict, tombstone terminal, clone item; transition table; queue và ledger hữu hạn, không tự evict. |
| G3-R8 | High | Tool authority chỉ xét epoch, mặc định tự cấp tools; inventory giữ Set bên ngoài; synthetic `coord-epoch-1` tái dùng sau restart. | Inventory mặc định rỗng và được copy; UUID runtime; binding runtime/workspace/session/turn/request/nonce/epoch, chỉ cho phép ở tool phase. |
| G3-R9 | High | Resync phát lại cả event <= snapshot watermark và duplicates; mỗi gap tạo promise mới bỏ rơi waiter cũ; background snapshot failure không được quan sát. | Coalesce buffer, replay contiguous sau watermark, giữ waiter qua epoch restart; buffer cap 1000, tối đa 3 snapshot attempts, mỗi fetch 1.5s, lỗi đến caller. |
| G3-R10 | High | Live snapshot kế thừa demo models/capabilities; native adapter ghi cứng phiên bản IDE sai; browser open bị coi là ready và host check tự passed. | Live snapshot bỏ metadata mô phỏng; host detection chưa chạy là unknown/not_run; browser/account riêng biệt; model select live bị từ chối khi chưa có provider. |
| G3-R11 | Medium | TCPServer mặc định in traceback/exception không sanitize khi socket shutdown hoặc handler lỗi; unexpected handler error vẫn có thể cho probe pass. | Shutdown socket do server sở hữu được nhận diện; lỗi khác chỉ in metadata redacted và làm validation fail sau cleanup. |

Tái hiện trước bản vá bằng compiled code: `FINGERPRINT_COLLISION true`, `FOREIGN_SESSION_ACCEPTED_AND_DUPLICATED 2`, `JOURNAL_ACCEPTS_RAW_SECRET_IN_HASH true`.

## Kiểm thử

- Thêm 20 tests trong [g3-regressions.test.ts](../../packages/runtime/src/g3-regressions.test.ts), 5 tests trong [g3-resync.test.ts](../../packages/runtime/src/g3-resync.test.ts).
- 9 tests G3 ban đầu được giữ, cập nhật dữ liệu hash và lời gọi authority theo API chặt hơn.
- Sửa assertion A2 cũ: event đã nằm trong snapshot phải bị bỏ, không phát lại. Có tests riêng kiểm tra replay các event mới hơn, duplicate, restart, lỗi và timeout.
- 13 browser concurrency regressions của Codex cùng các browser tests khác vẫn pass; không sửa source browser trong đợt này.
- Bằng chứng chạy: [g3-codex-remediation-validation.md](g3-codex-remediation-validation.md).

## Giới hạn còn lại

G3 core được kiểm chứng ở cấp component và controlled runtime tests. `SessionCoordinator` đã gọi context preflight và journal, nhưng chưa có đường inference native cung cấp context/task/browser conversation identity thật và điều phối toàn bộ tool loop.

`FakeRuntimeEngine` vẫn là runtime thử nghiệm có nhánh live cho control commands; chưa ghép các G3 session services vào native chat. Browser target/account/conversation rebinding, IDE restart và tool recovery xuyên native host vẫn chưa nghiệm thu. Không báo toàn bộ G3 live hoàn thành.

G4 có thể làm launcher/main/preload và kiểm chứng IPC với backend thật cho những command đã triển khai. Native install, model selection, tool loop/cancel native và native E2E phải bị khóa theo capability cho tới khi có bằng chứng route.
