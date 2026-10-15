# Hợp đồng UI – runtime, bản dự thảo v0.1

Ngày lập: 14/10/2026; cập nhật 15/10/2026. Shared schemas/interface ở `packages/contracts`; Electron main/preload IPC đã ghép và desktop acceptance thật. Public surface vẫn v0.1, chưa phát hành; **G4-A launcher/control/fixture VERIFIED**, G4-B chưa nghiệm thu. Đây không phải hợp đồng model API của Antigravity. Xem [G3 additions](evidence/g3-codex-remediation-validation.md) và [G4 validation hiện tại](evidence/g4-acceptance-validation.md).

MCP bổ sung 15/10 có private stdio host/browser servers và web Streamable HTTP, độc lập với `LauncherClient`/preload IPC. Không thêm raw credential hay tool executor vào renderer; không đổi native capability thành available chỉ vì MCP protocol test PASS. [MCP setup và ranh giới](MCP_SETUP.md).

## 1. Nguyên tắc transport

- Renderer gọi một `LauncherClient`, không gọi trực tiếp Gemini, shell, filesystem, trình duyệt hoặc endpoint inference.
- Demo dùng `MockLauncherClient`; desktop live dùng preload client. Không có preload trong live mode thì báo lỗi, không tự dùng mock.
- Electron main sở hữu IPC allowlist, validate input/output và runtime credentials. Renderer không nhận cookie, access token, mật khẩu, raw browser profile hay secret trong URL.
- G4 transport dùng reply envelope nội bộ `{ok, value | error}`, unsubscribe/preload-ready private; không thêm methods public. Main derive frame/sender/origin thật. Browser/check/export/cancel có durable queued operation rồi ACK trước external wait; terminal commit trước event, lỗi persistence fail closed. Settings sync giữ known rejection. Export Cancel là terminal failed/CANCELLED; UI chờ OperationRecord, không báo success từ ack. Xem [review continuation](evidence/G4_CONTINUE_CODE_REVIEW.md), [validation 15/10](evidence/g4-codex-followup-validation.md) và [prompt G4](GEMINI_G4_CONTINUE_PROMPT.md).
- Nếu cần HTTP nội bộ: bind loopback, xác thực riêng cho control API, kiểm tra nguồn request và version. Không mặc định dựa vào CORS như authentication. Browser renderer không giữ control token.
- Tất cả timestamp là UTC ISO 8601; UI chuyển theo locale. ID là opaque string. Error code và state dùng enum tiếng Anh, UI có thể dịch nhãn.

## 2. Client surface v0.1

```ts
interface LauncherClient {
  getSnapshot(): Promise<RuntimeSnapshot>;
  execute(command: ControlCommand): Promise<CommandAck>;
  getOperation(operationId: string): Promise<OperationRecord>;
  getSessions(cursor?: string): Promise<Page<SessionSummary>>;
  getActivity(query: ActivityQuery): Promise<Page<ActivityEntry>>;
  subscribe(onEvent: (event: RuntimeEvent) => void): () => void;
}
```

Chữ ký thực thi ở `packages/contracts/src/client.ts`; renderer G4 import shared types/schemas hiện tại. Không giữ enum/types copy riêng. Mock client thuần browser hoặc mock engine ở main chỉ dành cho demo; renderer không import runtime có Node dependencies.

### RuntimeSnapshot

| Field | Giá trị/ý nghĩa |
|---|---|
| `schemaVersion` | Literal `"0.1"`; từ chối version không hỗ trợ |
| `runtimeInstanceId` | ID thay đổi khi runtime restart |
| `revision` | Số tăng dần trong một runtime instance |
| `lastEventSequence` | Mốc event tương ứng với snapshot để đồng bộ |
| `observedAt` | Thời điểm runtime tạo snapshot |
| `mode` | `demo` hoặc `live` |
| `runtime` | `{ state: stopped\|starting\|ready\|degraded\|stopping\|failed, version?, error? }` |
| `browser` | `{ state: closed\|opening\|ready\|needs_user_action\|failed, actionReason?, error? }` |
| `account` | `{ state: unknown\|signed_out\|checking\|signed_in\|needs_user_action, displayLabel?, checkedAt? }` |
| `integration` | `{ target: native_ide, state: unverified\|unsupported\|not_installed\|installing\|connected\|disconnected\|conflict\|failed, hostVersion?, checkedAt?, error? }` |
| `capabilities` | Capability map bên dưới |
| `availableModels` | `{ id, label, availability: unverified\|available\|unavailable, verifiedAt? }[]` |
| `selectedModelId` | String hoặc null; không suy đoán từ model mặc định |
| `sessions` | Tóm tắt session hiện tại; danh sách dài tải qua pagination |
| `settings` | Cấu hình không chứa bí mật, có `revision` riêng |
| `lastCheck` | `{ operationId, at, checks: CheckResult[] }` hoặc null |

