import { test } from "node:test";
import assert from "node:assert/strict";
import { type RuntimeEvent, type UiError } from "@antigravity-gemini-web/contracts";
import { FakeRuntimeEngine, InProcessLauncherClient } from "./index.js";

function emit(engine: FakeRuntimeEngine, event: RuntimeEvent): void {
  const subscribers = (engine as unknown as { subscribers: Set<(event: RuntimeEvent) => void> }).subscribers;
  for (const subscriber of subscribers) subscriber(event);
}
function activity(instanceId: string, sequence: number): RuntimeEvent {
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: "0.1", runtimeInstanceId: instanceId, sequence, id: "event-" + sequence,
    occurredAt: timestamp, type: "activity.appended",
    payload: { entry: { id: "activity-" + sequence, at: timestamp, severity: "info", category: "fixture", summary: "Synthetic entry" } },
  };
}

test("G3 resync: coalesces gaps, drops events covered by snapshot and replays newer duplicates once", async t => {
  const engine = new FakeRuntimeEngine();
  const client = new InProcessLauncherClient(engine);
  const initial = await client.getSnapshot();
  const received: RuntimeEvent[] = [];
  t.after(client.subscribe(e => received.push(e)));
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let callbacks = 0;
  client.onResyncNeeded(async () => { callbacks++; await delayed; await client.getSnapshot(); });
  const base = initial.lastEventSequence;
  t.mock.method(engine, "getSnapshot", () => ({ ...initial, lastEventSequence: base + 3 }));
  emit(engine, activity(initial.runtimeInstanceId, base + 2));
  emit(engine, activity(initial.runtimeInstanceId, base + 4));
  emit(engine, activity(initial.runtimeInstanceId, base + 4));
  emit(engine, activity(initial.runtimeInstanceId, base + 5));
  release();
  await client.waitForResync();
  assert.equal(callbacks, 1);
  assert.deepEqual(received.map(e => e.sequence), [base + 4, base + 5]);
});

test("G3 resync: restart preserves waiters of the previous epoch and ignores retired snapshots", { timeout: 3000 }, async t => {
  const engine = new FakeRuntimeEngine();
  const client = new InProcessLauncherClient(engine);
  const old = await client.getSnapshot();
  t.after(client.subscribe(() => {}));
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  client.onResyncNeeded(async () => { await delayed; await client.getSnapshot(); });
  engine.simulateEventGap();
  const existingWaiter = client.waitForResync();
  const newInstance = engine.simulateRestart();
  release();
  await existingWaiter;
  assert.equal((await client.getSnapshot()).runtimeInstanceId, newInstance);
  t.mock.method(engine, "getSnapshot", () => old);
  await assert.rejects(client.getSnapshot(), (error: UiError) => error.code === "STALE_AUTHORITY");
});

test("G3 resync: snapshot failure reaches callers without an unhandled background rejection", async t => {
  const engine = new FakeRuntimeEngine();
  const client = new InProcessLauncherClient(engine);
  const initial = await client.getSnapshot();
  t.after(client.subscribe(() => {}));
  t.mock.method(engine, "getSnapshot", () => { throw new Error("synthetic unavailable runtime"); });
  emit(engine, activity(initial.runtimeInstanceId, initial.lastEventSequence + 2));
  await assert.rejects(client.waitForResync(), (error: UiError) => error.code === "SERVICE_UNAVAILABLE");
});

test("G3 resync: unresolved residual gaps stop after three snapshot attempts", async t => {
  const engine = new FakeRuntimeEngine();
  const client = new InProcessLauncherClient(engine);
  const initial = await client.getSnapshot();
  t.after(client.subscribe(() => {}));
  let reads = 0;
  t.mock.method(engine, "getSnapshot", () => { reads++; return initial; });
  emit(engine, activity(initial.runtimeInstanceId, initial.lastEventSequence + 2));
  await assert.rejects(client.waitForResync(), (error: UiError) => error.code === "CONTRACT_MISMATCH");
  assert.equal(reads, 3);
});

test("G3 resync: a never-resolving snapshot has a finite deadline", { timeout: 3000 }, async t => {
  const engine = new FakeRuntimeEngine();
  const client = new InProcessLauncherClient(engine);
  const initial = await client.getSnapshot();
  t.after(client.subscribe(() => {}));
  t.mock.method(engine, "getSnapshot", () => new Promise(() => {}));
  const started = Date.now();
  emit(engine, activity(initial.runtimeInstanceId, initial.lastEventSequence + 2));
  await assert.rejects(client.waitForResync(), (error: UiError) => error.code === "SERVICE_UNAVAILABLE");
  assert.ok(Date.now() - started < 2500);
});
