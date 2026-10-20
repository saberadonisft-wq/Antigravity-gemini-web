# Mã lịch sử ngoài bản sản phẩm

Các thư mục ở đây bảo toàn mã nghiên cứu và giao diện trước native revision 45. Chúng không phải workspace, không được biên dịch hoặc đưa vào launcher. Một số đường import phản ánh vị trí cũ; muốn tái lập nguyên phiên bản dùng Git tại commit tương ứng.

- `launcher-r44`: giao diện phụ, fixture và IPC/runtime cũ.
- `packages/runtime`, `packages/model-bridge`: runtime demo và parser thử nghiệm đã rời đường chạy sản phẩm.
- `native-experiments`: integration test và handler knowledge/ZIP đã rút khỏi API native.

Browser broker, receipt ledger, connector và giao thức native hiện hành vẫn ở `packages/`. Không lấy mã ở đây làm hướng dẫn bật lại Chrome riêng.