`displayLabel` chỉ là tên hiển thị/masked account label nếu backend cung cấp. Không cần email đầy đủ cho UI. Unknown luôn khác false/zero.

### Capabilities

Map các key: `nativeRoute`, `modelSelection`, `toolExecution`, `customMcp`, `cancelTurn`, `imageInput`, `contextCompaction`, `usageObservation`, `logExport`.

Mỗi value: `{ state: unverified | available | unavailable, reasonCode?, detail?, verifiedAt? }`.

Capability điều khiển việc hiện/disable nút, nhưng backend vẫn phải kiểm tra quyền khi nhận command. `usageObservation` chỉ nói có dữ liệu quan sát; không có nghĩa biết quota chính thức. Không dựng trang MCP setup cụ thể khi capability chưa available.

### SessionSummary và TurnSummary

Session: `{ id, workspaceLabel, hostTaskId?, modelId, createdAt, updatedAt, activeTurn?, lastOutcome? }`.

Turn: `{ id, sessionId, state, phaseLabel?, startedAt?, updatedAt, completedAt?, error?, canCancel }`.

State từ shared TurnStateSchema; sơ đồ minh họa, đường chuyển hợp lệ do canTransitionTurnState quyết định:

```text
queued → reserved → preparing / awaiting_user → submitting → accepted → generating / streaming
generating / streaming ↔ tool_pending ↔ tool_running
đã submit → completed
nonterminal → cancel_requested → cancel_confirmed / cancelled
bất kỳ nonterminal → failed | interrupted | outcome_unknown
```

`awaiting_user` là tùy chọn, dùng cho login/approval/host interaction. UI phải hiển thị lý do và hành động backend cung cấp; không tự bấm approval trong browser.

`completed`, `cancelled`, `cancel_confirmed`, `failed`, `interrupted`, `outcome_unknown` là terminal. Dùng isTerminalTurnState của shared contracts; chỉ runtime quyết định chuyển state. Kết quả muộn không được ghi đè terminal. Không có nút “Retry tất cả” cho `outcome_unknown`. Ack cancel chỉ báo nhận yêu cầu; UI chờ xác nhận nguồn thật.

### Error và check

```ts
type UiError = {
  code: string;
  message: string;
  retryable: boolean;
  suggestedAction?: "open_browser" | "run_check" | "review_integration" | "view_activity";
  correlationId?: string;
};
type CheckResult = {
  key: "host" | "route" | "browser" | "account" | "model" | "tools";
  status: "not_run" | "running" | "passed" | "failed" | "unsupported";
  summary: string;
  checkedAt?: string;
};
```

Mã lỗi mock tối thiểu: `HOST_NOT_FOUND`, `NATIVE_ROUTE_UNVERIFIED`, `NATIVE_ROUTE_UNSUPPORTED`, `CONFIG_CONFLICT`, `LOGIN_REQUIRED`, `BROWSER_USER_ACTION_REQUIRED`, `MODEL_UNAVAILABLE`, `BROWSER_UI_CHANGED`, `CONTEXT_TOO_LARGE`, `TURN_TIMEOUT`, `TOOL_DENIED`, `OUTCOME_UNKNOWN`, `RUNTIME_DISCONNECTED`, `CONTRACT_MISMATCH`.

Không trả stack trace/raw HTML/raw prompt trong `message`. Correlation ID giúp tra log an toàn.

## 3. Commands

Mọi command có `{ requestId, type, payload }`. ID tạo một lần khi người dùng bấm; retry do mất kết nối dùng lại ID và cùng payload. Backend trả lại acknowledgment/operation cũ khi còn dedupe record. Cùng ID khác payload trả conflict. Nếu qua crash không xác minh được kết quả thì trả trạng thái chưa rõ; không chạy lại thao tác ghi.

