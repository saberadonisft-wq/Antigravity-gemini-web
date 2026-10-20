import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeFacade } from "./runtime-facade.js";
import { FakeRuntimeEngine } from "./fake-runtime.js";
import { ConfigTransactionService } from "./config-transaction.js";
import { OwnedBrowserAdapter } from "./owned-browser.js";
import { LiveGeminiBrowserAdapter } from "@antigravity-gemini-web/gemini-browser";
import { type UiError, type RuntimeSnapshot, isTerminalOperationState } from "@antigravity-gemini-web/contracts";

function sandbox(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "g4-followup-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(root).startsWith("g4-followup-"));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return root;
}
const errorCode = (code: string) => (error: unknown) => (error as UiError).code === code;
async function terminal(runtime: RuntimeFacade, id: string) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const operation = await runtime.getOperation(id);
    if (isTerminalOperationState(operation.state)) return operation;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Operation did not settle.");
}

test("G4 followup: ACK and receipt exist while browser effect is pending; duplicate uses one effect", { timeout: 4000 }, async t => {
  const root = sandbox(t);
  let release!: () => void, calls = 0, complete = false;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  class Browser extends LiveGeminiBrowserAdapter {
    override async openBrowser() { calls++; await blocked; complete = true; return { opened: false }; }
    override async cleanup() { release(); }
  }
  const runtime = new RuntimeFacade({ mode: "live", appDataDir: root, liveBrowserAdapter: new Browser() });
  t.after(() => runtime.stop());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const command = { requestId: "pending-browser", type: "browser.open", payload: {} } as const;
    const ack = await Promise.race([runtime.execute(command), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("ACK waited for browser completion")), 1000); })]);
    assert.equal(ack.accepted, true); assert.equal(complete, false);
    assert.deepEqual(await runtime.execute(command), ack);
    assert.equal(calls, 1);
    if (!ack.accepted) throw new Error("Rejected");
    const durable = JSON.parse(fs.readFileSync(path.join(root, "operations.json"), "utf8"))[0];
    assert.equal(durable.ack.operationId, ack.operationId);
    assert.equal(durable.operation.id, ack.operationId);
    assert.equal(durable.phase, "pending");
    assert.equal((await runtime.getOperation(ack.operationId)).state, "running");
    release();
    assert.equal((await terminal(runtime, ack.operationId)).state, "failed");
    assert.deepEqual(await runtime.execute(command), ack);
  } finally { if (timer) clearTimeout(timer); release(); await runtime.stop(); }
});

test("G4 followup: failed terminal commit cannot report settings success or permit further mutations", async t => {
  const root = sandbox(t);
  const runtime = new RuntimeFacade({ mode: "live", appDataDir: root });
  await runtime.start();
  const original = fs.renameSync;
  const mocked = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === path.join(root, "operations.json") && JSON.parse(fs.readFileSync(from, "utf8")).some((entry: any) => entry.operation?.state === "succeeded")) throw new Error("synthetic terminal ledger lock");
    original(from, to);
  });
  try {
    const ack = await runtime.execute({ requestId: "terminal-write-fail", type: "settings.update", payload: { expectedRevision: 1, patch: { theme: "dark" } } });
    assert.equal(ack.accepted, false);
    if (!ack.accepted) assert.equal(ack.error.code, "OUTCOME_UNKNOWN");
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "settings.json"), "utf8")).theme, "dark");
    const durable = JSON.parse(fs.readFileSync(path.join(root, "operations.json"), "utf8"))[0];
    assert.equal(durable.phase, "pending");
    assert.equal((await runtime.getOperation(durable.ack.operationId)).state, "outcome_unknown");
    await assert.rejects(runtime.execute({ requestId: "must-not-dispatch", type: "browser.open", payload: {} }), errorCode("SERVICE_UNAVAILABLE"));
  } finally { mocked.mock.restore(); await runtime.stop(); }
});

