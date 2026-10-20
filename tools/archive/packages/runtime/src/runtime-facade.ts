import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import {
  type LauncherClient, type RuntimeSnapshot, type ControlCommand, type CommandAck,
  type OperationRecord, type SessionSummary, type ActivityQuery, type ActivityEntry,
  type Page, type RuntimeEvent, type UiError, ControlCommandSchema, CommandAckSchema,
  OperationRecordSchema, SettingsSchema, sanitizeDiagnostics, safeUiError, isTerminalOperationState,
} from "@antigravity-gemini-web/contracts";
import { LiveGeminiBrowserAdapter, type GeminiBrowserAdapter, type PromptTurnResponse } from "@antigravity-gemini-web/gemini-browser";
import { FakeRuntimeEngine, deriveOperationId } from "./fake-runtime.js";
import { InProcessLauncherClient } from "./in-process-client.js";
import { ContextManager, canonicalWorkspaceId } from "./context-manager.js";
import { RecoveryJournal } from "./recovery-journal.js";
import { SessionCoordinator, type QueuedTurnItem } from "./session-coordinator.js";
import { getStoragePaths } from "./paths.js";
import { canonicalJson } from "./fingerprinting.js";
import { LocalStore, atomicWriteFile } from "./local-store.js";
import { OwnedBrowserAdapter } from "./owned-browser.js";

