import { test, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeFacade } from "./runtime-facade.js";
import { SessionCoordinator } from "./session-coordinator.js";
import { LiveGeminiBrowserAdapter, type GeminiBrowserAdapter, type PromptTurnResponse } from "@antigravity-gemini-web/gemini-browser";
import { type UiError, type CommandAck, isTerminalOperationState } from "@antigravity-gemini-web/contracts";
import net from "node:net";
import { OwnedBrowserAdapter } from "./owned-browser.js";

const code = (expected: string) => (error: unknown) => (error as UiError)?.code === expected;
async function operation(runtime: RuntimeFacade, ack: CommandAck) {
  if (!ack.accepted) throw new Error("Expected an operation acknowledgment.");
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const record = await runtime.getOperation(ack.operationId);
    if (isTerminalOperationState(record.state)) return record;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Terminal operation deadline.");
}
const ownedDirectories: string[] = [];
const ownedRuntimes: RuntimeFacade[] = [];
after(async () => {
  for (const runtime of ownedRuntimes) await runtime.stop();
  for (const directory of ownedDirectories) {
    const resolved = fs.realpathSync(directory);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith("g4-remediation-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
function sandbox(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "g4-remediation-"));
  ownedDirectories.push(directory);
  return directory;
}
function facade(t: TestContext, options: ConstructorParameters<typeof RuntimeFacade>[0] = {}): RuntimeFacade {
  const appDataDir = sandbox(t);
  const runtime = new RuntimeFacade({ mode: "demo", appDataDir, ...options });
  ownedRuntimes.push(runtime);
  return runtime;
}

test("G4 fix: default demo/live storage is isolated and coordinator identity is unambiguous", async t => {
  const demo = new RuntimeFacade({ mode: "demo" });
  const live = new RuntimeFacade({ mode: "live" });
  assert.notEqual(demo.appDataDir, live.appDataDir);
  assert.ok(demo.appDataDir.startsWith(os.tmpdir()));
  const runtime = facade(t);
  await runtime.start();
  assert.notEqual(runtime.getOrCreateCoordinator("a::b", "c"), runtime.getOrCreateCoordinator("a", "b::c"));
  assert.equal(runtime.getOrCreateCoordinator("D:/repo", "session"), runtime.getOrCreateCoordinator("d:\\repo\\", "session"));
});

test("G4 fix: settings persist across restart; durable retry cannot increment revision twice", async t => {
  const runtime = facade(t);
  const command = { requestId: "persistent-settings", type: "settings.update", payload: { expectedRevision: 1, patch: { theme: "dark" } } } as const;
  const ack = await runtime.execute(command);
  assert.equal(ack.accepted, true);
  assert.equal((await runtime.getSnapshot()).settings.revision, 2);
  await runtime.stop();
  const restarted = facade(t, { appDataDir: runtime.appDataDir });
  assert.deepEqual(await restarted.execute(command), ack);
  assert.equal((await restarted.getSnapshot()).settings.theme, "dark");
  assert.equal((await restarted.getSnapshot()).settings.revision, 2);
  if (ack.accepted) assert.equal((await restarted.getOperation(ack.operationId)).state, "succeeded");
  await assert.rejects(restarted.execute({ ...command, payload: { expectedRevision: 2, patch: { theme: "light" } } }), code("CONFIG_CONFLICT"));
});

test("G4 fix: settings rename failure leaves the previous file and snapshot unchanged", async t => {
  const runtime = facade(t);
  await runtime.execute({ requestId: "initial-settings", type: "settings.update", payload: { expectedRevision: 1, patch: { theme: "dark" } } });
  const file = path.join(runtime.appDataDir, "settings.json");
  const before = fs.readFileSync(file, "utf8");
  const original = fs.renameSync;
  const mock = t.mock.method(fs, "renameSync", (source: fs.PathLike, target: fs.PathLike) => {
    if (String(target) === file) throw new Error("synthetic locked destination");
    original(source, target);
  });
  const ack = await runtime.execute({ requestId: "failed-settings", type: "settings.update", payload: { expectedRevision: 2, patch: { theme: "light" } } });
  assert.equal(ack.accepted, false);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal((await runtime.getSnapshot()).settings.theme, "dark");
  mock.mock.restore();
});

test("G4 fix: export writes a chosen file, redacts content, and duplicate clicks use one dialog", async t => {
  const appDataDir = sandbox(t);
  const destination = path.join(appDataDir, "chosen.json");
  let dialogs = 0;
  const runtime = facade(t, { appDataDir, chooseExportDestination: async () => { dialogs++; return destination; } });
  await runtime.start();
  runtime.engine.recordActivity("warning", "fixture", 'Cookie: SID="SYNTHETIC_PRIVATE_G4_MARKER"');
  const request = { requestId: "export", type: "activity.export", payload: { range: "last_24h" } } as const;
  const [first, second] = await Promise.all([runtime.execute(request), runtime.execute(request)]);
  assert.deepEqual(first, second);
  assert.equal(dialogs, 1);
  assert.equal((await operation(runtime, first)).state, "succeeded");
  const contents = fs.readFileSync(destination, "utf8");
  assert.ok(contents.includes("[REDACTED]"));
  assert.equal(contents.includes("SYNTHETIC_PRIVATE_G4_MARKER"), false);
  assert.equal(fs.readFileSync(path.join(appDataDir, "operations.json"), "utf8").includes(destination), false);
  if (first.accepted) assert.equal((await runtime.getOperation(first.operationId)).state, "succeeded");
});

test("G4 fix: cancelling a destination or resolving its dialog after shutdown never writes a file", async t => {
  const cancelled = facade(t, { chooseExportDestination: async () => null });
  const ack = await cancelled.execute({ requestId: "cancel-export", type: "activity.export", payload: { range: "last_24h" } });
  assert.equal(ack.accepted, true);
  const cancellation = await operation(cancelled, ack);
  assert.equal(cancellation.state, "failed");
  assert.equal(cancellation.error?.code, "CANCELLED");
  const appDataDir = sandbox(t);
  const destination = path.join(appDataDir, "late.json");
  let resolve!: (destination: string) => void;
  let entered!: () => void;
  const enteredDialog = new Promise<void>(done => { entered = done; });
  const runtime = facade(t, { appDataDir, chooseExportDestination: () => { entered(); return new Promise(done => { resolve = done; }); } });
  const pending = runtime.execute({ requestId: "late-export", type: "activity.export", payload: { range: "last_24h" } });
  await enteredDialog;
  await runtime.stop();
  resolve(destination);
  const late = await pending;
  assert.equal(late.accepted, true);
  assert.equal((await operation(runtime, late)).state, "outcome_unknown");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(fs.existsSync(destination), false);
});

test("G4 fix: corrupt startup is not marked ready and cannot permit control mutations", async t => {
  const runtime = facade(t);
  const file = path.join(runtime.appDataDir, "journals", "recovery.journal.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "{corrupt");
  await assert.rejects(runtime.start(), code("OUTCOME_UNKNOWN"));
  await assert.rejects(runtime.execute({ requestId: "blocked", type: "browser.open", payload: {} }), code("OUTCOME_UNKNOWN"));
});

test("G4 fix: facade composes context, durable journal and driver; shutdown fences late completion", async t => {
  let sends = 0, cleanups = 0, complete!: (response: PromptTurnResponse) => void, entered!: () => void;
  const polling = new Promise<void>(resolve => { entered = resolve; });
  const driver: GeminiBrowserAdapter = {
    checkStatus: async () => ({ browserState: "ready", accountState: "signed_in", checkedAt: new Date().toISOString() }),
    openBrowser: async () => ({ opened: true }),
    submitPrompt: async turnId => { sends++; return { turnId, status: "accepted", submittedAt: new Date().toISOString() }; },
    pollResponse: async () => { entered(); return new Promise(resolve => { complete = resolve; }); },
    cancelPrompt: async turnId => ({ turnId, cancelled: false }),
    cleanup: async () => { cleanups++; }, sendPrompt: async () => "unused",
  };
  const runtime = facade(t, { fixtureTurnDriver: driver });
  const prompt = "Fixture-only prompt";
  const turn = { workspaceId: "workspace", sessionId: "session", turnId: "turn", requestId: "request", prompt, queuedAt: Date.now(), payloadHash: SessionCoordinator.fingerprintPayload({ prompt }) };
  const pending = runtime.runFixtureTurn(turn);
  await polling;
  assert.equal(runtime.journal.get("turn", turn)?.phase, "streaming");
  assert.equal(sends, 1);
  const observed = pending.catch(error => error as UiError);
  await runtime.stop();
  assert.equal(runtime.journal.get("turn", turn)?.phase, "outcome_unknown");
  complete({ turnId: "turn", status: "completed", text: "late result", completedAt: new Date().toISOString() });
  assert.equal(((await observed) as UiError).code, "STALE_AUTHORITY");
  assert.equal(cleanups, 1);
  assert.equal(sends, 1);
});

test("G4 fix: browser cleanup still executes when coordinator persistence throws", async t => {
  class Browser extends LiveGeminiBrowserAdapter {
    cleanups = 0;
    override async cleanup() { this.cleanups++; }
  }
  const browser = new Browser({ chromePath: "C:\\does-not-exist.exe", debugPort: 59996 });
  const runtime = facade(t, { liveBrowserAdapter: browser });
  await runtime.start();
  const coordinator = runtime.getOrCreateCoordinator("workspace", "session");
  t.mock.method(coordinator, "handleDisconnection", () => { throw new Error("synthetic journal failure"); });
  await assert.rejects(runtime.stop(), code("SERVICE_UNAVAILABLE"));
  assert.equal(browser.cleanups, 1);
  // Restore for the explicit cleanup retry in the fixture finalizer.
  t.mock.reset();
  await runtime.stop();
});

test("G4 fix: account check on an unowned browser never attempts a CDP attachment", async t => {
  const browser = new OwnedBrowserAdapter({ debugPort: 59995 });
  t.mock.method(browser.driver, "inspectDom", () => { throw new Error("must not inspect another profile"); });
  const status = await browser.checkStatus();
  assert.equal(status.accountState, "unknown");
  assert.equal(browser.driver.isAttachedTarget, false);
});

test("G4 fix: occupied CDP port cannot make the launcher adopt or spawn a browser", async t => {
  const server = net.createServer(socket => socket.destroy());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const browser = new OwnedBrowserAdapter({ debugPort: (server.address() as net.AddressInfo).port });
  let launches = 0;
  t.mock.method(browser.driver, "launchOrAttach", async () => { launches++; return true; });
  assert.equal((await browser.openBrowser()).opened, false);
  assert.equal(launches, 0);
  assert.equal(browser.driver.isAttachedTarget, false);
});