| `type` | `payload` | Hành vi và điều kiện |
|---|---|---|
| `browser.open` | `{}` | Mở/focus browser riêng; không đảm bảo đã đăng nhập |
| `account.check` | `{}` | Kiểm tra phiên đăng nhập, cập nhật snapshot |
| `runtime.check` | `{ scope: connection\|end_to_end }` | Connection kiểm tra trạng thái; end-to-end có thể gửi prompt, cần nút/copy nói rõ |
| `integration.preview` | `{ action: install\|disconnect\|restore }` | Trả preview opaque ID, version/hash cấu hình, thay đổi đã redact và expiry |
| `integration.apply` | `{ previewId }` | Chỉ sau người dùng xem và bấm xác nhận; kiểm tra cấu hình chưa đổi, không có active turn |
| `model.select` | `{ modelId }` | Chỉ model verified available; reject nếu còn active turn |
| `turn.cancel` | `{ sessionId, turnId }` | Ack là đã nhận yêu cầu; chờ event terminal mới ghi “Đã hủy” |
| `settings.update` | `{ expectedRevision, patch }` | Allowlist settings; trả conflict nếu revision cũ |
| `activity.export` | `{ range: current_session\|last_24h }` | Main mở save dialog; export đã redact, không prompt/cookie |

Không có command chạy shell tự do, đọc file tùy ý hoặc gửi JavaScript tùy ý. Login diễn ra trong browser. Logout/delete profile chưa nằm trong v0.1; không dựng nút gọi API giả cho thao tác đó.

Settings v0.1: `theme: system|light|dark`, `language: vi|en`, `diagnosticLevel: normal|verbose_redacted`. Không cho renderer sửa host route, browser profile path, workspace roots hoặc timeout an toàn qua generic patch. Các thiết lập cần restart phải được backend khai báo, không âm thầm có hiệu lực.

`CommandAck = { requestId, accepted: true, operationId } | { requestId, accepted: false, error }`.

`OperationRecord = { id, requestId, type, state: queued|running|succeeded|failed|outcome_unknown, progressLabel?, result?, error?, updatedAt }`.

`result` là union theo command: preview plan, report check, setting revision hoặc receipt không chứa dữ liệu nhạy cảm. Có ack không đồng nghĩa thao tác thành công. UI chỉ render success khi `operation` và snapshot thích hợp xác nhận.

## 4. Events và reconnect

Envelope: `{ schemaVersion, runtimeInstanceId, sequence, id, occurredAt, type, sessionId?, turnId?, payload }`.

Types: `snapshot.updated`, `operation.updated`, `session.updated`, `activity.appended`, `runtime.disconnected`.

Cho v0.1, `snapshot.updated` có thể mang snapshot đầy đủ để giảm lỗi merge. Event không chứa prompt hay toàn văn tool output; launcher quản lý phiên, không sao chép toàn bộ chat IDE.

- Subscribe rồi lấy snapshot và tạm buffer events; bỏ event cùng instance có sequence ≤ snapshot.lastEventSequence, áp dụng phần còn lại theo thứ tự.
- Bỏ event trùng; gap sequence hoặc runtimeInstanceId đổi thì lấy snapshot mới và đối chiếu các operation đang pending.
- Disconnect hiển thị “Mất kết nối — trạng thái cuối lúc …”; không tự coi turn đã hủy hoặc hoàn thành.
- Reconnect không tự gửi lại `integration.apply`, tool write hoặc prompt. `getOperation` trước khi quyết định.
- Mock phải có scenario event đến trễ, trùng, gap và runtime restart. Không dùng thời gian animation để quyết định state nghiệp vụ.

ActivityEntry: `{ id, at, severity: info|warning|error, category, summary, correlationId?, sessionId?, turnId? }`.

ActivityQuery: `{ cursor?, sessionId?, severity?, limit? }`; `Page<T> = { items: T[], nextCursor?: string }`. Runtime giới hạn limit và độ dài summary. Mock có thể cung cấp 30–50 dòng đại diện.

## 5. Mocks bắt buộc và cách bàn giao

1. First run: chưa xác minh native route, chưa đăng nhập.
2. Login cần thao tác người dùng; browser ready không đồng nghĩa signed in.
3. Signed in nhưng native route unsupported/unverified.
4. Live connection ready, không có session.
5. Turn generating → tool pending/running → completed.
6. Cancel requested nhưng chưa nhận terminal event.
7. Config conflict hoặc model unavailable.
8. Runtime disconnected → reconnect → snapshot mới.
9. Browser UI changed và context too large.
10. Outcome unknown sau một thao tác ghi.

Mock scenarios có nhãn “Demo · dữ liệu mô phỏng” cố định. Mọi ID và account label là synthetic. Khi live contract có thay đổi, Codex cập nhật schema trước, Gemini cập nhật UI sau; hai bên thống nhất changelog trước khi ghép.
