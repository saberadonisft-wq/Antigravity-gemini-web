import { ControlCommandSchema, OperationRecordSchema, type Settings } from "@antigravity-gemini-web/contracts";
import type {
  LauncherClient,
  RuntimeSnapshot,
  ControlCommand,
  CommandAck,
  OperationRecord,
  SessionSummary,
  ActivityQuery,
  ActivityEntry,
  RuntimeEvent,
  Page,
  UiError,
} from "@antigravity-gemini-web/contracts";

export type MockScenarioId =
  | "first_run"
  | "login_required"
  | "signed_in_route_unsupported"
  | "connection_ready_no_sessions"
  | "turn_generating_tools"
  | "cancel_requested"
  | "config_conflict_or_model_unavailable"
  | "runtime_disconnected"
  | "browser_ui_changed_context_too_large"
  | "outcome_unknown_write";

export interface MockScenarioInfo {
  id: MockScenarioId;
  label: string;
  description: string;
}

export const MOCK_SCENARIOS: MockScenarioInfo[] = [
  { id: "first_run", label: "1. Lần đầu chạy", description: "Chưa xác minh native route, chưa đăng nhập" },
  { id: "login_required", label: "2. Cần đăng nhập", description: "Browser đã mở nhưng tài khoản yêu cầu đăng nhập/challenge" },
  { id: "signed_in_route_unsupported", label: "3. Đã đăng nhập - Route chưa hỗ trợ", description: "Đã đăng nhập Google, nhưng IDE native route chưa verified" },
  { id: "connection_ready_no_sessions", label: "4. Kết nối sẵn sàng", description: "Kết nối đầy đủ, chưa có phiên tác vụ" },
  { id: "turn_generating_tools", label: "5. Đang xử lý - Tool running", description: "Turn generating -> tool pending -> tool running" },
  { id: "cancel_requested", label: "6. Yêu cầu hủy", description: "Hủy đang chờ terminal acknowledgment" },
  { id: "config_conflict_or_model_unavailable", label: "7. Xung đột cấu hình / Model lỗi", description: "Integration conflict hoặc model unavailable" },
  { id: "runtime_disconnected", label: "8. Mất kết nối runtime", description: "Runtime disconnect event -> khôi phục snapshot mới" },
  { id: "browser_ui_changed_context_too_large", label: "9. UI thay đổi / Quá ngữ cảnh", description: "Lỗi DOM selector hoặc context window quá lớn" },
  { id: "outcome_unknown_write", label: "10. Thao tác ghi outcome_unknown", description: "Không rõ kết quả ghi, không tự động retry tất cả" },
];

const ENGLISH_SCENARIO_LABELS: Record<MockScenarioId, string> = {
  first_run: "1. First run",
  login_required: "2. Sign-in required",
  signed_in_route_unsupported: "3. Signed in - Route unsupported",
  connection_ready_no_sessions: "4. Connection ready",
  turn_generating_tools: "5. Processing - Tool running",
  cancel_requested: "6. Cancellation requested",
  config_conflict_or_model_unavailable: "7. Configuration conflict / Model unavailable",
  runtime_disconnected: "8. Runtime disconnected",
  browser_ui_changed_context_too_large: "9. Browser UI changed / Context too large",
  outcome_unknown_write: "10. Write outcome unknown",
};

/** Picker labels are launcher copy; fixture diagnostic messages keep their source text. */
export function getMockScenarioLabel(scenario: MockScenarioInfo, language: Settings["language"]): string {
  return language === "en" ? ENGLISH_SCENARIO_LABELS[scenario.id] : scenario.label;
}

export class MockLauncherClient implements LauncherClient {
  public currentScenario: MockScenarioId = "first_run";
  private eventListeners = new Set<(event: RuntimeEvent) => void>();
  private instanceId = "demo-inst-001";
  private sequenceCounter = 1;
  private operations = new Map<string, OperationRecord>();
  private preferences: Settings = { revision: 1, theme: "system", language: "vi", diagnosticLevel: "normal" };

  constructor(initialScenario: MockScenarioId = "first_run") {
    this.currentScenario = initialScenario;
  }