test("G4 followup: shutdown fences pending browser result and retains an observable unknown operation", async t => {
  const root = sandbox(t);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  class Browser extends LiveGeminiBrowserAdapter {
    override async openBrowser() { await blocked; return { opened: true }; }
    override async checkStatus() { return { browserState: "ready" as const, accountState: "signed_in" as const, checkedAt: new Date().toISOString() }; }
    override async cleanup() {}
  }
  const runtime = new RuntimeFacade({ mode: "live", appDataDir: root, liveBrowserAdapter: new Browser() });
  const command = { requestId: "late-browser", type: "browser.open", payload: {} } as const;
  const ack = await runtime.execute(command);
  assert.equal(ack.accepted, true);
  await runtime.stop();
  release();
  await new Promise<void>(resolve => setImmediate(resolve));
  if (!ack.accepted) throw new Error("Rejected");
  assert.equal((await runtime.getOperation(ack.operationId)).state, "outcome_unknown");
  assert.equal((await runtime.getSnapshot()).browser.state, "closed");
  const restart = new RuntimeFacade({ mode: "live", appDataDir: root });
  try {
    assert.deepEqual(await restart.execute(command), ack);
    assert.equal((await restart.getOperation(ack.operationId)).state, "outcome_unknown");
  } finally { await restart.stop(); }
});

test("G4 followup: cancel confirmations are bound to one turn and late callbacks cannot reopen terminal turns", async () => {
  const engine = new FakeRuntimeEngine("generating", "demo");
  const snapshot = (engine as unknown as { currentSnapshot: RuntimeSnapshot }).currentSnapshot;
  const first = snapshot.sessions[0]!;
  const second = structuredClone(first);
  second.id = "other-session"; second.activeTurn!.id = "other-turn"; second.activeTurn!.sessionId = second.id;
  snapshot.sessions.push(second);
  const one = await engine.execute({ requestId: "cancel-one", type: "turn.cancel", payload: { sessionId: first.id, turnId: first.activeTurn!.id } });
  const two = await engine.execute({ requestId: "cancel-two", type: "turn.cancel", payload: { sessionId: second.id, turnId: second.activeTurn!.id } });
  assert.equal(one.accepted, true); assert.equal(two.accepted, true);
  if (!one.accepted || !two.accepted) throw new Error("Rejected");
  engine.confirmTurnCancellation(first.id, first.activeTurn!.id);
  assert.equal((await engine.getOperation(one.operationId)).state, "succeeded");
  assert.equal((await engine.getOperation(two.operationId)).state, "running");
  assert.equal(second.activeTurn!.state, "cancel_requested");
  const failure = { code: "SERVICE_UNAVAILABLE", message: "Synthetic cancellation rejected", retryable: false } satisfies UiError;
  engine.failTurnCancellation(second.id, second.activeTurn!.id, failure);
  assert.equal((await engine.getOperation(two.operationId)).state, "failed");
  assert.equal(second.activeTurn!.canCancel, true);
  assert.notEqual(second.activeTurn!.state, "cancel_requested");
  const previous = engine.getSnapshot();
  engine.failTurnCancellation(first.id, first.activeTurn!.id, failure);
  engine.confirmTurnCancellation(second.id, second.activeTurn!.id);
  assert.deepEqual(engine.getSnapshot(), previous);
});

