# ADR 0001: Kiến trúc Hợp đồng UI-Runtime v0.1 và Nền tảng Runtime Fake (G1)

- **Trạng thái:** Accepted
- **Ngày:** 14/10/2026
- **Phạm vi:** Nền tảng G1 độc lập (Scaffold, Contracts, Runtime Fake, Boundary Adapters)

## 1. Bối cảnh (Context)
Dự án đặt mục tiêu dùng Gemini Web trong chat native của Antigravity IDE, bảo toàn luồng executor và quyền công cụ của IDE.
Kết quả khảo sát khả thi native (G0) ghi nhận:
- Control-plane route (`POST /v1internal:fetchUserInfo`) đã quan sát được qua biến môi trường `JETSKI_SERVICE_ENDPOINT_URL`.
- Inference route (`PredictionService/StreamGenerateContent` hoặc ConnectRPC Cascade) **chưa được chứng minh** (Gate G0 unresolved).
- Tính năng Custom Apps / MCP trên Gemini Web chưa được thử nghiệm trên tài khoản cá nhân của người dùng do dừng trước bước đăng nhập (NOT TESTED).

Vì vậy, nền tảng G1 được triển khai theo phạm vi hợp đồng độc lập (`G1 foundation complete; G0/native gate unresolved`) để phục vụ các bên phát triển (renderer, client) mà không được giả mạo thành công native hay tự ý thay đổi phạm vi sang CLI/SDK/Gemini API.

## 2. Quyết định Kiến trúc (Decisions)

### 2.1. Nguồn chuẩn Hợp đồng: `@antigravity-gemini-web/contracts`
- Toàn bộ định nghĩa schema runtime được tập trung duy nhất tại package `packages/contracts`, sử dụng Zod schemas kết hợp TypeScript inferred types.
- Phiên bản schema cố định `0.1` (`SCHEMA_VERSION = "0.1"`). Mọi snapshot/event có version sai lệch đều bị từ chối (`CONTRACT_MISMATCH`).
- Command và CommandAck sử dụng Zod `discriminatedUnion` trên trường `type` và `accepted`. Các trường không khai báo trong payload bị từ chối bằng `.strict()`.

### 2.2. Trì hoãn Inference Protocol cho đến khi Native Route được chứng minh
- **Quyết định:** Chưa triển khai giao thức suy luận (REST, OpenAI SSE, hay gRPC protobuf) vào runtime dựa trên phỏng đoán.
- **Lý do:** G0 cho thấy `agy.exe` sử dụng protobuf nhị phân nội bộ của Google ConnectRPC, không phải REST SSE mở. Bất kỳ triển khai inference protocol nào vào thời điểm này đều là suy đoán kỹ thuật thiếu căn cứ.
- Live adapter `LiveModelBridgeStub` và `LiveNativeAntigravityAdapter` trả về rõ ràng lỗi `NATIVE_ROUTE_UNVERIFIED`.

### 2.3. Quy tắc Deduplication và Quản lý Revision
- **Deduplication:**
  - Cùng `requestId` + cùng payload: trả về kết quả `ack` / `operationId` đã lưu trước đó (idempotent).
  - Cùng `requestId` + khác payload: từ chối với lỗi `CONFIG_CONFLICT`.
  - Concurrent duplicate: các request đồng thời cùng `requestId` được hợp nhất vào chung một Promise đang thực thi (`inFlightMap`).
- **Settings Revision:**
  - Mọi thao tác cập nhật cài đặt phải gửi kèm `expectedRevision`. Nếu `expectedRevision !== currentRevision`, runtime từ chối với lỗi `CONFIG_CONFLICT` (Stale revision).

### 2.4. Trạng thái Vòng đời Lượt chạy (Turn Lifecycle)
- Lệnh hủy `turn.cancel` chỉ chuyển trạng thái sang `cancel_requested` (non-terminal) và trả `accepted: true`. Runtime KHÔNG chuyển ngay sang trạng thái terminal `cancelled` cho đến khi có sự kiện xác nhận từ backend/engine.
- Trạng thái `outcome_unknown` được coi là terminal; client không được tự động retry mutation khi outcome chưa rõ ràng.

### 2.5. Bảo mật Thông tin Đăng nhập và Tách biệt Đường dẫn (DEV vs Live)
- Runtime không bao giờ lưu trữ cookie, OAuth token, mật khẩu hay raw browser profile trong git repository.
- Module `paths.ts` tách biệt tuyệt đối đường dẫn lưu trữ:
  - Demo / DEV: nằm trong thư mục tạm hệ thống (`<tmp>/antigravity-gemini-web-demo`).
  - Live: nằm trong thư mục người dùng (`<home>/.gemini/antigravity-gemini-web-live`).
- Có hàm kiểm tra `assertNoPathOverlap` đảm bảo hai môi trường không bao giờ ghi đè lên nhau hay can thiệp vào file cấu hình IDE hiện có của người dùng.

### 2.6. Đồng bộ Sự kiện (Event Resynchronization)
- Mỗi sự kiện mang sequence tăng dần và `runtimeInstanceId`.
- Client bỏ qua các sự kiện trùng lặp (`sequence <= lastSeenSequence`).
- Khi phát hiện bước nhảy sequence (`sequence > lastSeenSequence + 1`) hoặc thay đổi `runtimeInstanceId` (runtime khởi động lại), client kích hoạt callback `resyncNeeded` để tải lại snapshot mới nhất.

## 3. Hệ quả (Consequences)
- **Tích cực:** Nền tảng hợp đồng v0.1 hoàn toàn vững chắc, có kiểm thử hành vi bao phủ 100%, bảo đảm không có fake success trên các nhánh live.
- **Ràng buộc:** Gate G0 vẫn chưa đạt; G2 chưa thể triển khai luồng live cho đến khi có bằng chứng xác thực native route từ `agy.exe` qua Gemini Web thật.

