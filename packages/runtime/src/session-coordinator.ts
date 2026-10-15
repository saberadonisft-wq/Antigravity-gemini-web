import crypto from "node:crypto";
import {
  type TurnState, type StructuredContext, type UiError, type UiErrorCode,
  isTerminalTurnState, canTransitionTurnState,
} from "@antigravity-gemini-web/contracts";
import { RecoveryJournal, mayHaveSideEffects } from "./recovery-journal.js";
import { ContextManager, canonicalWorkspaceId } from "./context-manager.js";

export interface QueuedTurnItem {
  turnId: string;
  requestId: string;
  workspaceId: string;
  sessionId: string;
  prompt: string;
  payloadHash: string;
  queuedAt: number;
  context?: StructuredContext;
}
export interface HostToolAuthority {
  runtimeInstanceId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  requestId: string;
  requestNonce: string;
  epoch: number;
}
export interface SessionCoordinatorOptions {
  workspaceId: string;
  sessionId: string;
  runtimeInstanceId?: string;
  maxQueueSize?: number;
  maxLedgerSize?: number;
  journal?: RecoveryJournal;
  hostToolInventory?: ReadonlySet<string>;
  contextManager?: ContextManager;
  currentModelId?: string | null;
}
interface TurnRecord {
  requestId: string;
  payloadHash: string;
  state: TurnState;
  item?: QueuedTurnItem;
  requestNonce?: string;
}

export class SessionCoordinator {
  public readonly workspaceId: string;
  public readonly sessionId: string;
  public readonly runtimeInstanceId: string;
  public readonly maxQueueSize: number;
  public readonly maxLedgerSize: number;
  private queue: string[] = [];
  private activeTurnId: string | null = null;
  private readonly turns = new Map<string, TurnRecord>();
  private readonly requests = new Map<string, string>();
  private readonly journal?: RecoveryJournal;
  private readonly hostToolInventory: ReadonlySet<string>;
  private readonly contextManager: ContextManager;
  private readonly currentModelId: string | null;
  private instanceEpoch = 1;
  private disconnected = false;