  public setScenario(scenario: MockScenarioId): void {
    this.currentScenario = scenario;
    this.emitEvent({
      schemaVersion: "0.1",
      runtimeInstanceId: this.instanceId,
      sequence: this.sequenceCounter++,
      id: `evt-${Date.now()}`,
      occurredAt: new Date().toISOString(),
      type: "snapshot.updated",
      payload: { snapshot: this.buildSnapshot() },
    });
  }

  private emitEvent(event: RuntimeEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[MockLauncherClient] Listener error:", err);
      }
    }
  }

  public async getSnapshot(): Promise<RuntimeSnapshot> {
    return structuredClone(this.buildSnapshot());
  }

  public async execute(command: ControlCommand): Promise<CommandAck> {
    command = ControlCommandSchema.parse(command);
    const opId = "op-" + crypto.randomUUID();
    if (command.type === "settings.update") {
      if (command.payload.expectedRevision !== this.preferences.revision) return { requestId: command.requestId, accepted: false, error: { code: "CONFIG_CONFLICT", message: "Synthetic settings revision conflict.", retryable: false } };
      this.preferences = { ...this.preferences, ...command.payload.patch, revision: this.preferences.revision + 1 };
    }

    // Capability gating in mock mode
    if (command.type === "integration.apply" || command.type === "integration.preview") {
      const err: UiError = {
        code: "NATIVE_ROUTE_UNVERIFIED",
        message: "Native route chưa được xác minh. Không thể áp dụng thay đổi cấu hình IDE.",
        retryable: false,
        suggestedAction: "review_integration",
      };
      return {
        requestId: command.requestId,
        accepted: false,
        error: err,
      };
    }

    if (command.type === "model.select") {
      const err: UiError = {
        code: "MODEL_UNAVAILABLE",
        message: "Chuyển model bị khóa: chưa có live inference route kết nối vào Language Server.",
        retryable: false,
      };
      return {
        requestId: command.requestId,
        accepted: false,
        error: err,
      };
    }

    if (command.type === "runtime.check" && command.payload.scope === "end_to_end") {
      const err: UiError = {
        code: "NATIVE_ROUTE_UNVERIFIED",
        message: "End-to-end native check yêu cầu Language Server route đã xác minh.",
        retryable: false,
        suggestedAction: "run_check",
      };
      return {
        requestId: command.requestId,
        accepted: false,
        error: err,
      };
    }

    if (command.type === "turn.cancel") {
      const op: OperationRecord = {
        id: opId,
        requestId: command.requestId,
        type: command.type,
        state: "running",
        progressLabel: "Đang chuyển yêu cầu hủy tới runner...",
        updatedAt: new Date().toISOString(),
      };
      this.operations.set(opId, op);
      return {
        requestId: command.requestId,
        accepted: true,
        operationId: opId,
      };
    }

    const op: OperationRecord = {
      id: opId,
      requestId: command.requestId,
      type: command.type,
      state: "succeeded",
      updatedAt: new Date().toISOString(),
      result: command.type === "runtime.check" ? { checks: this.buildSnapshot().lastCheck?.checks ?? [] } : command.type === "activity.export" ? { exportedCount: 3, sanitized: true, redacted: true } : { summary: "Thao tác thành công", detail: "Acknowledged by mock backend" },
    };
    this.operations.set(opId, OperationRecordSchema.parse(op));

    return {
      requestId: command.requestId,
      accepted: true,
      operationId: opId,
    };
  }

  public async getOperation(operationId: string): Promise<OperationRecord> {
    const op = this.operations.get(operationId);
    if (!op) {
      throw {
        code: "NOT_FOUND",
        message: `Operation '${operationId}' not found.`,
        retryable: false,
      } satisfies UiError;
    }
    return structuredClone(op);
  }

  public async getSessions(_cursor?: string): Promise<Page<SessionSummary>> {
    const snap = this.buildSnapshot();
    return {
      items: structuredClone(snap.sessions),
      nextCursor: undefined,
    };
  }

  public async getActivity(query: ActivityQuery): Promise<Page<ActivityEntry>> {
    const allActivities: ActivityEntry[] = [
      {
        id: "act-001",
        at: new Date(Date.now() - 3600000).toISOString(),
        severity: "info",
        category: "runtime",
        summary: "Runtime initialized with instance demo-inst-001",
        correlationId: "cor-init-1",
      },
      {
        id: "act-002",
        at: new Date(Date.now() - 1800000).toISOString(),
        severity: "warning",
        category: "integration",
        summary: "Antigravity language server route unverified; tool dispatch locked",
        correlationId: "cor-route-warn",
      },
      {
        id: "act-003",
        at: new Date(Date.now() - 600000).toISOString(),
        severity: this.currentScenario === "outcome_unknown_write" ? "error" : "info",
        category: "session",
        summary: this.currentScenario === "outcome_unknown_write"
          ? "File patch transaction timed out; status indeterminate (outcome_unknown)"
          : "Session syn-ws-1 heartbeat acknowledged",
        correlationId: "cor-turn-outcome",
        sessionId: "syn-ws-1",
      },
    ];

    let filtered = allActivities;
    if (query.severity) {
      filtered = filtered.filter(a => a.severity === query.severity);
    }
    if (query.sessionId) {
      filtered = filtered.filter(a => a.sessionId === query.sessionId);
    }

    return {
      items: filtered,
      nextCursor: undefined,
    };
  }

  public subscribe(onEvent: (event: RuntimeEvent) => void): () => void {
    this.eventListeners.add(onEvent);
    return () => {
      this.eventListeners.delete(onEvent);
    };
  }

  private buildSnapshot(): RuntimeSnapshot {
    const base: RuntimeSnapshot = {
      schemaVersion: "0.1",
      runtimeInstanceId: this.instanceId,
      revision: 1,
      lastEventSequence: this.sequenceCounter,
      observedAt: new Date().toISOString(),
      mode: "demo",
      runtime: {
        state: this.currentScenario === "runtime_disconnected" ? "stopped" : "ready",
        version: "0.1.0-demo",
        error: this.currentScenario === "runtime_disconnected"
          ? { code: "RUNTIME_DISCONNECTED", message: "Mất kết nối với runtime backend.", retryable: true }
          : undefined,
      },
      browser: {
        state: this.currentScenario === "first_run" ? "closed"
          : this.currentScenario === "login_required" ? "needs_user_action"
          : this.currentScenario === "browser_ui_changed_context_too_large" ? "failed" : "ready",
        error: this.currentScenario === "browser_ui_changed_context_too_large" ? { code: "BROWSER_UI_CHANGED", message: "Synthetic browser DOM changed.", retryable: false } : undefined,
        actionReason: this.currentScenario === "login_required" ? "Cần hoàn tất đăng nhập Google hoặc giải CAPTCHA trong browser." : undefined,
      },
      account: {
        state: this.currentScenario === "first_run" ? "unknown"
          : this.currentScenario === "login_required" ? "needs_user_action"
          : "signed_in",
        displayLabel: this.currentScenario === "first_run" ? undefined : "Demo User (demo@synthetic.local)",
        checkedAt: new Date().toISOString(),
      },
      integration: {
        target: "native_ide",
        state: this.currentScenario === "connection_ready_no_sessions" ? "connected"
          : this.currentScenario === "first_run" ? "unverified"
          : this.currentScenario === "signed_in_route_unsupported" ? "unsupported"
          : this.currentScenario === "config_conflict_or_model_unavailable" ? "conflict"
          : "unverified",
        hostVersion: "1.108.0 (synthetic)",
        checkedAt: new Date().toISOString(),
      },
      capabilities: {
        nativeRoute: { state: "unverified", reasonCode: "UNVERIFIED", detail: "Chưa xác minh native inference hook." },
        modelSelection: { state: "unavailable", reasonCode: "UNAVAILABLE", detail: "Khóa model selector khi chưa thông inference route." },
        toolExecution: { state: "unverified", reasonCode: "UNVERIFIED", detail: "Executor IDE chưa xác thực." },
        customMcp: { state: "unavailable", detail: "Custom MCP chưa hỗ trợ trong v0.1." },
        cancelTurn: { state: "available" },
        imageInput: { state: "unavailable" },
        contextCompaction: { state: "available" },
        usageObservation: { state: "available" },
        logExport: { state: "available" },
      },
      availableModels: [
        { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (Synthetic)", availability: "unavailable" },
        { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (Synthetic)", availability: "unavailable" },
      ],
      selectedModelId: null,
      sessions: this.buildSessionsForScenario(),
      settings: structuredClone(this.preferences),
      lastCheck: {
        operationId: "chk-001",
        at: new Date().toISOString(),
        checks: [
          { key: "host", status: "passed", summary: "Tìm thấy Antigravity IDE process" },
          { key: "route", status: "failed", summary: "Native language server route unverified" },
          { key: "browser", status: this.currentScenario === "first_run" ? "not_run" : "passed", summary: "Chrome CDP target" },
          { key: "account", status: this.currentScenario === "login_required" ? "failed" : "passed", summary: "Google account session" },
          { key: "model", status: "unsupported", summary: "Model catalog unavailable" },
          { key: "tools", status: "not_run", summary: "IDE tool executor check skipped" },
        ],
      },
    };

    return base;
  }

  private buildSessionsForScenario(): SessionSummary[] {
    if (this.currentScenario === "browser_ui_changed_context_too_large") {
      return [{ id: "syn-ws-1", workspaceLabel: "Owned synthetic workspace", modelId: "gemini-2.5-pro", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        activeTurn: { id: "turn-context-failed", sessionId: "syn-ws-1", state: "failed", updatedAt: new Date().toISOString(), canCancel: false, error: { code: "CONTEXT_TOO_LARGE", message: "Synthetic context exceeded its local safety cap.", retryable: false } } }];
    }
    if (this.currentScenario === "first_run" || this.currentScenario === "connection_ready_no_sessions") {
      return [];
    }

    if (this.currentScenario === "turn_generating_tools") {
      return [
        {
          id: "syn-ws-1",
          workspaceLabel: "d:\\MyProject",
          hostTaskId: "task-42",
          modelId: "gemini-2.5-pro",
          createdAt: new Date(Date.now() - 300000).toISOString(),
          updatedAt: new Date().toISOString(),
          activeTurn: {
            id: "turn-101",
            sessionId: "syn-ws-1",
            state: "tool_running",
            phaseLabel: "Đang chạy tool 'readFile' trên workspace...",
            updatedAt: new Date().toISOString(),
            canCancel: true,
          },
        },
      ];
    }

    if (this.currentScenario === "cancel_requested") {
      return [
        {
          id: "syn-ws-1",
          workspaceLabel: "d:\\MyProject",
          hostTaskId: "task-42",
          modelId: "gemini-2.5-pro",
          createdAt: new Date(Date.now() - 300000).toISOString(),
          updatedAt: new Date().toISOString(),
          activeTurn: {
            id: "turn-102",
            sessionId: "syn-ws-1",
            state: "cancel_requested",
            phaseLabel: "Đang yêu cầu hủy tác vụ (chờ terminal ack)...",
            updatedAt: new Date().toISOString(),
            canCancel: false,
          },
        },
      ];
    }

    if (this.currentScenario === "outcome_unknown_write") {
      return [
        {
          id: "syn-ws-1",
          workspaceLabel: "d:\\MyProject",
          hostTaskId: "task-42",
          modelId: "gemini-2.5-pro",
          createdAt: new Date(Date.now() - 300000).toISOString(),
          updatedAt: new Date().toISOString(),
          lastOutcome: "outcome_unknown",
          activeTurn: {
            id: "turn-103",
            sessionId: "syn-ws-1",
            state: "outcome_unknown",
            phaseLabel: "Không thể xác định trạng thái hoàn tất sau timeout.",
            updatedAt: new Date().toISOString(),
            error: {
              code: "OUTCOME_UNKNOWN",
              message: "Thao tác ghi bị gián đoạn. Trạng thái file chưa thể xác thực.",
              retryable: false,
              suggestedAction: "view_activity",
            },
            canCancel: false,
          },
        },
      ];
    }

    return [
      {
        id: "syn-ws-1",
        workspaceLabel: "d:\\MyProject",
        hostTaskId: "task-42",
        modelId: "gemini-2.5-pro",
        createdAt: new Date(Date.now() - 300000).toISOString(),
        updatedAt: new Date().toISOString(),
        lastOutcome: "completed",
      },
    ];
  }
}
