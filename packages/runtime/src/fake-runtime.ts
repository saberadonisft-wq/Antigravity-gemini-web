import crypto from "node:crypto";
import type { TurnState } from "@antigravity-gemini-web/contracts";
import {
  SCHEMA_VERSION,
  type RuntimeSnapshot,
  type ControlCommand,
  type CommandAck,
  type OperationRecord,
  type SessionSummary,
  type ActivityEntry,
  type ActivityQuery,
  type Page,
  type RuntimeEvent,
  type UiError,
  type CheckResult,
  OperationRecordSchema,
  CapabilityKeySchema,
  type Settings,
  SettingsSchema,
  type ActivityExportResult,
  isTerminalTurnState,
  isTerminalOperationState,
} from "@antigravity-gemini-web/contracts";
import { createScenarioSnapshot, type ScenarioName } from "./scenarios.js";
import { LiveGeminiBrowserAdapter } from "@antigravity-gemini-web/gemini-browser";
import { LiveNativeAntigravityAdapter } from "@antigravity-gemini-web/native-antigravity";

export function deriveOperationId(requestId: string): string {
  return `op-${crypto.createHash("sha256").update(requestId).digest("hex").slice(0, 16)}`;
}

function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => (item === undefined ? "null" : canonicalJsonStringify(item))).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs: string[] = [];
  for (const key of keys) {
    const val = obj[key];
    if (val !== undefined && typeof val !== "function" && typeof val !== "symbol") {
      pairs.push(`${JSON.stringify(key)}:${canonicalJsonStringify(val)}`);
    }
  }
  return "{" + pairs.join(",") + "}";
}

export class FakeRuntimeEngine {
  private runtimeInstanceId: string;
  private revision: number;
  private lastEventSequence: number;
  private currentSnapshot: RuntimeSnapshot;
  private mode: "demo" | "live";
  private settingsPersistence?: (settings: Settings) => void;
  private operationPersistence?: (operation: OperationRecord) => void;
  private stopped = false;
  private cancellationBindings = new Map<string, { sessionId: string; turnId: string; previousState: TurnState }>();
  private activityExporter?: (range: "current_session" | "last_24h", entries: ActivityEntry[]) => Promise<ActivityExportResult>;

  private liveBrowserAdapter: LiveGeminiBrowserAdapter;
  private liveNativeAdapter: LiveNativeAntigravityAdapter;

  private operations = new Map<string, OperationRecord>();
  private dedupeCache = new Map<string, { fingerprint: string; ack: CommandAck; timestamp: number }>();
  private inFlightMap = new Map<string, { fingerprint: string; promise: Promise<CommandAck> }>();
  private activityLog: ActivityEntry[] = [];
  private subscribers = new Set<(event: RuntimeEvent) => void>();

