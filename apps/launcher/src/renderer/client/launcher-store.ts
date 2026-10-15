import {
  type LauncherClient, type RuntimeSnapshot, type RuntimeEvent, type UiError,
  RuntimeSnapshotSchema, RuntimeEventSchema, safeUiError,
} from "@antigravity-gemini-web/contracts";

export interface LauncherState { snapshot: RuntimeSnapshot | null; error: UiError | null; disconnected: boolean; disconnectedAt?: string; }
export class LauncherStore {
  public state: LauncherState = { snapshot: null, error: null, disconnected: false };
  private listeners = new Set<(state: LauncherState) => void>();
  private unsubscribe?: () => void;
  private buffered: RuntimeEvent[] = [];
  private retired = new Set<string>();
  private pending?: Promise<void>;
  private disposed = false;
  constructor(private readonly client: LauncherClient) {}
  private publish(): void { for (const listener of this.listeners) listener(structuredClone(this.state)); }
  public listen(listener: (state: LauncherState) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  public async start(): Promise<void> {
    this.unsubscribe ??= this.client.subscribe(raw => this.receive(raw));
    await this.refresh();
  }
  public refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pending) return this.pending;
    const promise = Promise.resolve().then(async () => {
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          let snapshot: RuntimeSnapshot;
          try {
            snapshot = RuntimeSnapshotSchema.parse(await Promise.race([
              this.client.getSnapshot(),
              new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject({ code: "SERVICE_UNAVAILABLE" }), 1500); }),
            ]));
          } finally { if (timer !== undefined) clearTimeout(timer); }
          if (this.disposed) return;
          const current = this.state.snapshot;
          if (this.retired.has(snapshot.runtimeInstanceId) || (current?.runtimeInstanceId === snapshot.runtimeInstanceId && snapshot.lastEventSequence < current.lastEventSequence)) {
            throw { code: "STALE_AUTHORITY" };
          }
          if (current && current.runtimeInstanceId !== snapshot.runtimeInstanceId) this.retired.add(current.runtimeInstanceId);
          this.state = { snapshot, error: null, disconnected: ["failed", "stopped"].includes(snapshot.runtime.state) };
          const events = this.buffered.splice(0).sort((a, b) => a.sequence - b.sequence);
          let gap = false;
          for (const event of events) {
            if (this.retired.has(event.runtimeInstanceId)) continue;
            if (event.runtimeInstanceId !== snapshot.runtimeInstanceId || event.sequence > this.state.snapshot!.lastEventSequence + 1) {
              this.buffered.push(event); gap = true; continue;
            }
            if (event.sequence > this.state.snapshot!.lastEventSequence) this.apply(event);
          }
          this.publish();
          if (!gap) return;
        }
        throw { code: "CONTRACT_MISMATCH" };
      } catch (error) {
        if (!this.disposed) {
          this.state = { ...this.state, error: safeUiError(error), disconnected: true, disconnectedAt: new Date().toISOString() };
          this.publish();
        }
      }
    });
    this.pending = promise;
    promise.then(() => { this.pending = undefined; }, () => { this.pending = undefined; });
    return promise;
  }
  private receive(raw: RuntimeEvent): void {
    const result = RuntimeEventSchema.safeParse(raw);
    if (!result.success) { this.state.error = safeUiError({ code: "CONTRACT_MISMATCH" }); this.publish(); return; }
    const event = result.data;
    if (this.retired.has(event.runtimeInstanceId) || this.disposed) return;
    const snapshot = this.state.snapshot;
    if (!snapshot || this.pending || event.runtimeInstanceId !== snapshot.runtimeInstanceId || event.sequence > snapshot.lastEventSequence + 1) {
      if (this.buffered.length >= 1000) {
        this.state = { ...this.state, error: safeUiError({ code: "QUEUE_FULL" }), disconnected: true };
        this.publish(); return;
      }
      this.buffered.push(event); this.refresh(); return;
    }
    if (event.sequence <= snapshot.lastEventSequence) return;
    this.apply(event); this.publish();
    if (event.type === "operation.updated") this.refresh();
  }
  private apply(event: RuntimeEvent): void {
    const snapshot = this.state.snapshot!;
    snapshot.lastEventSequence = event.sequence;
    if (event.type === "snapshot.updated") {
      this.state.snapshot = { ...event.payload.snapshot, lastEventSequence: Math.max(event.sequence, event.payload.snapshot.lastEventSequence) };
      this.state.disconnected = ["stopped", "failed"].includes(event.payload.snapshot.runtime.state);
    } else if (event.type === "session.updated") {
      const index = snapshot.sessions.findIndex(session => session.id === event.payload.session.id);
      if (index >= 0) snapshot.sessions[index] = event.payload.session;
      else snapshot.sessions.push(event.payload.session);
    } else if (event.type === "runtime.disconnected") {
      this.state.disconnected = true; this.state.disconnectedAt = event.payload.at;
    }
  }
  public dispose(): void { this.disposed = true; this.unsubscribe?.(); this.listeners.clear(); this.buffered = []; }
}
