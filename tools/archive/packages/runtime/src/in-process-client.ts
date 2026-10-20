import {
  type LauncherClient,
  type RuntimeSnapshot,
  type ControlCommand,
  type CommandAck,
  type OperationRecord,
  type SessionSummary,
  type ActivityEntry,
  type ActivityQuery,
  type Page,
  type RuntimeEvent,
  ControlCommandSchema,
  CommandAckSchema,
  RuntimeSnapshotSchema,
  OperationRecordSchema,
  ActivityQuerySchema,
  ActivityEntrySchema,
  SessionSummarySchema,
  createPageSchema,
  RuntimeEventSchema,
  type UiError,
} from "@antigravity-gemini-web/contracts";
import type { FakeRuntimeEngine } from "./fake-runtime.js";

export class InProcessLauncherClient implements LauncherClient {
  private engine: FakeRuntimeEngine;
  private currentInstanceId: string | null = null;
  private lastSeenSequence: number = 0;
  private retiredInstances = new Set<string>();
  private instanceWatermarks = new Map<string, number>();
  private resyncCallbacks = new Set<() => void | Promise<void>>();
  private isResyncing = false;
  private resyncEpoch = 0;
  private resyncBuffer: RuntimeEvent[] = [];
  private activeResyncPromise: Promise<void> | null = null;
  private resolveActiveResync: (() => void) | null = null;
  private resyncError: UiError | null = null;
  private readonly maxResyncBuffer = 1000;

  private listeners = new Set<(event: RuntimeEvent) => void>();
  private engineUnsubscribe: (() => void) | null = null;

  constructor(engine: FakeRuntimeEngine) {
    this.engine = engine;
  }