  constructor(
    initialScenario: ScenarioName = "first_run",
    mode: "demo" | "live" = "demo",
    options?: {
      liveBrowserAdapter?: LiveGeminiBrowserAdapter;
      liveNativeAdapter?: LiveNativeAntigravityAdapter;
      initialSettings?: Settings;
      settingsPersistence?: (settings: Settings) => void;
      operationPersistence?: (operation: OperationRecord) => void;
      activityExporter?: (range: "current_session" | "last_24h", entries: ActivityEntry[]) => Promise<ActivityExportResult>;
    }
  ) {
    this.mode = mode;
    this.settingsPersistence = options?.settingsPersistence;
    this.operationPersistence = options?.operationPersistence;
    this.activityExporter = options?.activityExporter;
    this.liveBrowserAdapter = options?.liveBrowserAdapter ?? new LiveGeminiBrowserAdapter();
    this.liveNativeAdapter = options?.liveNativeAdapter ?? new LiveNativeAntigravityAdapter();
    this.runtimeInstanceId = `inst-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.revision = 1;
    this.lastEventSequence = 0;
    this.currentSnapshot = createScenarioSnapshot(initialScenario, this.runtimeInstanceId, this.revision, this.lastEventSequence);

    if (this.mode === "live") {
      this.currentSnapshot.mode = "live";
      this.currentSnapshot.runtime = { state: "ready", version: "0.1.0" };
      this.currentSnapshot.availableModels = [];
      this.currentSnapshot.selectedModelId = null;
      for (const key of CapabilityKeySchema.options) {
        this.currentSnapshot.capabilities[key] = { state: "unverified", reasonCode: "SERVICE_UNAVAILABLE", detail: "Capability has no verified live provider." };
      }
      for (const key of ["cancelTurn", "logExport", "contextCompaction", "imageInput"] as const) {
        this.currentSnapshot.capabilities[key] = { state: "unavailable", reasonCode: "SERVICE_UNAVAILABLE", detail: "Live service is not implemented." };
      }
      this.currentSnapshot.browser = { state: "closed" };
      this.currentSnapshot.account = { state: "unknown" };
      this.currentSnapshot.integration = {
        target: "native_ide",
        state: "unverified",
        checkedAt: new Date().toISOString(),
      };
      this.currentSnapshot.capabilities.nativeRoute = {
        state: "unverified",
        reasonCode: "NATIVE_ROUTE_UNVERIFIED",
        detail: "Live native route is unverified (Gate G0 unresolved).",
      };
      this.currentSnapshot.sessions = [];
      this.currentSnapshot.lastCheck = null;
    }

    if (options?.initialSettings) this.currentSnapshot.settings = SettingsSchema.parse(options.initialSettings);
    if (this.activityExporter) this.currentSnapshot.capabilities.logExport = { state: "available" };
    this.recordActivity("info", "runtime", `Runtime started in ${this.mode} mode. Instance ID: ${this.runtimeInstanceId}`);
  }

  public getSnapshot(): RuntimeSnapshot {
    return JSON.parse(JSON.stringify(this.currentSnapshot));
  }

  public switchScenario(scenario: ScenarioName): void {
    if (this.mode === "live") {
      throw new Error("Cannot switch mock scenarios in live runtime mode.");
    }
    this.commitSnapshotChange((s) => {
      const newSnap = createScenarioSnapshot(scenario, this.runtimeInstanceId, s.revision, s.lastEventSequence);
      Object.assign(s, newSnap);
    });
  }

  private getCommandFingerprint(command: ControlCommand): string {
    return `${command.type}:${canonicalJsonStringify(command.payload)}`;
  }

  public async execute(command: ControlCommand): Promise<CommandAck> {
    if (this.stopped) throw { code: "SERVICE_UNAVAILABLE", message: "Runtime is stopped.", retryable: false } satisfies UiError;
    const { requestId } = command;
    const fingerprint = this.getCommandFingerprint(command);

    // 1. Check in-flight concurrent requests for exact same requestId
    const inFlight = this.inFlightMap.get(requestId);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) {
        return {
          requestId,
          accepted: false,
          error: {
            code: "CONFIG_CONFLICT",
            message: `Concurrent command with requestId '${requestId}' has conflicting command type or payload.`,
            retryable: false,
          },
        };
      }
      return inFlight.promise;
    }

    // 2. Check dedupe cache for previous completed request
    const cached = this.dedupeCache.get(requestId);
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        return {
          requestId,
          accepted: false,
          error: {
            code: "CONFIG_CONFLICT",
            message: `Command with requestId '${requestId}' already executed with conflicting command type or payload.`,
            retryable: false,
          },
        };
      }
      return cached.ack;
    }

    if (this.dedupeCache.size + this.inFlightMap.size >= 2048) {
      throw { code: "QUEUE_FULL", message: "Command deduplication ledger is full.", retryable: false } satisfies UiError;
    }

    // 3. Reserve inFlight BEFORE invoking processCommand or emitting side-effects [R2, A1]
    let resolveInFlight!: (ack: CommandAck) => void;
    let rejectInFlight!: (err: unknown) => void;
    const inFlightPromise = new Promise<CommandAck>((resolve, reject) => {
      resolveInFlight = resolve;
      rejectInFlight = reject;
    });

    this.inFlightMap.set(requestId, { fingerprint, promise: inFlightPromise });

    // Execute asynchronously and ensure promise is observed by leader and waiters without orphan rejections [A1]
    (async () => {
      try {
        const ack = await this.processCommand(command);
        this.dedupeCache.set(requestId, { fingerprint, ack, timestamp: Date.now() });
        resolveInFlight(ack);
      } catch (err) {
        rejectInFlight(err);
      } finally {
        this.inFlightMap.delete(requestId);
      }
    })();

    return await inFlightPromise;
  }

  private async processCommand(command: ControlCommand): Promise<CommandAck> {
    const { requestId, type, payload } = command;
    const operationId = deriveOperationId(requestId);
    const now = new Date().toISOString();

    switch (type) {
      case "browser.open": {
        if (this.mode === "live") {
          const res = await this.liveBrowserAdapter.openBrowser();
          // Live adapter returns opened: false when live driver is not connected
          if (!res.opened) {
            const error: UiError = {
              code: "BROWSER_USER_ACTION_REQUIRED",
              message: res.actionReason ?? "Live browser driver is not attached.",
              retryable: false,
              suggestedAction: "open_browser",
            };
            this.createOperation(operationId, requestId, type, "failed", "Live browser open failed.", undefined, error);
            return { requestId, accepted: false, error };
          }
          const status = await this.liveBrowserAdapter.checkStatus();
          this.commitSnapshotChange(s => {
            s.browser = { state: status.browserState, actionReason: status.actionReason, error: status.error };
            s.account = { state: status.accountState, displayLabel: status.displayLabel, checkedAt: status.checkedAt };
          });
          this.createOperation(operationId, requestId, type, "succeeded", "Browser open completed; account readiness is reported separately.");
          return { requestId, accepted: true, operationId };
        }

        // Demo mode: update snapshot and emit with consistent revision/sequence
        this.commitSnapshotChange((s) => {
          s.browser.state = "ready";
        });
        this.createOperation(operationId, requestId, type, "succeeded", "Browser window focused.");
        return { requestId, accepted: true, operationId };
      }

      case "account.check": {
        if (this.mode === "live") {
          const bStatus = await this.liveBrowserAdapter.checkStatus();
          this.commitSnapshotChange((s) => {
            s.browser = { state: bStatus.browserState, actionReason: bStatus.actionReason, error: bStatus.error };
            s.account.state = bStatus.accountState;
            s.account.displayLabel = bStatus.displayLabel;
            s.account.checkedAt = bStatus.checkedAt;
          });
          if (bStatus.accountState !== "signed_in") {
            const error: UiError = {
              code: "LOGIN_REQUIRED",
              message: "Account is not signed in on the live browser profile.",
              retryable: false,
              suggestedAction: "open_browser",
            };
            this.createOperation(
              operationId,
              requestId,
              type,
              "failed",
              `Account state: ${bStatus.accountState}`,
              undefined,
              error
            );
            return { requestId, accepted: false, error };
          }
          this.createOperation(
            operationId,
            requestId,
            type,
            "succeeded",
            `Account state: ${bStatus.accountState}`
          );
          return { requestId, accepted: true, operationId };
        }

        // Demo mode: simulate account check
        this.commitSnapshotChange((s) => {
          s.account.state = "signed_in";
          s.account.displayLabel = "Demo User (simulated)";
          s.account.checkedAt = now;
        });
        this.createOperation(operationId, requestId, type, "succeeded", "Account session verified (simulated).");
        return { requestId, accepted: true, operationId };
      }

      case "runtime.check": {
        if (this.mode === "live") {
          const nativeStatus = await this.liveNativeAdapter.checkStatus();
          const browserStatus = await this.liveBrowserAdapter.checkStatus();
          const scope = (payload as { scope?: string }).scope ?? "quick";

          const liveChecks: CheckResult[] = [
            {
              key: "host",
              status: nativeStatus.hostDetected === undefined ? "not_run" : nativeStatus.hostDetected ? "passed" : "failed",
              summary: nativeStatus.hostDetected === undefined ? "Host detection has not run" : nativeStatus.hostDetected ? "Host detected by adapter" : "Host not detected",
              checkedAt: now,
            },
            {
              key: "route",
              status: nativeStatus.state === "connected" ? "passed" : "failed",
              summary: nativeStatus.capability.detail ?? "Native route unverified",
              checkedAt: now,
            },
            {
              key: "browser",
              status: browserStatus.browserState === "ready" ? "passed" : "failed",
              summary: `Browser state: ${browserStatus.browserState}`,
              checkedAt: now,
            },
            {
              key: "account",
              status: browserStatus.accountState === "signed_in" ? "passed" : "failed",
              summary: `Account state: ${browserStatus.accountState}`,
              checkedAt: now,
            },
            {
              key: "model",
              status: "not_run",
              summary: "Live model binding has not been verified",
              checkedAt: now,
            },
            {
              key: "tools",
              status: "not_run",
              summary: "Native tool executor bridge unverified",
              checkedAt: now,
            },
          ];

          this.commitSnapshotChange((s) => {
            s.browser = { state: browserStatus.browserState, actionReason: browserStatus.actionReason, error: browserStatus.error };
            s.account = { state: browserStatus.accountState, displayLabel: browserStatus.displayLabel, checkedAt: browserStatus.checkedAt };
            s.integration = { target: "native_ide", state: nativeStatus.state, hostVersion: nativeStatus.hostVersion, checkedAt: nativeStatus.checkedAt, error: nativeStatus.error };
            s.capabilities.nativeRoute = nativeStatus.capability;
            s.lastCheck = {
              operationId,
              at: now,
              checks: liveChecks,
            };
          });

          const allPassed = liveChecks.every((c) => c.status === "passed");
          if (!allPassed && (scope === "end_to_end" || scope === "native_bridge")) {
            const error: UiError = {
              code: "NATIVE_ROUTE_UNVERIFIED",
              message: "Live diagnostic check failed: native route or browser session is not verified.",
              retryable: false,
              suggestedAction: "review_integration",
            };
            this.createOperation(operationId, requestId, type, "failed", "Diagnostic check failed.", undefined, error);
            return { requestId, accepted: false, error };
          }

          this.createOperation(operationId, requestId, type, "succeeded", "Diagnostic check completed.", {
            checks: liveChecks,
          });
          return { requestId, accepted: true, operationId };
        }

        // Demo mode
        this.createOperation(operationId, requestId, type, "succeeded", "Diagnostic check completed.", {
          checks: this.currentSnapshot.lastCheck?.checks ?? [],
        });
        return { requestId, accepted: true, operationId };
      }

      case "integration.preview": {
        if (this.mode === "live") {
          const error: UiError = {
            code: "NATIVE_ROUTE_UNVERIFIED",
            message: "Cannot generate integration preview in live mode: native route is unverified.",
            retryable: false,
            suggestedAction: "review_integration",
          };
          this.createOperation(operationId, requestId, type, "failed", "Preview unavailable in live mode.", undefined, error);
          return { requestId, accepted: false, error };
        }

        const previewResult = {
          previewId: `prev-${Date.now()}`,
          action: (payload as { action: string }).action,
          summary: `Integration ${(payload as { action: string }).action} plan prepared (synthetic preview).`,
          canApply: true,
        };
        this.createOperation(operationId, requestId, type, "succeeded", "Preview ready.", previewResult);
        return { requestId, accepted: true, operationId };
      }

      case "integration.apply": {
        // Enforce Gate G0 condition: in live mode or if capability is unverified, reject!
        if (this.mode === "live" || this.currentSnapshot.capabilities.nativeRoute?.state === "unverified") {
          const error: UiError = {
            code: "NATIVE_ROUTE_UNVERIFIED",
            message: "Cannot apply integration: native inference route is unverified (Gate G0 unresolved).",
            retryable: false,
            suggestedAction: "review_integration",
          };
          this.createOperation(operationId, requestId, type, "failed", "Integration apply blocked.", undefined, error);
          return { requestId, accepted: false, error };
        }

        this.commitSnapshotChange((s) => {
          s.integration.state = "connected";
        });
        this.createOperation(operationId, requestId, type, "succeeded", "Integration applied (demo only).");
        return { requestId, accepted: true, operationId };
      }

      case "model.select": {
        if (this.mode === "live") {
          const error: UiError = { code: "MODEL_UNAVAILABLE", message: "Live model selection has no verified provider.", retryable: false };
          this.createOperation(operationId, requestId, type, "failed", "Model selection unavailable.", undefined, error);
          return { requestId, accepted: false, error };
        }
        if (this.currentSnapshot.sessions.some(s => s.activeTurn && !isTerminalTurnState(s.activeTurn.state))) {
          const error: UiError = { code: "BUSY", message: "Cannot switch model during an active turn.", retryable: false };
          this.createOperation(operationId, requestId, type, "failed", "Model selection blocked by active turn.", undefined, error);
          return { requestId, accepted: false, error };
        }
        const { modelId } = payload as { modelId: string };
        const found = this.currentSnapshot.availableModels.find((m) => m.id === modelId);
        if (!found || found.availability !== "available") {
          const error: UiError = {
            code: "MODEL_UNAVAILABLE",
            message: `Model '${modelId}' is not available.`,
            retryable: false,
          };
          this.createOperation(operationId, requestId, type, "failed", "Model select failed.", undefined, error);
          return { requestId, accepted: false, error };
        }
        this.commitSnapshotChange((s) => {
          s.selectedModelId = modelId;
        });
        this.createOperation(operationId, requestId, type, "succeeded", `Selected model ${modelId}.`);
        return { requestId, accepted: true, operationId };
      }

      case "turn.cancel": {
        const { sessionId, turnId } = payload as { sessionId: string; turnId: string };
        const session = this.currentSnapshot.sessions.find((s) => s.id === sessionId);
        if (!session) {
          const error: UiError = {
            code: "SESSION_NOT_FOUND",
            message: `Session '${sessionId}' not found. Cannot cancel turn.`,
            retryable: false,
          };
          this.createOperation(operationId, requestId, type, "failed", "Cancel rejected: session not found.", undefined, error);
          return { requestId, accepted: false, error };
        }

        if (!session.activeTurn || session.activeTurn.id !== turnId) {
          const error: UiError = {
            code: "TURN_NOT_FOUND",
            message: `Turn '${turnId}' not found or not active in session '${sessionId}'.`,
            retryable: false,
          };
          this.createOperation(operationId, requestId, type, "failed", "Cancel rejected: turn not active.", undefined, error);
          return { requestId, accepted: false, error };
        }

        // R4: Terminal turns are immutable
        if (isTerminalTurnState(session.activeTurn.state)) {
          const error: UiError = {
            code: "TURN_TERMINAL",
            message: `Cannot cancel turn '${turnId}': turn is already in terminal state '${session.activeTurn.state}'.`,
            retryable: false,
          };
          this.createOperation(operationId, requestId, type, "failed", "Cancel rejected: turn already terminal.", undefined, error);
          return { requestId, accepted: false, error };
        }

        if (!session.activeTurn.canCancel) {
          const error: UiError = {
            code: "TURN_NOT_CANCELLABLE",
            message: `Turn '${turnId}' cannot be cancelled.`,
            retryable: false,
          };
          this.createOperation(operationId, requestId, type, "failed", "Cancel rejected: turn not cancellable.", undefined, error);
          return { requestId, accepted: false, error };
        }

        // Bind acknowledgement to this exact session/turn; only the host confirms it.
        this.cancellationBindings.set(operationId, { sessionId, turnId, previousState: session.activeTurn.state });
        session.activeTurn.state = "cancel_requested";
        session.activeTurn.canCancel = false;
        session.activeTurn.phaseLabel = "Cancellation requested; processing cancel...";
        session.activeTurn.updatedAt = now;
        this.emitSessionUpdated(session);

        this.createOperation(operationId, requestId, type, "running", "Cancel requested.");

        return { requestId, accepted: true, operationId };
      }

      case "settings.update": {
        const { expectedRevision, patch } = payload as { expectedRevision: number; patch: Record<string, unknown> };
        if (expectedRevision !== this.currentSnapshot.settings.revision) {
          const error: UiError = {
            code: "CONFIG_CONFLICT",
            message: `Settings revision conflict: expected revision ${expectedRevision}, but current revision is ${this.currentSnapshot.settings.revision}.`,
            retryable: false,
          };
          this.createOperation(operationId, requestId, type, "failed", "Settings update rejected.", undefined, error);
          return { requestId, accepted: false, error };
        }

        const next = SettingsSchema.parse({ ...this.currentSnapshot.settings, ...patch, revision: this.currentSnapshot.settings.revision + 1 });
        this.settingsPersistence?.(next); // commit before reporting success or changing the snapshot
        this.commitSnapshotChange(s => { s.settings = next; });
        this.createOperation(operationId, requestId, type, "succeeded", "Settings updated.");
        return { requestId, accepted: true, operationId };
      }

      case "activity.export": {
        if (this.activityExporter) {
          const range = payload.range;
          const activeSessionIds = new Set(this.currentSnapshot.sessions.map(s => s.id));
          const cutoff = Date.now() - 24 * 60 * 60 * 1000;
          const entries = this.activityLog.filter(entry => range === "last_24h" ? Date.parse(entry.at) >= cutoff : !!entry.sessionId && activeSessionIds.has(entry.sessionId));
          const result = await this.activityExporter(range, structuredClone(entries));
          this.createOperation(operationId, requestId, type, "succeeded", "Activity metadata exported.", result);
          return { requestId, accepted: true, operationId };
        }
        if (this.mode === "live") {
          const error: UiError = {
            code: "SERVICE_UNAVAILABLE",
            message: "Live activity export service is not available (no active exporter).",
            retryable: false,
          };
          this.createOperation(operationId, requestId, type, "failed", "Activity export failed.", undefined, error);
          return { requestId, accepted: false, error };
        }

        const exportResult = {
          exportedCount: this.activityLog.length,
          sanitized: true,
          redacted: true,
        };
        this.createOperation(operationId, requestId, type, "succeeded", "Activity log exported.", exportResult);
        return { requestId, accepted: true, operationId };
      }
    }
  }

  private commitSnapshotChange(mutator: (snapshot: RuntimeSnapshot) => void): RuntimeSnapshot {
    if (this.stopped) throw { code: "STALE_AUTHORITY", message: "Runtime authority was retired.", retryable: false } satisfies UiError;
    mutator(this.currentSnapshot);
    this.revision += 1;
    this.currentSnapshot.revision = this.revision;
    this.currentSnapshot.observedAt = new Date().toISOString();
    this.lastEventSequence += 1;
    this.currentSnapshot.lastEventSequence = this.lastEventSequence;

    const snapshotCopy = this.getSnapshot();
    this.emitEventWithSequence(this.lastEventSequence, "snapshot.updated", { snapshot: snapshotCopy });
    return snapshotCopy;
  }

  public restoreSettings(settings: Settings): void {
    this.commitSnapshotChange(s => { s.settings = SettingsSchema.parse(settings); });
  }

  public markStopped(): void {
    if (this.stopped) return;
    this.commitSnapshotChange(s => { s.runtime.state = "stopped"; });
    this.stopped = true;
    for (const operation of this.operations.values()) if (!isTerminalOperationState(operation.state)) {
      this.invalidateOperation({ id: operation.id, requestId: operation.requestId, type: operation.type, state: "outcome_unknown",
        error: { code: "OUTCOME_UNKNOWN", message: "Runtime stopped before the result was confirmed.", retryable: false }, updatedAt: new Date().toISOString() });
    }
    this.cancellationBindings.clear();
    this.emitEvent("runtime.disconnected", { reason: "Runtime stopped", at: new Date().toISOString() });
  }

  private createOperation(
    id: string,
    requestId: string,
    type: ControlCommand["type"],
    state: OperationRecord["state"],
    progressLabel: string,
    result?: OperationRecord["result"],
    error?: UiError
  ): OperationRecord {
    const existing = this.operations.get(id);
    if (existing && isTerminalOperationState(existing.state)) {
      return existing; // Terminal operations are strictly immutable
    }
    const op: OperationRecord = {
      id,
      requestId,
      type,
      state,
      progressLabel,
      result,
      error,
      updatedAt: new Date().toISOString(),
    };
    return this.publishOperation(op);
  }

  public publishOperation(operation: OperationRecord): OperationRecord {
    const op = OperationRecordSchema.parse(operation);
    const previous = this.operations.get(op.id);
    if (previous && isTerminalOperationState(previous.state)) return structuredClone(previous);
    if (this.stopped) throw { code: "STALE_AUTHORITY", message: "Runtime authority was retired.", retryable: false } satisfies UiError;
    this.operationPersistence?.(structuredClone(op)); // commit before publication
    return this.storeOperation(op);
  }

  public invalidateOperation(operation: OperationRecord): void {
    const previous = this.operations.get(operation.id);
    if (!previous || !isTerminalOperationState(previous.state)) this.storeOperation(OperationRecordSchema.parse(operation));
  }

  private storeOperation(op: OperationRecord): OperationRecord {
    this.operations.set(op.id, op);
    this.lastEventSequence += 1;
    this.currentSnapshot.lastEventSequence = this.lastEventSequence;
    this.emitEventWithSequence(this.lastEventSequence, "operation.updated", { operation: op });
    return op;
  }

  private finishCancellation(sessionId: string, turnId: string, error?: UiError): void {
    const session = this.currentSnapshot.sessions.find(s => s.id === sessionId);
    const turn = session?.activeTurn;
    if (this.stopped || !session || !turn || turn.id !== turnId || turn.state !== "cancel_requested" || isTerminalTurnState(turn.state)) return;
    const bindings = [...this.cancellationBindings].filter(([, bound]) => bound.sessionId === sessionId && bound.turnId === turnId);
    for (const [id, bound] of bindings) {
      const op = this.operations.get(id);
      if (!op || isTerminalOperationState(op.state)) continue;
      this.createOperation(id, op.requestId, "turn.cancel", error ? "failed" : "succeeded", error ? "Turn cancellation failed." : "Turn cancellation confirmed.", undefined, error);
      this.cancellationBindings.delete(id);
      turn.state = error ? bound.previousState : "cancel_confirmed";
      turn.canCancel = !!error;
      turn.updatedAt = new Date().toISOString();
      turn.phaseLabel = error ? "Turn cancellation failed." : "Turn cancellation confirmed.";
      if (error) turn.error = error;
      else { delete turn.error; turn.completedAt = turn.updatedAt; }
    }
    this.emitSessionUpdated(session);
  }

  public confirmTurnCancellation(sessionId: string, turnId: string): void { this.finishCancellation(sessionId, turnId); }
  public failTurnCancellation(sessionId: string, turnId: string, error: UiError): void { this.finishCancellation(sessionId, turnId, error); }

  private emitSessionUpdated(session: SessionSummary): void {
    this.lastEventSequence += 1;
    this.currentSnapshot.lastEventSequence = this.lastEventSequence;
    this.emitEventWithSequence(this.lastEventSequence, "session.updated", { session });
  }

  public async getOperation(operationId: string): Promise<OperationRecord> {
    const op = this.operations.get(operationId);
    if (!op) {
      throw {
        code: "HOST_NOT_FOUND",
        message: `Operation with ID '${operationId}' not found.`,
        retryable: false,
      };
    }
    return JSON.parse(JSON.stringify(op));
  }

  public async getSessions(cursor?: string): Promise<Page<SessionSummary>> {
    return {
      items: JSON.parse(JSON.stringify(this.currentSnapshot.sessions)),
      nextCursor: undefined,
    };
  }

  public async getActivity(query: ActivityQuery): Promise<Page<ActivityEntry>> {
    let items = [...this.activityLog];
    if (query.severity) {
      items = items.filter((i) => i.severity === query.severity);
    }
    const limit = query.limit ?? 50;
    return {
      items: items.slice(0, limit),
      nextCursor: undefined,
    };
  }

  public subscribe(onEvent: (event: RuntimeEvent) => void): () => void {
    this.subscribers.add(onEvent);
    return () => {
      this.subscribers.delete(onEvent);
    };
  }

  private emitEventWithSequence(sequence: number, type: any, payload: any): RuntimeEvent {
    const event = {
      schemaVersion: SCHEMA_VERSION,
      runtimeInstanceId: this.runtimeInstanceId,
      sequence,
      id: `evt-${sequence}`,
      occurredAt: new Date().toISOString(),
      type,
      payload,
    } as RuntimeEvent;

    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        // Ignore subscriber error
      }
    }
    return event;
  }

  public emitEvent(type: "snapshot.updated" | "operation.updated" | "session.updated" | "activity.appended" | "runtime.disconnected", payload: any): RuntimeEvent {
    this.lastEventSequence += 1;
    this.currentSnapshot.lastEventSequence = this.lastEventSequence;
    return this.emitEventWithSequence(this.lastEventSequence, type, payload);
  }

  public recordActivity(severity: "info" | "warning" | "error", category: string, summary: string): void {
    const entry: ActivityEntry = {
      id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      at: new Date().toISOString(),
      severity,
      category,
      summary,
    };
    this.activityLog.push(entry);
    this.lastEventSequence += 1;
    this.currentSnapshot.lastEventSequence = this.lastEventSequence;
    this.emitEventWithSequence(this.lastEventSequence, "activity.appended", { entry });
  }

  // --- Diagnostic simulation methods for contract tests ---

  public simulateRestart(): string {
    this.runtimeInstanceId = `inst-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.lastEventSequence = 0;
    this.currentSnapshot.runtimeInstanceId = this.runtimeInstanceId;
    this.currentSnapshot.lastEventSequence = 0;
    this.emitEvent("snapshot.updated", { snapshot: this.getSnapshot() });
    return this.runtimeInstanceId;
  }

  public simulateEventGap(): void {
    this.lastEventSequence += 5;
    this.commitSnapshotChange(() => {});
  }
}
