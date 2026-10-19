# G4: Browser đóng và native chat kẹt Working

Ngày 15/10/2026. Tiếp tục sửa lỗi thực tế theo ảnh người dùng, vẫn trong G4. Không commit/push đợt này, không sửa IDE chính hoặc binary.

Cập nhật 16/10: nội dung dưới giữ snapshot chẩn đoán/readiness revision 4. Bản hiện tại là revision 7, đã nghiệm thu chat tiếp nối và Cancel trực tiếp trong IDE; xem [bản sửa MODEL_UNAVAILABLE](g4-native-model-menu-validation.md).

## Chẩn đoán quan sát được

Người dùng đã ở cửa sổ Gemini Web Native Test và chọn Gemini Web (Local). Lượt `alo` có requestId `native_f75fb3679cddd5bd679a406f42c5b3b4bdd5305040d02475eaf23b0cf95603a4`, fullPromptChars=70445, phase=failed, code=BROWSER_NOT_READY, elapsedMs=9, firstTextMs=null. Proxy revision 3 đã active=0, nhưng UI vẫn Working. Browser broker độc lập báo closed/unknown, activeRequestId=null. Không có bằng chứng lượt này được gửi sang Google; không replay yêu cầu đó.

Có hai lỗi cần phân biệt: generation chưa tự mở browser; luồng lỗi sau SSE headers của revision 3 chưa kết thúc Working trên UI người dùng. Chưa có trace để kết luận riêng finishReason OTHER hay data error gây ra phần thứ hai.

Kiểm tra tiếp sau khi người dùng chọn “Có thông báo lỗi”: log session `20261015T213314/ls-main.log` ghi panic `invalid memory address or nil pointer dereference` trong `streamGenerateContentFromCCPA.func2`, rồi Language Server exit code 2 lúc 21:34:00. Main log sau đó có ECONNREFUSED đến port LS cũ. Đây là crash thực tế, không chỉ một nhãn Working chậm cập nhật. Chưa đủ chứng cứ để quy riêng một trường SSE gây panic.

## Thay đổi revision 4

- Readiness trước SSE: mở browser đóng một lần, chờ composer signed_in trong startup budget 20 giây; cancellation vẫn ngắt được broker không hợp tác. Status không có side effect.
- Thiếu đăng nhập trả HTTP 412/FAILED_PRECONDITION với reason BROWSER_LOGIN_REQUIRED và không submit prompt. Không tự điền tài khoản hoặc gửi lại prompt.
- Lỗi sau khi stream đã mở trả một candidate text có nhãn Gemini Web error và STOP làm ranh giới wire. Diagnostic/receipt vẫn failed, completed không tăng, không trả native functionCall.
- native:launch mở browser trước khi mở IDE và kiểm tra runtimeRevision, từ chối proxy cũ để tránh nạp source mới nhưng vẫn chạy process cũ.
- Model selection chờ đúng option 4 Argon và Thinking level/Low mount, thay vì chỉ chờ option đầu tiên xuất hiện. Không fallback model.

## Thử Gemini Web thật

[Metadata](mcp/native-autostart-live.json), `node tools/probes/native-autostart-smoke.mjs --live`. Caller là protocol client loopback tổng hợp, không phải UI Antigravity; không gọi native tools. Chỉ gửi một prompt fixture. Runtime revision 4; CDP trước khi gửi không reachable; HTTP 200; đúng marker NATIVE_AUTOSTART_OK; phase completed; tổng 9892 ms, text đầu 8611 ms. Browser tự mở và phản hồi thật với chính sách 4 Argon / Low được kiểm tra trước Send.

Lần thử cold startup trước đó đã mở browser nhưng thất bại MODEL_UNAVAILABLE; kiểm tra fresh tab thấy option mount trễ. Sau bổ sung chờ đúng option, ca cold startup trên PASS. Không tự resend request lỗi cũ; mỗi probe có ID mới và prompt tổng hợp riêng. Một lần PASS không chứng minh mọi lượt đều đạt cùng latency.

## Ranh giới nghiệm thu

Regression HTTP kiểm tra startup login failure trước headers, late failure text terminal (failed không đổi thành succeeded), cancel trong readiness, browser mở đúng một lần và startup budget hữu hạn. Browser fixture kiểm tra model picker và model option mount lệch nhau. Kết quả toàn bộ kiểm tra local được ghi tại [báo cáo hồi quy](g4-native-latency-cancellation-validation.md).

**Snapshot revision 4: native UI lúc đó chưa nghiệm thu.** Computer Use native pipe khi đó unavailable, đã yêu cầu người dùng tạo chat mới. Lượt Working cũ thuộc HTTP đã kết thúc không thể được sửa hồi tố. Ca protocol PASS ở snapshot này không được thay cho UI acceptance; revision 7 đã có bằng chứng UI riêng ở liên kết trên.

Người dùng dán envelope có `type=final`, `text=NATIVE_AUTOSTART_OK`; đây khớp với phép thử protocol trên, không phải lỗi và chưa chứng nhận chat IDE. Tại thời điểm kiểm tra, proxy revision 4 chỉ nhận một generation của probe, chưa có generation IDE mới, và không còn tiến trình IDE. Đã chạy lại `npm run native:launch`: browser ready/signed_in; log session `20261015T221024` ghi LS PID 20080 initialized, endpoint 127.0.0.1:9236; proxy nhận fetchAvailableModels HTTP 200 (catalog counter=3). Các lần test UI tiếp theo đã phát hiện MODEL_UNAVAILABLE và dẫn đến bản sửa revision 7; không tự replay lượt cũ.