  public async getSnapshot(): Promise<RuntimeSnapshot> {
    const epoch = this.resyncEpoch;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let raw: RuntimeSnapshot;
    try {
      raw = await Promise.race([
        Promise.resolve(this.engine.getSnapshot()),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject({ code: "SERVICE_UNAVAILABLE", message: "Runtime snapshot timed out.", retryable: true } satisfies UiError), 1500);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const validated = RuntimeSnapshotSchema.parse(raw);
    if (this.retiredInstances.has(validated.runtimeInstanceId) ||
      (this.currentInstanceId === validated.runtimeInstanceId && validated.lastEventSequence < this.lastSeenSequence)) {
      throw { code: "STALE_AUTHORITY", message: "Snapshot is older than the established runtime authority.", retryable: false } satisfies UiError;
    }
    if (this.currentInstanceId && this.currentInstanceId !== validated.runtimeInstanceId) {
      this.retiredInstances.add(this.currentInstanceId);
    }
    this.currentInstanceId = validated.runtimeInstanceId;
    this.lastSeenSequence = validated.lastEventSequence;
    this.instanceWatermarks.set(validated.runtimeInstanceId, validated.lastEventSequence);
    this.resyncError = null;

    // If active resync is underway, authoritative snapshot fulfills boundary for the current epoch [A2]
    if (this.isResyncing && epoch === this.resyncEpoch) {
      this.completeResync(epoch, validated.runtimeInstanceId, validated.lastEventSequence);
    }

    return validated;
  }

  public async execute(command: ControlCommand): Promise<CommandAck> {
    // Validate command at client boundary
    const validatedCommand = ControlCommandSchema.parse(command);
    const ack = await this.engine.execute(validatedCommand);
    // Validate ack at client boundary
    return CommandAckSchema.parse(ack);
  }

  public async getOperation(operationId: string): Promise<OperationRecord> {
    const raw = await this.engine.getOperation(operationId);
    return OperationRecordSchema.parse(raw);
  }

  public async getSessions(cursor?: string): Promise<Page<SessionSummary>> {
    const raw = await this.engine.getSessions(cursor);
    // Validate page boundary [F4 regression]
    return createPageSchema(SessionSummarySchema).parse(raw);
  }

  public async getActivity(query: ActivityQuery): Promise<Page<ActivityEntry>> {
    const validatedQuery = ActivityQuerySchema.parse(query);
    const raw = await this.engine.getActivity(validatedQuery);
    // Validate page boundary [F4 regression]
    return createPageSchema(ActivityEntrySchema).parse(raw);
  }

  public onResyncNeeded(callback: () => void | Promise<void>): () => void {
    this.resyncCallbacks.add(callback);
    return () => {
      this.resyncCallbacks.delete(callback);
    };
  }

  public subscribe(onEvent: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(onEvent);

    // Single source subscription to engine with fan-out [F3 regression, R5 instance filtering]
    if (!this.engineUnsubscribe) {
      this.engineUnsubscribe = this.engine.subscribe((rawEvent) => {
        const event = RuntimeEventSchema.parse(rawEvent);

        // 1. Reject late events from retired instances [R5]
        if (this.retiredInstances.has(event.runtimeInstanceId)) {
          return;
        }
        if (this.resyncError) return; // explicit snapshot recovery is required after a failed resync

        // 2. Handle instance restart [R5, A2]
        if (this.currentInstanceId && event.runtimeInstanceId !== this.currentInstanceId) {
          // Only authoritative snapshot.updated events can introduce a new instance restart
          if (event.type !== "snapshot.updated") {
            return;
          }
          this.retiredInstances.add(this.currentInstanceId);
          this.currentInstanceId = event.runtimeInstanceId;
          this.lastSeenSequence = event.sequence;
          this.instanceWatermarks.set(event.runtimeInstanceId, event.sequence);
          this.fanOut(event);
          this.initiateResync(undefined, true);
          return;
        }

        // Initialize instance if not yet set
        if (!this.currentInstanceId) {
          this.currentInstanceId = event.runtimeInstanceId;
          this.lastSeenSequence = event.sequence;
          this.instanceWatermarks.set(event.runtimeInstanceId, event.sequence);
          this.fanOut(event);
          return;
        }

        // 3. Discard duplicate / stale events
        if (event.sequence <= this.lastSeenSequence) {
          return;
        }

        // Keep one resync boundary while subsequent events arrive.
        if (this.isResyncing) {
          this.bufferEvent(event);
          return;
        }

        // 4. Handle sequence gap [A2]
        if (event.sequence > this.lastSeenSequence + 1) {
          this.initiateResync(event);
          return;
        }

        // 5. Normal sequential delivery
        this.lastSeenSequence = event.sequence;
        this.instanceWatermarks.set(this.currentInstanceId, event.sequence);
        this.fanOut(event);
      });
    }

    return () => {
      this.listeners.delete(onEvent);
      if (this.listeners.size === 0 && this.engineUnsubscribe) {
        this.engineUnsubscribe();
        this.engineUnsubscribe = null;
      }
    };
  }

  private bufferEvent(event: RuntimeEvent): void {
    if (this.resyncBuffer.length >= this.maxResyncBuffer) {
      this.failResync({ code: "QUEUE_FULL", message: "Resync event buffer is full; a fresh snapshot is required.", retryable: true });
      return;
    }
    this.resyncBuffer.push(event);
  }

  private failResync(error: UiError): void {
    this.resyncEpoch++;
    this.resyncError = error;
    this.isResyncing = false;
    this.resyncBuffer = [];
    this.resolveActiveResync?.();
    this.resolveActiveResync = null;
    this.activeResyncPromise = null;
  }

  private initiateResync(triggerEvent?: RuntimeEvent, replaceEpoch = false): void {
    if (this.isResyncing && !replaceEpoch) {
      if (triggerEvent) this.bufferEvent(triggerEvent);
      return;
    }
    const epoch = ++this.resyncEpoch;
    this.isResyncing = true;
    this.resyncError = null;

    if (triggerEvent) {
      this.bufferEvent(triggerEvent);
    }

    // Restart replaces the epoch but preserves the promise observed by existing waiters.
    if (!this.activeResyncPromise) {
      this.activeResyncPromise = new Promise<void>((resolve) => {
        this.resolveActiveResync = resolve;
      });
    }

    // Notify registered resync callbacks synchronously, tracking any returned promises [A2]
    const promises: Promise<void>[] = [];
    for (const cb of this.resyncCallbacks) {
      try {
        const res = cb();
        if (res) {
          promises.push(Promise.resolve(res));
        }
      } catch {
        // Isolate synchronous callback error
      }
    }

    // Bound callback waiting and snapshot attempts; observe every rejection.
    (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(promises),
          new Promise<void>((r) => { timer = setTimeout(r, 500); }),
        ]);
        for (let attempt = 0; attempt < 3 && this.isResyncing && this.resyncEpoch === epoch; attempt++) {
          await this.getSnapshot();
        }
        if (this.isResyncing && this.resyncEpoch === epoch) {
          this.failResync({ code: "CONTRACT_MISMATCH", message: "Snapshot could not reconcile the remaining event gap.", retryable: true });
        }
      } catch {
        if (this.isResyncing && this.resyncEpoch === epoch) {
          this.failResync({ code: "SERVICE_UNAVAILABLE", message: "Runtime snapshot resync failed.", retryable: true });
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })();
  }

  private completeResync(epoch: number, instanceId: string, sequence: number): void {
    if (epoch !== this.resyncEpoch) {
      return; // Ignore stale epoch
    }

    const buffered = [...this.resyncBuffer];
    this.resyncBuffer = [];

    // Sort buffered events by sequence ascending before replaying
    buffered.sort((a, b) => a.sequence - b.sequence);

    for (let index = 0; index < buffered.length; index++) {
      const evt = buffered[index]!;
      if (
        evt.runtimeInstanceId === instanceId &&
        !this.retiredInstances.has(evt.runtimeInstanceId)
      ) {
        if (evt.sequence <= this.lastSeenSequence) continue;
        if (evt.sequence !== this.lastSeenSequence + 1) {
          this.resyncBuffer = buffered.slice(index);
          return; // request another authoritative snapshot; never replay across a gap
        }
        this.lastSeenSequence = evt.sequence;
        this.instanceWatermarks.set(instanceId, this.lastSeenSequence);
        this.fanOut(evt);
      }
    }
    this.isResyncing = false;

    if (this.resolveActiveResync) {
      this.resolveActiveResync();
      this.resolveActiveResync = null;
      this.activeResyncPromise = null;
    }
  }

  public async waitForResync(): Promise<void> {
    if (this.isResyncing && this.activeResyncPromise) {
      await this.activeResyncPromise;
    }
    if (this.resyncError) throw this.resyncError;
  }

  private fanOut(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Isolate listener exceptions so other listeners still receive event
      }
    }
  }
}

