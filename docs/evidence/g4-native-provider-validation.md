# G4 — Native Gemini Web provider validation

Ngày 15/10/2026. Phạm vi local, Antigravity IDE 2.5.5 / VS Code 1.107.0, commit ecfbad74d93962fc8ca485d93ab9b4f3d4cb6cf8. Người dùng đã tự xác nhận workspace và đăng nhập trong profile riêng **Gemini Web Native Test**. Không chỉnh binary, source vendor hoặc endpoint của IDE chính. Chưa G5, commit/push hoặc public deployment.

## Kết quả thực tế

| Ca nghiệm thu | Kết quả | Bằng chứng quan sát |
|---|---|---|
| Native model catalog/picker | PASS | Menu model của IDE thật hiển thị và chọn Gemini Web (Local), identity ổn định MODEL_PLACEHOLDER_M650 |
| Chat native → Gemini Web → native answer | PASS | Gõ trong native conversation, nhận đúng AG_NATIVE_WEB_OK_20261015; proxy ghi một browser generation hoàn tất |
| Native tool đọc file → functionResponse → Gemini trả lời | PASS | Prompt chỉ cấp đường dẫn file fixture, không cấp nội dung; UI ghi view_file/Analyzed read-me.txt#L1 và trả đúng marker ngẫu nhiên trong file |
| Chat sau restart bản semantic dedup/hard deadline | PASS | Native UI lúc 17:12 trả đúng AG_NATIVE_FINAL_BUILD_OK_20261015; proxy lúc đó PID 28380 |
| Native sửa file + run_command | NOT_TESTED / người dùng chọn tự test sau | Fixture check.mjs đã chuẩn bị; chưa ghi nhận result.txt hoặc native command receipt. Không dùng kết quả fixture executor thay bằng native live |
| Native cancel/deny/crash/long-context compaction | NOT_TESTED live | Regression timeout/dedup/authority kiểm tra local; chưa nâng thành live acceptance |
| Google reverse custom MCP app | NOT_CONNECTED | Độc lập với provider này, không cần cho native functionCall/functionResponse |

Lượt đọc file dùng .tmp/native-tool-acceptance/read-me.txt, 50 bytes, với marker sinh ngẫu nhiên trước khi gửi. Native prompt không chứa marker. Quan sát UI lúc 16:56 giờ Việt Nam ghi công cụ phân tích file, sau đó đáp án đúng nguyên văn. Một lần đọc cần hai browser generations: tool_call và final sau functionResponse. Cộng với chat đầu, proxy trước restart ghi browserRequests=3, completed=3, failed=0, active=0. nativeRequests=4 bao gồm một request tác vụ phụ bị từ chối vì không chọn model Web; không phải bốn lần Send sang Gemini.

## Thay đổi triển khai

