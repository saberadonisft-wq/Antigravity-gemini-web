# G4: Khắc phục MODEL_UNAVAILABLE và nghiệm thu native UI

Ngày 16/10/2026 (Asia/Saigon). Tiếp tục G4, giữ **4 Argon / Low**; không commit/push, chưa G5.

## Lỗi thực tế và thay đổi

Ảnh người dùng ghi rõ `[Gemini Web error: MODEL_UNAVAILABLE]` trong native IDE. Một probe protocol thành công không đủ nghiệm thu lỗi này. Đã tái hiện trực tiếp bằng Computer Use: revision 5 vẫn lỗi; revision 6 chẩn đoán `modelSelection={stage:open_effort, verificationOnly:false}`, trước khi input/Send. Native request lỗi này là `native_1cd6a21852431b854fac383f54f37008e1197cd49d7f4f313afbaefd0bef875d`.

Trace control cho thấy model Argon và Low có marker selected, nhưng menu đóng giữa các bước đọc; cách mở lại dựa trên số model rows có thể bấm đóng cả submenu hoặc chờ một menu đã đóng đến hết budget. Đã sửa:

- Dùng aria-expanded làm trạng thái root. Không suy ra root đóng từ việc model rows tạm vắng khi submenu mở.
- Mỗi bước chọn/xác minh bảo đảm lại menu hiện tại, phục hồi popover đóng trong cùng budget hữu hạn. Không lặp Send. VerifyOnly vẫn từ chối model/effort bị đổi.
- Giữ submenu đã có Low selected; xác nhận menu đóng trước khi gửi.
- Bật focus emulation riêng cho owned conversation tab khi mở/resume, tắt khi suspend. Người dùng tiếp tục ở IDE; không áp dụng override lên tab gốc/draft.
- Giữ metadata lỗi stage/verificationOnly qua schema strict. Không ghi raw DOM, prompt hoặc thông báo lỗi driver vào ledger.

## Kiểm thử local

`npm test`: **210/210 PASS**, 0 fail/skip (contracts 8, browser 28, MCP 29, model bridge 4, native 28, runtime 80, launcher 33). Build, typecheck và lint PASS; lint hiện là TypeScript noEmit. Logs local `.tmp/g4-followup-{build,test,typecheck,lint}.log`.

Regression browser dùng submenu effort riêng, option mount trễ và menu tự đóng một lần trong khi mount. Sau đó xác minh 3 lần với composer lớn, kiểm tra draft không đổi, menus đã đóng, chưa Send; đổi effort sang High thì verifyOnly Low phải từ chối và giữ High. Regression MCP kiểm tra diagnostic hợp lệ được giữ, trường dữ liệu lạ bị bỏ, raw driver message không lộ và không có browser Send.

## Nghiệm thu trên native IDE và Gemini Web thật

[Metadata UI + proxy + browser](mcp/native-model-menu-ui-live.json). Đã dùng `computer-use` / `@oai/sky` thao tác đúng cửa sổ **Gemini Web Native Test**, model **Gemini Web (Local)**. Browser runtime fingerprint version **6**, native proxy runtimeRevision **7**. Không gọi native tools trong các lượt này.

| Ca | Quan sát thật | Kết quả |
| --- | --- | --- |
| Native UI gửi prompt đầu | Assistant hiển thị `IDE_OK_3`; proxy completed, 70.565 ký tự, tổng 17.989 ms, text đầu 16.721 ms | PASS |
| Gửi tiếp trong cùng chat | Assistant hiển thị `IDE_FOLLOWUP_OK`; proxy completed, reused=true; 1.628 ký tự thay vì full 70.759; tổng 55.057 ms | PASS |
| Cancel khi browser có observable generation | Bấm nút Cancel của IDE; UI hiện `User cancelled agent execution.`, không còn Working/Cancel; proxy active=0, code=CANCELLED | PASS |
| Đối chiếu browser sau Cancel | gemini_result.status=cancelled; browser ready, activeRequestId=null, retainedConversations=0 | PASS |

Lượt tiếp nối giảm khoảng 97,7% ký tự nhưng mất lâu hơn lượt đầu: không coi delta là cam kết latency. Native proxy đánh dấu lượt hủy failed/CANCELLED, không cộng completed; browser cancellation được đối chiếu riêng. Phép đo active=0 sau click không được gọi là latency riêng của Stop phía Google.

[Probe protocol trước đó](mcp/native-model-menu-live.json) ở revision 5 đã PASS hai lượt synthetic 79.743/1.516 ký tự, trong khi UI vẫn lỗi. Artifact đó được giữ để thể hiện rõ giới hạn của protocol-only acceptance, không dùng làm bằng chứng UI đã hoạt động ở revision 5.

## Phạm vi còn lại

Các phép đo trên là snapshot revision 7. Bridge hiện đã lên revision 8 để [sửa trường hợp tab gốc bị đóng](g4-native-retained-tab-validation.md). Không tự replay các lượt lỗi cũ. Native sửa file/chạy test, compaction và installer vẫn là phạm vi riêng; các lượt chat/Cancel trên không chứng nhận chúng. Không đổi model sang Flash, không sửa IDE chính hoặc binary và không mở gateway public.