test("G4 followup: rollback refuses an externally edited owned key without changing any bytes", async t => {
  const root = sandbox(t), file = path.join(root, "fixture.json");
  fs.writeFileSync(file, JSON.stringify({ revision: 1, service: "original", unrelated: "initial" }));
  const service = new ConfigTransactionService({ fixtureRoot: root, configPath: file });
  const preview = await service.preview("modify", { service: "owned" });
  await service.apply(preview.previewId, { confirmed: true });
  fs.writeFileSync(file, JSON.stringify({ revision: 2, service: "user-edited", unrelated: "user-edited" }));
  const before = fs.readFileSync(file, "utf8");
  await assert.rejects(service.restore(preview.previewId, { confirmed: true }), errorCode("CONFIG_CONFLICT"));
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("G4 followup: journal failure prevents fixture mutation and missing install target cannot be recreated", async t => {
  const root = sandbox(t), file = path.join(root, "fixture.json"), journal = path.join(root, "journal");
  fs.writeFileSync(file, JSON.stringify({ revision: 1 }));
  const service = new ConfigTransactionService({ fixtureRoot: root, configPath: file, journalPath: journal });
  const preview = await service.preview("install", { service: true });
  const before = fs.readFileSync(file, "utf8");
  fs.unlinkSync(journal); fs.mkdirSync(journal);
  await assert.rejects(service.apply(preview.previewId, { confirmed: true }), errorCode("SERVICE_UNAVAILABLE"));
  assert.equal(fs.readFileSync(file, "utf8"), before);
  fs.unlinkSync(file);
  await assert.rejects(service.apply(preview.previewId, { confirmed: true }), errorCode("HOST_NOT_FOUND"));
  assert.equal(fs.existsSync(file), false);
});

test("G4 followup: fixture rejects unsafe scope, malformed document, reserved patch fields and invalid lifetimes", async t => {
  const root = sandbox(t), file = path.join(root, "fixture.json");
  assert.throws(() => new ConfigTransactionService({ fixtureRoot: root, configPath: path.join(root, "..", "unowned.json") }), errorCode("INVALID_ARGUMENT"));
  fs.writeFileSync(file, "null");
  const service = new ConfigTransactionService({ fixtureRoot: root, configPath: file });
  await assert.rejects(service.preview("modify", { service: true }), errorCode("CONTRACT_MISMATCH"));
  fs.writeFileSync(file, JSON.stringify({ revision: 1 }));
  await assert.rejects(service.preview("modify", { revision: 123 }), errorCode("INVALID_ARGUMENT"));
  await assert.rejects(service.preview("modify", { service: true }, { ttlMs: Number.NaN }), errorCode("INVALID_ARGUMENT"));
  const preview = await service.preview("modify", { service: true });
  await service.apply(preview.previewId, { confirmed: true });
  await assert.rejects(service.restore(preview.previewId), errorCode("CONFIRMATION_REQUIRED"));
});

test("G4 followup: focusing an owned browser uses CDP; a racing external target is detached", async t => {
  const browser = new OwnedBrowserAdapter({ debugPort: 59989 });
  Object.defineProperty(browser.driver, "isConnected", { configurable: true, get: () => true });
  browser.driver.isOwnedProcess = true;
  const methods: string[] = [];
  browser.driver.cdp = { send: async (method: string) => { methods.push(method); return {}; } } as any;
  t.mock.method(browser.driver, "launchOrAttach", async () => true);
  assert.equal((await browser.openBrowser()).opened, true);
  assert.deepEqual(methods, ["Page.bringToFront"]);
  const external = new OwnedBrowserAdapter({ debugPort: 59988 });
  t.mock.method(external as any, "portOccupied", async () => false);
  t.mock.method(external.driver, "launchOrAttach", async () => true);
  let detached = 0;
  t.mock.method(external.driver, "close", async () => { detached++; });
  assert.equal((await external.openBrowser()).opened, false);
  assert.equal(detached, 1);
});

test("G4 followup: stop still cleans owned browser if state publication fails", async t => {
  const root = sandbox(t);
  let cleanups = 0;
  class Browser extends LiveGeminiBrowserAdapter { override async cleanup() { cleanups++; } }
  const runtime = new RuntimeFacade({ mode: "live", appDataDir: root, liveBrowserAdapter: new Browser() });
  await runtime.start();
  const mocked = t.mock.method(runtime.engine, "markStopped", () => { throw new Error("synthetic publication failure"); });
  await assert.rejects(runtime.stop(), errorCode("SERVICE_UNAVAILABLE"));
  assert.equal(cleanups, 1);
  mocked.mock.restore();
  await runtime.stop();
});