  constructor(options: SessionCoordinatorOptions) {
    this.workspaceId = canonicalWorkspaceId(options.workspaceId);
    this.sessionId = options.sessionId;
    this.runtimeInstanceId = options.runtimeInstanceId ?? crypto.randomUUID();
    this.maxQueueSize = options.maxQueueSize ?? 5;
    this.maxLedgerSize = options.maxLedgerSize ?? 1000;
    if (!this.sessionId?.trim() || !this.runtimeInstanceId.trim()) throw new TypeError("Session/runtime identity is required.");
    for (const limit of [this.maxQueueSize, this.maxLedgerSize]) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("Queue/ledger limits must be positive finite integers.");
    }
    this.journal = options.journal;
    // Authority always comes from a copied host inventory; no implicit grant.
    this.hostToolInventory = new Set(options.hostToolInventory ?? []);
    this.contextManager = options.contextManager ?? new ContextManager();
    this.currentModelId = options.currentModelId ?? null;
    if (this.journal) {
      const report = this.journal.loadAndReconcile(this.runtimeInstanceId);
      this.disconnected = report.replayBlocked;
      for (const entry of report.activeEntries.values()) {
        if (canonicalWorkspaceId(entry.workspaceId) !== this.workspaceId || entry.sessionId !== this.sessionId) continue;
        if (this.turns.size >= this.maxLedgerSize || this.requests.has(entry.requestId)) {
          throw { code: "OUTCOME_UNKNOWN", message: "Recovery ledger exceeds capacity or contains conflicting requests.", retryable: false } satisfies UiError;
        }
        this.turns.set(entry.turnId, { requestId: entry.requestId, payloadHash: entry.payloadHash, state: entry.phase });
        this.requests.set(entry.requestId, entry.turnId);
        if (entry.phase === "outcome_unknown" || !isTerminalTurnState(entry.phase)) this.disconnected = true;
      }
    }
  }

  static fingerprintPayload(item: Pick<QueuedTurnItem, "prompt" | "context">): string {
    return RecoveryJournal.hashPayload({ prompt: item.prompt, context: item.context });
  }

  get queueDepth(): number { return this.queue.length; }
  get isBusy(): boolean { return this.activeTurnId !== null; }
  get isDisconnected(): boolean { return this.disconnected; }
  get currentActiveTurnId(): string | null { return this.activeTurnId; }
  get currentEpoch(): number { return this.instanceEpoch; }
  public getTurnState(turnId: string): TurnState | undefined { return this.turns.get(turnId)?.state; }

  private persist(item: QueuedTurnItem, phase: TurnState, errorCode?: UiErrorCode): void {
    const timestamp = new Date().toISOString();
    this.journal?.record({
      version: 1, instanceId: this.runtimeInstanceId, workspaceId: this.workspaceId,
      sessionId: this.sessionId, turnId: item.turnId, requestId: item.requestId,
      payloadHash: item.payloadHash, phase, timestamp,
      terminalOutcome: isTerminalTurnState(phase) ? { status: phase, completedAt: timestamp, errorCode } : undefined,
    });
  }

  public enqueue(item: QueuedTurnItem): void {
    if (canonicalWorkspaceId(item.workspaceId) !== this.workspaceId) {
      throw { code: "WORKSPACE_MISMATCH", message: "Turn belongs to a different workspace.", retryable: false } satisfies UiError;
    }
    if (item.sessionId !== this.sessionId) {
      throw { code: "STALE_AUTHORITY", message: "Turn belongs to a different session.", retryable: false } satisfies UiError;
    }
    if (!item.turnId?.trim() || !item.requestId?.trim() || typeof item.prompt !== "string" || !Number.isSafeInteger(item.queuedAt) || item.queuedAt < 0) {
      throw { code: "CONTRACT_MISMATCH", message: "Invalid turn identity or queue metadata.", retryable: false } satisfies UiError;
    }
    const fingerprint = SessionCoordinator.fingerprintPayload(item);
    if (item.payloadHash !== fingerprint) {
      throw { code: "CONFIG_CONFLICT", message: "Turn payload does not match its complete fingerprint.", retryable: false } satisfies UiError;
    }
    const existing = this.turns.get(item.turnId);
    const previousTurnId = this.requests.get(item.requestId);
    if (existing || previousTurnId) {
      if (existing?.requestId !== item.requestId || existing.payloadHash !== fingerprint || previousTurnId !== item.turnId) {
        throw { code: "CONFIG_CONFLICT", message: "Turn/request identity has a conflicting payload or binding.", retryable: false } satisfies UiError;
      }
      return; // queued, active and terminal retries never dispatch a second time
    }
    if (this.disconnected) {
      throw { code: "SERVICE_UNAVAILABLE", message: "Conversation requires reconciliation before new mutations.", retryable: false } satisfies UiError;
    }
    if (this.queue.length >= this.maxQueueSize || this.turns.size >= this.maxLedgerSize) {
      throw { code: "QUEUE_FULL", message: "Queue or deduplication ledger is full; records are not silently evicted.", retryable: false } satisfies UiError;
    }
    const context: StructuredContext = item.context
      ? { ...structuredClone(item.context), history: [...item.context.history, { role: "user", content: item.prompt }] }
      : { workspaceId: this.workspaceId, sessionId: this.sessionId, instructions: "", history: [{ role: "user", content: item.prompt }], toolResults: [] };
    this.contextManager.assertWithinBudget(context, this.workspaceId, this.sessionId);
    this.contextManager.verifyModelBinding(context, this.currentModelId);
    const owned = structuredClone({ ...item, workspaceId: this.workspaceId });
    this.persist(owned, "queued"); // commit before acknowledging or exposing work
    this.turns.set(item.turnId, { requestId: item.requestId, payloadHash: fingerprint, state: "queued", item: owned });
    this.requests.set(item.requestId, item.turnId);
    this.queue.push(item.turnId);
  }

  public cancelQueued(turnId: string): boolean {
    const index = this.queue.indexOf(turnId);
    if (index < 0) return false;
    const record = this.turns.get(turnId)!;
    this.persist(record.item!, "cancelled");
    this.queue.splice(index, 1);
    record.state = "cancelled"; record.item = undefined;
    return true;
  }

  public nextForExecution(): QueuedTurnItem | null {
    if (this.disconnected || this.isBusy || !this.queue.length) return null;
    const turnId = this.queue[0]!;
    const record = this.turns.get(turnId)!;
    this.persist(record.item!, "reserved"); // persistence failure cannot authorize Send/executor
    this.queue.shift();
    record.state = "reserved"; record.requestNonce = crypto.randomUUID();
    this.activeTurnId = turnId;
    return structuredClone(record.item!);
  }

  public transitionActiveTurn(turnId: string, state: TurnState, epoch: number, errorCode?: UiErrorCode): boolean {
    if (epoch !== this.instanceEpoch || this.disconnected) {
      throw { code: "STALE_AUTHORITY", message: "Turn update belongs to a retired authority.", retryable: false } satisfies UiError;
    }
    const record = this.turns.get(turnId);
    if (!record || isTerminalTurnState(record.state)) return false;
    if (this.activeTurnId !== turnId || !canTransitionTurnState(record.state, state)) {
      throw { code: "CONTRACT_MISMATCH", message: "Illegal active turn transition.", retryable: false } satisfies UiError;
    }
    if (record.state === state) return false;
    this.persist(record.item!, state, errorCode);
    record.state = state;
    if (isTerminalTurnState(state)) {
      this.activeTurnId = null; record.item = undefined; record.requestNonce = undefined;
    }
    return true;
  }

  public getActiveAuthority(): HostToolAuthority | null {
    if (!this.activeTurnId || this.disconnected) return null;
    const record = this.turns.get(this.activeTurnId)!;
    return {
      runtimeInstanceId: this.runtimeInstanceId, workspaceId: this.workspaceId, sessionId: this.sessionId,
      turnId: this.activeTurnId, requestId: record.requestId, requestNonce: record.requestNonce!, epoch: this.instanceEpoch,
    };
  }

  public verifyHostToolAuthority(toolName: string, authority: HostToolAuthority): void {
    const expected = this.getActiveAuthority();
    if (!expected || !authority || (Object.keys(expected) as (keyof HostToolAuthority)[]).some(key => authority[key] !== expected[key])) {
      throw { code: "STALE_AUTHORITY", message: "Tool authority does not match the active runtime/workspace/session/turn/request/nonce/epoch.", retryable: false } satisfies UiError;
    }
    const state = this.turns.get(expected.turnId)!.state;
    if (state !== "tool_pending" && state !== "tool_running") {
      throw { code: "STALE_AUTHORITY", message: "Turn is not authorized for tool execution in this phase.", retryable: false } satisfies UiError;
    }
    if (!this.hostToolInventory.has(toolName)) {
      throw { code: "TOOL_DENIED", message: "Tool is not permitted by the host inventory.", retryable: false } satisfies UiError;
    }
  }

  public handleDisconnection(_reason: string): void {
    this.disconnected = true;
    this.instanceEpoch++; // fence first, including when persistence fails
    const pending = [...new Set([...(this.activeTurnId ? [this.activeTurnId] : []), ...this.queue])];
    for (const turnId of pending) {
      const record = this.turns.get(turnId)!;
      const state = mayHaveSideEffects({ phase: record.state }) ? "outcome_unknown" : "interrupted";
      this.persist(record.item!, state, "RUNTIME_DISCONNECTED");
      record.state = state; record.item = undefined; record.requestNonce = undefined;
    }
    this.activeTurnId = null;
    this.queue = [];
    // A new reconciled driver binding is required; reconnect never automatically replays work.
  }
}

