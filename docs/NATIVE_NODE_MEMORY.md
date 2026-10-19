# Điều chỉnh vùng nhớ Node cho browser MCP

Source Native **37 / browser worker 24**, ngày 19/10/2026. Đây là tùy chọn thử nghiệm, **mặc định tắt**. Nó điều chỉnh semi-space của V8, không đặt trần RAM cho toàn ứng dụng hay Chrome.

## Bật và tắt

`AG_MCP_NODE_SEMI_SPACE_MB` nhận đúng `8`, `16`, `off`; bỏ biến hoặc để rỗng tương đương `off`. Các giá trị khác bị từ chối trước khi tạo worker. Không nhận chuỗi Node arguments tùy ý.

Sau khi hoàn tất bước xác minh Google đang chờ, đợi lượt hiện tại kết thúc và dùng quy trình dừng/khởi động lại có kiểm soát trong [runbook](NATIVE_RECOVERY_RUNBOOK.md). Cấu hình được chốt khi khởi động; đặt biến trong PowerShell trước lần launch mới:

```powershell
$env:AG_MCP_NODE_SEMI_SPACE_MB = '8'
npm run native:launch
```

Để bỏ tùy chọn trong lần khởi động tiếp theo:

```powershell
$env:AG_MCP_NODE_SEMI_SPACE_MB = 'off'
```

`off` ngừng truyền flag do tính năng này quản lý; nó không xóa cấu hình Node khác do người dùng đặt, chẳng hạn `NODE_OPTIONS`. Không thay đổi policy của process đang chạy bằng cách sửa biến môi trường ở terminal khác.

## Kiểm tra cấu hình thực tế

Native chốt lựa chọn cho pool và backend, truyền flag cho stdio frontend lẫn shared-service owner. Browser MCP CLI được client khác khởi chạy trực tiếp vẫn truyền lựa chọn tới shared owner; frontend Node của client đó chỉ nhận flag nếu chính client đặt flag lúc spawn.

- Native health `backendResources.requestedNodeSemiSpaceMiB` là lựa chọn yêu cầu: `8`, `16` hoặc `null`. Trường này chưa chứng minh worker đã áp dụng.
- MCP `gemini_status.nodeMemory` trả `scope: shared_owner`, PID owner, `requestedSemiSpaceMiB`, `explicitCliSemiSpaceMiB` và `status`. Khi bật, hai giá trị phải bằng nhau và `status` phải là `applied`.
- `not_requested` nghĩa là tính năng không áp đặt policy. `explicitCliSemiSpaceMiB` chỉ mô tả flag CLI, không phân tích hay công khai `NODE_OPTIONS` hoặc toàn bộ command line.

Fingerprint worker gồm cả lựa chọn này. Worker cũ hoặc cấu hình khác trả conflict; không bị tự động dừng, thay profile hay gửi lại request. Ngắt các client đang giữ worker cũ qua quy trình vận hành hiện có, rồi khởi động với cấu hình thống nhất khi nhàn rỗi. Giữ nguyên profile, ledger, replay fences và restoration journals.

Nếu cấu hình bật nhưng owner thiếu flag, runtime từ chối trước khi tạo browser adapter. Nếu status không xác nhận đúng policy, Native chặn trước hành động mở browser và Send. Mã lỗi `BROWSER_RUNTIME_UPDATE_REQUIRED` ở đây yêu cầu đối chiếu worker/config, không phải đăng nhập lại hay đổi tài khoản.

## Bằng chứng và giới hạn

[Benchmark source 36](evidence/g4-native-p8c-mcp-process-memory.md) dùng hai owner/bốn frontend thật, SQLite và browser giả lập. Mỗi owner xử lý 2.180 lượt. 8 MiB là ứng viên giảm RSS của owner trong workload đó; chưa chứng minh cấu hình tối ưu cho Chrome/DOM hoặc độ trễ Gemini thật. Policy source 37 không thay đổi mặc định.

Kiểm thử source 37 chạy production CLI bootstrap với `8`, `16`, `off`, kiểm tra PID owner khác frontend, conflict giữ nguyên worker cũ và missing-flag không tạo runtime. Luồng Native thật dùng entry thử nghiệm xác nhận flag ở cả hai process trước khi import production CLI; chỉ tra receipt trên profile tạm, không mở Chrome. Các kiểm thử khác chặn status thiếu/giả hoặc thuộc frontend trước Send và xác nhận cấu hình không đổi theo môi trường sau constructor.

Gate tiếp theo: lặp benchmark với Chrome/DOM thật, nhiều account/chat và thời gian chạy dài; theo dõi CPU, độ trễ, RSS và process count. Các gate Web/IDE, P6/P7 và recovery/rollback của [kế hoạch tổng thể](NATIVE_UPGRADE_PLAN.md) vẫn mở.