- Native endpoint jetski.cloudCodeUrl trỏ loopback 9236 chỉ trong user-data-dir riêng. Preflight kiểm đúng build/commit và markers của IDE; setup idempotent, restore giữ sửa đổi cấu hình không liên quan.
- Catalog giữ model gốc, thêm Web model vào sort groups của picker. Native enum được lưu ổn định và từ chối collision sau cập nhật, không tái gán lựa chọn cũ sang model khác.
- Native protocol giữ toàn bộ system, text, history và tool declarations. Outer auth/project metadata không vào browser prompt. Attachment hoặc context quá cap bị từ chối thay vì cắt ngầm.
- JSON response có nonce riêng; tên/args functionCall phải qua schema tool trong request hiện tại. IDE là executor và giữ cơ chế approval; proxy không tự đọc/sửa file hoặc chạy shell.
- FunctionCallingConfig được kiểm tra tại proxy: NONE chặn tool, ANY bắt buộc tool, allowlist chỉ nhận tool được cấp; config không hợp lệ fail trước Send. Ajv registry tách theo request để schema $id trùng giữa hai lượt không làm lẫn authority. Semantics đối chiếu [Google API reference](https://ai.google.dev/api/caching#FunctionCallingConfig).
- MCP browser dùng một runtime owner với nhiều frontend hợp lệ. Mỗi native generation mở tab mới, đóng tab đó và trở về tab gốc; regression kiểm draft gốc không đổi.
- Request ID gắn đầy đủ model context, caller digest và session/turn scope; thay HTTP requestId/traceId không gây Send lặp. Cache có giới hạn 128 lượt và từ chối khi đầy. Restart/mất kết quả không tự replay.
- Deadline generation 145s được cưỡng chế bằng abort race, kể cả backend không trả khi signal bị abort. Kết quả/failed receipt không đổi khi retry. SSE giữ kết nối rồi trả output hoàn tất; chưa stream từng token.

## Kiểm tra bản code cuối

| Kiểm tra | Kết quả |
|---|---|
| npm run build | PASS |
| npm run typecheck | PASS |
| npm run lint | PASS; hiện là tsc --noEmit, không phải bộ lint độc lập |
| npm test | **188/188 PASS**, 0 fail/skip/cancel: contracts 8, browser 24, MCP 25, model-bridge 4, native 14, runtime 80, launcher 33 |
| Native regressions | Context/auth separation; nonce/tool/schema denial; per-request schema registry và function policy; attachment/oversize; semantic retry identity; persisted enum/collision; control routing; fixture read loop; concurrent dedup; SSE/no fallback; origin/auth/control; hard timeout; surgical config restore |
| Browser/MCP regressions mới | Fresh-tab isolation và bảo toàn draft; lease hoàn tất trước result; hủy trước Send; config fingerprint/shared-owner/connection task boundaries |

Lượt kiểm tra trung gian có một cleanup failure tại fresh-tab fixture: còn file LevelDB trong profile Chrome tạm sau budget 5s. Lúc khảo sát sau đó không còn Chrome hoặc process được Restart Manager ghi nhận giữ file; file đã mở lại được. Chưa xác định dứt điểm tác nhân giữ handle lúc fail. Cleanup fixture hiện có budget tối đa 10s và giữ nguyên fail-closed kèm error cause; persistent-lock regression vẫn buộc fail. Bổ sung test Windows với root/grandchild thật xác nhận cleanup không để descendant sống. Lượt root cuối PASS 188/188 không chứng nhận hết mọi transient lock. Log lỗi trung gian giữ tại .tmp/native-cleanup-transient-failure.log.

Hai profile tạm từ các lượt lỗi còn được giữ lại: gemini-fresh-test-MXNDLo và gemini-driver-test-profile-gLrIr1 dưới OS temp. Automatic approval review từ chối thao tác xóa với lý do blocked by policy; không thử vượt chặn. Đây không phải profile đăng nhập Gemini của người dùng.

Logs local: .tmp/g4-followup-build.log, g4-followup-test.log, g4-followup-typecheck.log, g4-followup-lint.log. Python và desktop smoke không rerun trong đợt native provider này; các kết quả cũ giữ phạm vi lịch sử. Metadata không chứa auth/prompt: [native-provider-live.json](mcp/native-provider-live.json).

Bản cuối đã thêm function policy/schema isolation và Windows fixture cleanup sau các lượt live trên; các thay đổi đó được kiểm chứng bằng regressions và root suite 188 tests. Proxy bản mới đã khởi động, browser signed-in và model Web vẫn được chọn trong profile mở lại. Không gửi thêm lượt chat sau khi người dùng chọn tự test sửa file/chạy lệnh sau.

**Follow-up khi người dùng tự chat:** lượt “alo” thực tế đã trả failed/TIMEOUT từ browser adapter, không có partial text. Chẩn đoán chỉ đọc, không gửi lại hoặc đổi model. Ngưỡng browser poll hiện là 120000ms; proxy sau đó ghi completed=0, failed=1, active=0 cho lượt này. Chưa chốt nguyên nhân duy nhất: phải tách thời gian nạp context, model Web, DOM và overhead bridge khi tối ưu tiếp. [Metadata sự cố](mcp/native-latency-incident.json). Đây là baseline trước tối ưu độ trễ; kết quả 188 tests không thay thế hiệu năng Google live.

## Giới hạn cần biết khi tự test

- IDE chính chưa được chuyển endpoint; dùng cửa sổ Gemini Web Native Test và chọn Gemini Web (Local). Adapter launcher cũ và trường nativeInference trong MCP/health vẫn giữ gate thận trọng; chúng không tự chứng nhận toàn ma trận native chỉ từ hai ca PASS.
- Google login/metadata vẫn dùng Cloud Code chính thức. Generation model khác bị từ chối 409; không fallback sang Google API. Tác vụ phụ đặt tên chat có thể thất bại vì vẫn chọn model gốc.
- writeTrajectoryAcls và recordTrajectoryAnalytics ngoài allowlist trả 404. Hai ca native trên vẫn hoàn tất; chưa chứng nhận khả năng đồng bộ lịch sử/ACL và mọi tính năng phụ của IDE.
- Chỉ text/function history. Chưa ảnh/attachment, native incremental tokens, pin model family/effort, đo quota, context window thực, compaction hoặc toàn bộ command approval matrix. maxTokens=100000 trong catalog chỉ đáp ứng checkpoint validator của build IDE, không phải cam kết giới hạn Gemini Web.
- Mỗi request tạo browser conversation mới và truyền lại đầy đủ native context; có thể tốn thời gian hơn một lượt chat Web đơn giản. Không cắt lịch sử để giả thành công.
- Computer Use skill cấm điều khiển terminal commands trực tiếp hoặc gián tiếp qua UI. Vì vậy đã gửi prompt sửa file/chạy check cho người dùng tự thực hiện; chưa gọi đó là PASS khi chưa có native receipt thật.

[Cách chạy và rollback](../archive/guides/NATIVE_SETUP.md), [ADR 0008](../archive/adr/0008-native-gemini-web-provider.md), [third-party notices](../../THIRD_PARTY_NOTICES.md).