const ReceiptSchema = z.object({
  requestId: z.string().min(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(["pending", "complete", "unknown"]), ack: CommandAckSchema.optional(),
  operation: OperationRecordSchema.optional(),
}).strict();
type Receipt = z.infer<typeof ReceiptSchema>;

export interface RuntimeFacadeOptions {
  mode?: "demo" | "live"; appDataDir?: string; journalDir?: string;
  liveBrowserAdapter?: LiveGeminiBrowserAdapter;
  chooseExportDestination?: () => Promise<string | null>;
  fixtureTurnDriver?: GeminiBrowserAdapter;
}

export class RuntimeFacade implements LauncherClient {
  public readonly mode: "demo" | "live";
  public readonly appDataDir: string;
  public readonly runtimeInstanceId: string;
  public readonly engine: FakeRuntimeEngine;
  public readonly client: InProcessLauncherClient;
  public readonly contextManager = new ContextManager();
  public readonly journal: RecoveryJournal;
  private readonly browser: LiveGeminiBrowserAdapter;
  private readonly settingsStore;
  private readonly receiptStore;
  private receipts = new Map<string, Receipt>();
  private inFlight = new Map<string, { fingerprint: string; promise: Promise<CommandAck> }>();
  private coordinators = new Map<string, SessionCoordinator>();
  private fixtureTurns = new Map<string, Promise<PromptTurnResponse>>();
  private fixtureDriver?: GeminiBrowserAdapter;
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private started = false;
  private stopped = false;
  private epoch = 0;
  private durabilityFault: UiError | undefined;

  constructor(private readonly options: RuntimeFacadeOptions = {}) {
    this.mode = options.mode ?? "live";
    const storage = getStoragePaths(this.mode, undefined, crypto.randomUUID());
    this.appDataDir = path.resolve(options.appDataDir ?? storage.appDataDir);
    this.settingsStore = new LocalStore(path.join(this.appDataDir, "settings.json"), SettingsSchema.strict());
    this.receiptStore = new LocalStore(path.join(this.appDataDir, "operations.json"), z.array(ReceiptSchema).max(2048));
    this.journal = new RecoveryJournal(path.join(options.journalDir ?? path.join(this.appDataDir, "journals"), "recovery.journal.jsonl"));
    this.browser = options.liveBrowserAdapter ?? new OwnedBrowserAdapter({ userDataDir: path.join(this.appDataDir, "browser_profile"), headless: false, debugPort: 9223 });
    this.fixtureDriver = options.fixtureTurnDriver;
    this.engine = new FakeRuntimeEngine("first_run", this.mode, {
      liveBrowserAdapter: this.browser,
      settingsPersistence: next => this.settingsStore.save(next),
      operationPersistence: operation => this.commitOperation(operation),
      activityExporter: options.chooseExportDestination ? async (_range, entries) => {
        const epoch = this.epoch;
        const destination = await options.chooseExportDestination!();
        if (this.stopped || epoch !== this.epoch) throw { code: "SERVICE_UNAVAILABLE", message: "Export was retired by shutdown.", retryable: false } satisfies UiError;
        if (!destination) throw { code: "CANCELLED", message: "Export cancelled.", retryable: false } satisfies UiError;
        if (!path.isAbsolute(destination)) throw { code: "INVALID_ARGUMENT", message: "Export destination must be absolute.", retryable: false } satisfies UiError;
        const safeEntries = sanitizeDiagnostics(entries);
        atomicWriteFile(destination, JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), entries: safeEntries }, null, 2));
        return { exportedCount: safeEntries.length, sanitized: true, redacted: true };
      } : undefined,
    });
    this.client = new InProcessLauncherClient(this.engine);
    this.runtimeInstanceId = this.engine.getSnapshot().runtimeInstanceId;
  }

  public start(): Promise<void> {
    if (this.stopped) return Promise.reject({ code: "SERVICE_UNAVAILABLE", message: "Runtime was stopped.", retryable: false } satisfies UiError);
    if (this.started) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    const pending = Promise.resolve().then(() => {
      const report = this.journal.loadAndReconcile(this.runtimeInstanceId);
      if (report.replayBlocked) throw { code: "OUTCOME_UNKNOWN", message: "Recovery evidence is corrupt.", retryable: false } satisfies UiError;
      const settings = this.settingsStore.load(this.engine.getSnapshot().settings);
      const receipts = this.receiptStore.load([]);
      let reconciled = false;
      for (const receipt of receipts) {
        if (this.receipts.has(receipt.requestId)) throw { code: "CONTRACT_MISMATCH", message: "Duplicate durable request identity.", retryable: false } satisfies UiError;
        if (receipt.phase === "pending") {
          receipt.phase = "unknown";
          receipt.ack ??= { requestId: receipt.requestId, accepted: false, error: { code: "OUTCOME_UNKNOWN", message: "Previous command requires reconciliation.", retryable: false } };
          if (receipt.operation && !isTerminalOperationState(receipt.operation.state)) {
            receipt.operation.state = "outcome_unknown";
            receipt.operation.error = { code: "OUTCOME_UNKNOWN", message: "Previous command requires reconciliation.", retryable: false };
            receipt.operation.updatedAt = new Date().toISOString();
          }
          reconciled = true;
        }
        this.receipts.set(receipt.requestId, receipt);
      }
      if (reconciled) this.saveReceipts();
      this.engine.restoreSettings(settings);
      this.started = true;
    });
    this.startPromise = pending;
    pending.then(() => { this.startPromise = undefined; }, () => { this.startPromise = undefined; this.receipts.clear(); });
    return pending;
  }

  private saveReceipts(): void { this.receiptStore.save([...this.receipts.values()]); }
  private async ready(): Promise<void> {
    if (this.stopped) throw { code: "SERVICE_UNAVAILABLE", message: "Runtime has stopped.", retryable: false } satisfies UiError;
    await this.start();
    if (this.durabilityFault) throw this.durabilityFault;
  }

  public stop(timeoutMs = 5000): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5000) return Promise.reject(new RangeError("Invalid cleanup budget."));
    this.stopped = true; this.epoch++;
    const deadline = Date.now() + timeoutMs;
    const pending = (async () => {
      let failed = false;
      if (this.startPromise) { try { await this.startPromise; } catch { failed = true; } }
      for (const coordinator of this.coordinators.values()) {
        try { coordinator.handleDisconnection("Runtime shutdown"); } catch { failed = true; }
      }
      this.coordinators.clear();
      for (const receipt of this.receipts.values()) if (receipt.phase === "pending") {
        receipt.phase = "unknown";
        receipt.ack ??= { requestId: receipt.requestId, accepted: false, error: { code: "OUTCOME_UNKNOWN", message: "Command interrupted by shutdown.", retryable: false } };
        if (receipt.operation && !isTerminalOperationState(receipt.operation.state)) {
          receipt.operation.state = "outcome_unknown";
          receipt.operation.error = { code: "OUTCOME_UNKNOWN", message: "Command interrupted by shutdown.", retryable: false };
          receipt.operation.updatedAt = new Date().toISOString();
        }
      }
      if (this.started) { try { this.saveReceipts(); } catch { failed = true; } }
      try { this.engine.markStopped(); } catch { failed = true; }
      // Cleanup still runs if coordinator/journal persistence failed.
      for (const adapter of new Set([this.browser, ...(this.fixtureDriver ? [this.fixtureDriver] : [])])) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            adapter.cleanup(),
            new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("cleanup timeout")), Math.max(1, deadline - Date.now())); }),
          ]);
        } catch { failed = true; }
        finally { if (timer !== undefined) clearTimeout(timer); }
      }
      this.started = false;
      if (failed) throw { code: "SERVICE_UNAVAILABLE", message: "Runtime cleanup could not be confirmed.", retryable: false } satisfies UiError;
    })();
    this.stopPromise = pending;
    pending.then(() => {}, () => { this.stopPromise = undefined; });
    pending.catch(() => {}); // observed even if an app shutdown callback loses its waiter
    return pending;
  }

  public getOrCreateCoordinator(workspaceId: string, sessionId: string): SessionCoordinator {
    if (this.stopped || !this.started) throw { code: "SERVICE_UNAVAILABLE", message: "Runtime is not ready.", retryable: false } satisfies UiError;
    const canonical = canonicalWorkspaceId(workspaceId);
    const key = JSON.stringify([canonical, sessionId]);
    let coordinator = this.coordinators.get(key);
    if (!coordinator) {
      if (this.coordinators.size >= 64) throw { code: "QUEUE_FULL", message: "Session registry is full.", retryable: false } satisfies UiError;
      coordinator = new SessionCoordinator({ workspaceId: canonical, sessionId, runtimeInstanceId: this.runtimeInstanceId, journal: this.journal, contextManager: this.contextManager });
      this.coordinators.set(key, coordinator);
    }
    return coordinator;
  }

  /** Host-only controlled integration harness. This is never exposed by LauncherClient/preload. */
  public async runFixtureTurn(item: QueuedTurnItem): Promise<PromptTurnResponse> {
    await this.ready();
    if (this.mode !== "demo" || !this.fixtureDriver) throw { code: "NATIVE_ROUTE_UNVERIFIED", message: "No verified host turn driver.", retryable: false } satisfies UiError;
    const coordinator = this.getOrCreateCoordinator(item.workspaceId, item.sessionId);
    coordinator.enqueue(item);
    const key = JSON.stringify([coordinator.workspaceId, item.sessionId, item.turnId]);
    const existing = this.fixtureTurns.get(key);
    if (existing) return structuredClone(await existing);
    if (coordinator.getTurnState(item.turnId) !== "queued") throw { code: "OUTCOME_UNKNOWN", message: "Recovered turn cannot be resent.", retryable: false } satisfies UiError;
    const epoch = coordinator.currentEpoch;
    const pending = Promise.resolve().then(async () => {
      const turn = coordinator.nextForExecution();
      if (!turn || turn.turnId !== item.turnId) throw { code: "BUSY", message: "Conversation is already busy.", retryable: false } satisfies UiError;
      coordinator.transitionActiveTurn(item.turnId, "submitting", epoch);
      const receipt = await this.fixtureDriver!.submitPrompt(item.turnId, turn.prompt);
      if (receipt.status !== "accepted") {
        coordinator.transitionActiveTurn(item.turnId, "failed", epoch);
        throw { code: "SERVICE_UNAVAILABLE", message: "Fixture submission rejected.", retryable: false } satisfies UiError;
      }
      coordinator.transitionActiveTurn(item.turnId, "accepted", epoch);
      coordinator.transitionActiveTurn(item.turnId, "streaming", epoch);
      const response = await this.fixtureDriver!.pollResponse(item.turnId);
      coordinator.transitionActiveTurn(item.turnId, response.status === "completed" ? "completed" : response.status === "cancelled" ? "cancelled" : "failed", epoch);
      return response;
    });
    this.fixtureTurns.set(key, pending);
    pending.catch(() => {}); // preserve a failed tombstone; never automatically resend
    return structuredClone(await pending);
  }

  public async getSnapshot(): Promise<RuntimeSnapshot> {
    if (!this.stopped) await this.ready();
    return this.client.getSnapshot();
  }

  private commitOperation(raw: OperationRecord): void {
    const operation = sanitizeDiagnostics(OperationRecordSchema.parse(raw));
    const receipt = this.receipts.get(operation.requestId);
    if (!receipt) return; // host-only engine fixture; not a launcher command
    if (receipt.operation && isTerminalOperationState(receipt.operation.state)) {
      if (receipt.operation.state !== operation.state) throw { code: "STALE_AUTHORITY", message: "Operation authority was retired.", retryable: false } satisfies UiError;
      return;
    }
    if (this.durabilityFault) throw this.durabilityFault;
    const previous = structuredClone(receipt);
    receipt.operation = operation;
    if (isTerminalOperationState(operation.state)) receipt.phase = operation.state === "outcome_unknown" ? "unknown" : "complete";
    try { this.saveReceipts(); }
    catch {
      Object.assign(receipt, previous);
      this.durabilityFault = { code: "SERVICE_UNAVAILABLE", message: "Operation persistence failed; further mutations are blocked.", retryable: false };
      throw this.durabilityFault;
    }
  }

  public async execute(raw: ControlCommand): Promise<CommandAck> {
    const parsed = ControlCommandSchema.safeParse(raw);
    if (!parsed.success) throw { code: "CONTRACT_MISMATCH", message: "Invalid command.", retryable: false } satisfies UiError;
    const command = parsed.data;
    if (command.requestId.length > 128) throw { code: "CONTRACT_MISMATCH", message: "Request identity is too large.", retryable: false } satisfies UiError;
    if (["integration.apply", "integration.preview"].includes(command.type) || (command.type === "runtime.check" && command.payload.scope === "end_to_end")) {
      throw { code: "NATIVE_ROUTE_UNVERIFIED", message: "Native inference route is unverified.", retryable: false } satisfies UiError;
    }
    if (command.type === "model.select") throw { code: "MODEL_UNAVAILABLE", message: "No verified model provider.", retryable: false } satisfies UiError;
    await this.ready();
    const fingerprint = RecoveryJournal.hashPayload(canonicalJson(command));
    const concurrent = this.inFlight.get(command.requestId);
    const recorded = this.receipts.get(command.requestId);
    if ((concurrent && concurrent.fingerprint !== fingerprint) || (recorded && recorded.fingerprint !== fingerprint)) {
      throw { code: "CONFIG_CONFLICT", message: "Request has a conflicting command payload.", retryable: false } satisfies UiError;
    }
    if (concurrent) return concurrent.promise;
    if (recorded) return structuredClone(recorded.ack ?? { requestId: command.requestId, accepted: false, error: { code: "OUTCOME_UNKNOWN", message: "Previous request cannot be replayed.", retryable: false } });
    if (this.receipts.size + [...this.inFlight.keys()].filter(id => !this.receipts.has(id)).length >= 2048) throw { code: "QUEUE_FULL", message: "Command receipt ledger is full.", retryable: false } satisfies UiError;
    const epoch = this.epoch;
    // Preference writes are synchronous. Browser/check/export/cancel jobs acknowledge
    // their durable operation before waiting for the external result.
    const deferred = command.type !== "settings.update";
    const pending = Promise.resolve().then(async () => {
      if (epoch !== this.epoch || this.stopped) return { requestId: command.requestId, accepted: false, error: safeUiError({ code: "SERVICE_UNAVAILABLE" }) } satisfies CommandAck;
      const ack: CommandAck = { requestId: command.requestId, accepted: true, operationId: deriveOperationId(command.requestId) };
      const receipt: Receipt = { requestId: command.requestId, fingerprint, phase: "pending", ack,
        operation: { id: ack.operationId, requestId: command.requestId, type: command.type, state: "queued", updatedAt: new Date().toISOString() } };
      this.receipts.set(command.requestId, receipt);
      try { this.saveReceipts(); }
      catch {
        this.receipts.delete(command.requestId);
        throw { code: "SERVICE_UNAVAILABLE", message: "Durable receipt reservation failed.", retryable: false } satisfies UiError;
      }
      this.engine.publishOperation(receipt.operation!);
      const run = async (): Promise<CommandAck> => {
        try {
          if (epoch !== this.epoch || this.stopped) return structuredClone(receipt.ack!);
          this.engine.publishOperation({ ...receipt.operation!, state: "running", updatedAt: new Date().toISOString() });
          const result = await this.client.execute(command);
          if (epoch !== this.epoch || this.stopped) return structuredClone(receipt.ack!);
          if (!deferred) {
            receipt.ack = structuredClone(result);
            this.saveReceipts();
          }
          return structuredClone(deferred ? ack : result);
        } catch (error) {
          if (epoch !== this.epoch || this.stopped) return structuredClone(receipt.ack!);
          if (receipt.operation && isTerminalOperationState(receipt.operation.state)) return structuredClone(receipt.ack!);
          const failure = safeUiError(error);
          const knownRejection = ["CANCELLED", "CONFIG_CONFLICT", "CONTRACT_MISMATCH", "CONTEXT_TOO_LARGE", "STALE_AUTHORITY"].includes(failure.code);
          const operation: OperationRecord = { id: ack.operationId, requestId: command.requestId, type: command.type,
            state: knownRejection && !this.durabilityFault ? "failed" : "outcome_unknown",
            error: knownRejection && !this.durabilityFault ? failure : { code: "OUTCOME_UNKNOWN", message: "Command outcome requires reconciliation; it will not be replayed.", retryable: false },
            updatedAt: new Date().toISOString() };
          if (!deferred) receipt.ack = { requestId: command.requestId, accepted: false, error: operation.error! };
          try { this.engine.publishOperation(operation); }
          catch {
            // A failed commit cannot be reported as success. Keep a tombstone in memory;
            // the durable pending receipt is reconciled to unknown after restart.
            receipt.operation = operation; receipt.phase = "unknown";
            this.engine.invalidateOperation(operation);
          }
          return structuredClone(deferred ? ack : receipt.ack!);
        }
      };
      if (deferred) {
        void run().catch(() => { this.durabilityFault = { code: "SERVICE_UNAVAILABLE", message: "Operation ownership failed.", retryable: false }; });
        return structuredClone(ack);
      }
      return run();
    });
    this.inFlight.set(command.requestId, { fingerprint, promise: pending });
    pending.then(() => this.inFlight.delete(command.requestId), () => this.inFlight.delete(command.requestId));
    return pending;
  }

  public async getOperation(operationId: string): Promise<OperationRecord> {
    if (!this.stopped) await this.start(); // observation remains possible after a write fault
    for (const receipt of this.receipts.values()) if (receipt.operation?.id === operationId) return structuredClone(receipt.operation);
    return sanitizeDiagnostics(await this.client.getOperation(operationId));
  }
  public async getSessions(cursor?: string): Promise<Page<SessionSummary>> { await this.ready(); return this.client.getSessions(cursor); }
  public async getActivity(query: ActivityQuery): Promise<Page<ActivityEntry>> { await this.ready(); return sanitizeDiagnostics(await this.client.getActivity(query)); }
  public subscribe(listener: (event: RuntimeEvent) => void): () => void { return this.client.subscribe(listener); }
}
