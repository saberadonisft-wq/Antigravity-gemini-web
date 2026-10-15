import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  JournalEntrySchema, type JournalEntry, type StructuredContext, type UiError,
} from "@antigravity-gemini-web/contracts";
import { ContextManager, RecoveryJournal, SessionCoordinator, type QueuedTurnItem } from "./index.js";
import { FakeRuntimeEngine } from "./fake-runtime.js";
import { LiveGeminiBrowserAdapter, type BrowserStatus } from "@antigravity-gemini-web/gemini-browser";

const hasCode = (code: string) => (error: unknown) => (error as UiError)?.code === code;
const context = (): StructuredContext => ({
  workspaceId: "workspace", sessionId: "session", instructions: "Keep all instructions.",
  history: [
    { role: "user", content: "First".repeat(30) },
    { role: "assistant", content: "Middle response" },
    { role: "user", content: "Last".repeat(30) },
  ],
  toolResults: [{ callId: "call", toolName: "read_file", output: "original output", isError: false }],
});
function item(id = "turn", prompt = "prompt", overrides: Partial<QueuedTurnItem> = {}): QueuedTurnItem {
  const result = { workspaceId: "workspace", sessionId: "session", turnId: id, requestId: "request-" + id, prompt, queuedAt: Date.now(), payloadHash: "", ...overrides };
  result.payloadHash = SessionCoordinator.fingerprintPayload(result);
  return result;
}
function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    version: 1, instanceId: "instance-old", workspaceId: "workspace", sessionId: "session",
    turnId: "turn", requestId: "request-turn", phase: "queued",
    payloadHash: RecoveryJournal.hashPayload("private payload"), timestamp: new Date().toISOString(), ...overrides,
  };
}
function tempJournal(t: TestContext): { journal: RecoveryJournal; file: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "g3-codex-"));
  t.after(() => {
    const resolved = fs.realpathSync(dir);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith("g3-codex-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const file = path.join(dir, "journal.jsonl");
  return { journal: new RecoveryJournal(file), file, dir };
}
function advance(c: SessionCoordinator, id: string, ...states: Parameters<SessionCoordinator["transitionActiveTurn"]>[1][]): void {
  for (const state of states) c.transitionActiveTurn(id, state, c.currentEpoch);
}

test("G3 fix: context fingerprint includes every value and preserves array order", () => {
  const manager = new ContextManager();
  const original = context();
  const hash = manager.fingerprint(original);
  for (const mutate of [
    (c: StructuredContext) => { c.history[1]!.content += "changed"; },
    (c: StructuredContext) => { c.history[0]!.content += "changed after character 50"; },
    (c: StructuredContext) => { c.toolResults[0]!.output += "changed"; },
    (c: StructuredContext) => { c.modelMetadata = { modelId: "verified-model", isEstimate: true }; },
    (c: StructuredContext) => { c.history.reverse(); },
  ]) {
    const changed = structuredClone(original); mutate(changed);
    assert.notEqual(manager.fingerprint(changed), hash);
  }
  const reordered = Object.fromEntries(Object.entries(original).reverse()) as StructuredContext;
  assert.equal(manager.fingerprint(reordered), hash);
  assert.equal(RecoveryJournal.hashPayload({ a: { b: 1, c: 2 } }), RecoveryJournal.hashPayload({ a: { c: 2, b: 1 } }));
  assert.equal(RecoveryJournal.hashPayload({ "é": 1, "é": 2 }), RecoveryJournal.hashPayload({ "é": 2, "é": 1 }));
});

test("G3 fix: opaque and POSIX workspace IDs remain distinct; Windows roots and session binding are safe", () => {
  const manager = new ContextManager();
  const c = context();
  assert.throws(() => manager.validateWorkspace({ ...c, workspaceId: "WORKSPACE" }, "workspace"), hasCode("WORKSPACE_MISMATCH"));
  assert.throws(() => manager.validateWorkspace({ ...c, workspaceId: "/Repo" }, "/repo"), hasCode("WORKSPACE_MISMATCH"));
  assert.doesNotThrow(() => manager.validateWorkspace({ ...c, workspaceId: "D:\\repo\\child\\.." }, "d:/repo"));
  assert.throws(() => manager.validateWorkspace({ ...c, workspaceId: "D:\\" }, "d:"), hasCode("WORKSPACE_MISMATCH"));
  assert.throws(() => manager.validateBinding(c, c.workspaceId, "foreign-session"), hasCode("STALE_AUTHORITY"));
});

test("G3 fix: full envelope budget, unknown model and invalid limits cannot bypass preflight", () => {
  const c = context();
  c.modelMetadata = { modelId: "expected-model", isEstimate: true, notes: "x".repeat(2000) };
  const manager = new ContextManager({ localSafetyCapTokens: 200, maxByteSize: 10000 });
  assert.throws(() => manager.assertWithinBudget(c), hasCode("CONTEXT_TOO_LARGE"));
  assert.throws(() => manager.verifyModelBinding(c, null), hasCode("REBIND_REQUIRED"));
  for (const invalid of [0, -1, NaN, Infinity, 1.5]) {
    assert.throws(() => new ContextManager({ localSafetyCapTokens: invalid }), RangeError);
    assert.throws(() => new SessionCoordinator({ workspaceId: "workspace", sessionId: "session", maxQueueSize: invalid }), RangeError);
  }
});

test("G3 fix: journal schema rejects raw hashes, unknown versions and inconsistent outcomes", () => {
  const base = entry();
  for (const invalid of [
    { ...base, payloadHash: "RAW_SECRET_TOKEN" },
    { ...base, version: 2 },
    { ...base, phase: "completed" },
    { ...base, terminalOutcome: { status: "completed", completedAt: base.timestamp } },
    { ...base, phase: "failed", terminalOutcome: { status: "completed", completedAt: base.timestamp } },
    { ...base, phase: "failed", terminalOutcome: { status: "failed", completedAt: base.timestamp, errorCode: "RAW_SECRET_TOKEN" } },
  ]) assert.equal(JournalEntrySchema.safeParse(invalid).success, false);
});

test("G3 fix: journal scopes duplicate turn IDs and protects terminal/cache immutability", t => {
  const { journal } = tempJournal(t);
  const first = entry();
  journal.record(first);
  journal.record({ ...first, sessionId: "other-session" });
  assert.equal(journal.getAll().length, 2);
  assert.throws(() => journal.get(first.turnId), hasCode("CONFIG_CONFLICT"));
  const terminal: JournalEntry = { ...first, phase: "cancelled", terminalOutcome: { status: "cancelled", completedAt: first.timestamp } };
  journal.record(terminal);
  assert.throws(() => journal.record(first), hasCode("STALE_AUTHORITY"));
  const copy = journal.get(first.turnId, first)!;
  copy.phase = "queued";
  assert.equal(journal.get(first.turnId, first)!.phase, "cancelled");
  const report = journal.loadAndReconcile("instance-new");
  for (const e of report.activeEntries.values()) e.phase = "queued";
  assert.equal(journal.get(first.turnId, first)!.phase, "cancelled");
});

test("G3 fix: failed atomic rename retains previous disk/cache state and removes own temp file", t => {
  const { journal, file, dir } = tempJournal(t);
  journal.record(entry());
  const before = fs.readFileSync(file, "utf8");
  t.mock.method(fs, "renameSync", () => { throw new Error("simulated file lock"); });
  assert.throws(() => journal.record(entry({ turnId: "new", requestId: "new" })), hasCode("SERVICE_UNAVAILABLE"));
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(journal.getAll().length, 1);
  assert.deepEqual(fs.readdirSync(dir), ["journal.jsonl"]);
});

test("G3 fix: corruption remains a durable replay blocker across repeated restarts", t => {
  const { journal, file } = tempJournal(t);
  journal.record(entry({ phase: "tool_running" }));
  fs.appendFileSync(file, "{truncated\n");
  const original = fs.readFileSync(file, "utf8");
  for (const runtimeId of ["restart-1", "restart-2"]) {
    const recovered = new RecoveryJournal(file);
    const report = recovered.loadAndReconcile(runtimeId);
    assert.equal(report.replayBlocked, true);
    assert.equal(report.corruptLinesEncountered, 1);
    assert.equal(recovered.get("turn")?.phase, "outcome_unknown");
    assert.throws(() => recovered.record(entry({ turnId: "new", instanceId: runtimeId })), hasCode("OUTCOME_UNKNOWN"));
    assert.equal(fs.readFileSync(file, "utf8"), original);
  }
});

test("G3 fix: unreadable recovery journal cannot be treated as an empty successful recovery", t => {
  const { journal, file } = tempJournal(t);
  const original = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]) === file) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return original(...args);
  });
  assert.throws(() => journal.loadAndReconcile("new"), hasCode("SERVICE_UNAVAILABLE"));
  assert.throws(() => journal.record(entry()), hasCode("OUTCOME_UNKNOWN"));
});

test("G3 fix: recovery classifies every ambiguous phase, even when the instance ID is reused", t => {
  const { journal, file } = tempJournal(t);
  const uncertain = ["submitting", "accepted", "generating", "streaming", "tool_pending", "tool_running", "cancel_requested"] as const;
  for (const phase of uncertain) journal.record(entry({ turnId: phase, requestId: phase, phase }));
  journal.record(entry({ turnId: "queued", requestId: "queued" }));
  const recovered = new RecoveryJournal(file);
  const report = recovered.loadAndReconcile("instance-old");
  assert.equal(report.unknownMutations.length, uncertain.length);
  assert.deepEqual(report.interruptedTurns, ["queued"]);
  assert.equal(report.replayBlocked, false);
});

test("G3 fix: retry/conflict/terminal deduplication permits exactly one dispatch in a process", () => {
  const c = new SessionCoordinator({ workspaceId: "workspace", sessionId: "session" });
  const request = item();
  let sends = 0;
  c.enqueue(request); c.enqueue({ ...request, queuedAt: request.queuedAt + 100 });
  assert.equal(c.queueDepth, 1);
  assert.throws(() => c.enqueue(item("turn", "changed prompt")), hasCode("CONFIG_CONFLICT"));
  assert.throws(() => c.enqueue(item("other", "prompt", { requestId: request.requestId })), hasCode("CONFIG_CONFLICT"));
  const dispatched = c.nextForExecution()!;
  sends++;
  dispatched.prompt = "caller mutation";
  assert.equal(SessionCoordinator.fingerprintPayload(request), request.payloadHash);
  c.enqueue(request);
  assert.equal(c.queueDepth, 0);
  assert.throws(() => c.transitionActiveTurn("turn", "completed", c.currentEpoch), hasCode("CONTRACT_MISMATCH"));
  advance(c, "turn", "submitting", "accepted", "completed");
  c.enqueue(request);
  assert.equal(c.nextForExecution(), null);
  assert.equal(sends, 1);
  assert.equal(c.transitionActiveTurn("turn", "streaming", c.currentEpoch), false);
  assert.equal(c.getTurnState("turn"), "completed");
});

test("G3 fix: cancelled tombstones, foreign sessions and full ledgers cannot create fresh work", () => {
  const c = new SessionCoordinator({ workspaceId: "workspace", sessionId: "session", maxLedgerSize: 1 });
  assert.throws(() => c.enqueue(item("foreign", "prompt", { sessionId: "other" })), hasCode("STALE_AUTHORITY"));
  c.enqueue(item());
  assert.equal(c.cancelQueued("turn"), true);
  c.enqueue(item());
  assert.equal(c.getTurnState("turn"), "cancelled");
  assert.equal(c.nextForExecution(), null);
  assert.throws(() => c.enqueue(item("new")), hasCode("QUEUE_FULL"));
});

test("G3 fix: context/session preflight executes on enqueue before any journal or executor dispatch", () => {
  const c = new SessionCoordinator({ workspaceId: "workspace", sessionId: "session", contextManager: new ContextManager({ localSafetyCapTokens: 100 }) });
  const wrong = context(); wrong.sessionId = "other";
  assert.throws(() => c.enqueue(item("foreign-context", "prompt", { context: wrong })), hasCode("STALE_AUTHORITY"));
  assert.throws(() => c.enqueue(item("large", "x".repeat(1000))), hasCode("CONTEXT_TOO_LARGE"));
  assert.equal(c.queueDepth, 0);
  assert.equal(c.nextForExecution(), null);
});

test("G3 fix: journal must commit before queued cancellation, reservation or dispatch can succeed", t => {
  const { journal } = tempJournal(t);
  const c = new SessionCoordinator({ workspaceId: "workspace", sessionId: "session", journal, runtimeInstanceId: "host-runtime" });
  c.enqueue(item());
  t.mock.method(journal, "record", () => { throw { code: "SERVICE_UNAVAILABLE", message: "disk unavailable", retryable: true } satisfies UiError; });
  assert.throws(() => c.cancelQueued("turn"), hasCode("SERVICE_UNAVAILABLE"));
  assert.throws(() => c.nextForExecution(), hasCode("SERVICE_UNAVAILABLE"));
  assert.throws(() => c.enqueue(item("new")), hasCode("SERVICE_UNAVAILABLE"));
  assert.equal(c.queueDepth, 1);
  assert.equal(c.isBusy, false);
  assert.equal(c.getTurnState("turn"), "queued");
});

test("G3 fix: disconnect fences tools and late results, marks tool mutation unknown and drains queued work", () => {
  const c = new SessionCoordinator({ workspaceId: "workspace", sessionId: "session", hostToolInventory: new Set(["read_file"]) });
  c.enqueue(item()); c.enqueue(item("queued"));
  c.nextForExecution();
  advance(c, "turn", "submitting", "accepted", "tool_pending", "tool_running");
  const authority = c.getActiveAuthority()!;
  c.handleDisconnection("synthetic CDP failure");
  assert.equal(c.getTurnState("turn"), "outcome_unknown");
  assert.equal(c.getTurnState("queued"), "interrupted");
  assert.equal(c.queueDepth, 0);
  assert.equal(c.nextForExecution(), null);
  assert.throws(() => c.verifyHostToolAuthority("read_file", authority), hasCode("STALE_AUTHORITY"));
  assert.throws(() => c.transitionActiveTurn("turn", "completed", authority.epoch), hasCode("STALE_AUTHORITY"));
  assert.throws(() => c.enqueue(item("new")), hasCode("SERVICE_UNAVAILABLE"));
  const beforeSend = new SessionCoordinator({ workspaceId: "workspace", sessionId: "session" });
  beforeSend.enqueue(item()); beforeSend.nextForExecution(); beforeSend.handleDisconnection("lost before Send");
  assert.equal(beforeSend.getTurnState("turn"), "interrupted");
});

test("G3 fix: host inventory is deny-by-default, copied and bound to every authority field", () => {
  const inventory = new Set(["read_file"]);
  const c = new SessionCoordinator({ workspaceId: "workspace", sessionId: "session", hostToolInventory: inventory });
  inventory.add("run_test");
  c.enqueue(item()); c.nextForExecution();
  advance(c, "turn", "submitting", "accepted", "tool_pending");
  const authority = c.getActiveAuthority()!;
  assert.doesNotThrow(() => c.verifyHostToolAuthority("read_file", authority));
  assert.throws(() => c.verifyHostToolAuthority("run_test", authority), hasCode("TOOL_DENIED"));
  for (const key of Object.keys(authority) as (keyof typeof authority)[]) {
    const wrong = { ...authority, [key]: key === "epoch" ? 99 : "foreign" };
    assert.throws(() => c.verifyHostToolAuthority("read_file", wrong), hasCode("STALE_AUTHORITY"));
  }
  const denied = new SessionCoordinator({ workspaceId: "workspace", sessionId: "session" });
  denied.enqueue(item()); denied.nextForExecution();
  advance(denied, "turn", "submitting", "accepted", "tool_pending");
  assert.throws(() => denied.verifyHostToolAuthority("read_file", denied.getActiveAuthority()!), hasCode("TOOL_DENIED"));
});

test("G3 fix: coordinator restart restores tombstones without re-sending any accepted mutation", t => {
  const { journal, file } = tempJournal(t);
  const c = new SessionCoordinator({ workspaceId: "workspace", sessionId: "session", journal });
  const request = item();
  c.enqueue(request); c.nextForExecution();
  advance(c, "turn", "submitting", "accepted", "streaming");
  const restarted = new SessionCoordinator({ workspaceId: "workspace", sessionId: "session", journal: new RecoveryJournal(file) });
  assert.notEqual(restarted.runtimeInstanceId, c.runtimeInstanceId);
  assert.equal(restarted.getTurnState("turn"), "outcome_unknown");
  restarted.enqueue(request);
  assert.equal(restarted.nextForExecution(), null);
  assert.equal(restarted.queueDepth, 0);
  assert.throws(() => restarted.enqueue(item("new")), hasCode("SERVICE_UNAVAILABLE"));
});

class ControlledBrowser extends LiveGeminiBrowserAdapter {
  status: BrowserStatus = { browserState: "needs_user_action", accountState: "needs_user_action", checkedAt: new Date().toISOString() };
  constructor() { super({ chromePath: "C:\\nonexistent-test-browser.exe", debugPort: 59997 }); }
  override async checkStatus(): Promise<BrowserStatus> { return structuredClone(this.status); }
  override async openBrowser() { return { opened: true }; } // controlled fixture only; no browser process
}

test("G3 live truth: initial live snapshot cannot inherit demo model, capability or host metadata", () => {
  const engine = new FakeRuntimeEngine("tool_running", "live", { liveBrowserAdapter: new ControlledBrowser() });
  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.mode, "live");
  assert.equal(snapshot.integration.hostVersion, undefined);
  assert.equal(snapshot.selectedModelId, null);
  assert.deepEqual(snapshot.availableModels, []);
  assert.deepEqual(snapshot.sessions, []);
  assert.equal(Object.values(snapshot.capabilities).some(c => c.state === "available"), false);
});

test("G3 live truth: opening a browser preserves login/action state and account check refreshes browser errors", async () => {
  const browser = new ControlledBrowser();
  const engine = new FakeRuntimeEngine("first_run", "live", { liveBrowserAdapter: browser });
  const opened = await engine.execute({ requestId: "open", type: "browser.open", payload: {} });
  assert.equal(opened.accepted, true);
  assert.equal(engine.getSnapshot().browser.state, "needs_user_action");
  assert.equal(engine.getSnapshot().account.state, "needs_user_action");
  browser.status = { browserState: "failed", accountState: "unknown", checkedAt: new Date().toISOString(), error: { code: "BROWSER_UI_CHANGED", message: "Synthetic changed UI", retryable: false } };
  await engine.execute({ requestId: "check-account", type: "account.check", payload: {} });
  assert.equal(engine.getSnapshot().browser.state, "failed");
  assert.equal(engine.getSnapshot().browser.error?.code, "BROWSER_UI_CHANGED");
});

test("G3 live truth: diagnostics distinguish an observed browser from account login and unmeasured host", async () => {
  const browser = new ControlledBrowser();
  browser.status.browserState = "ready";
  browser.status.accountState = "signed_out";
  const engine = new FakeRuntimeEngine("first_run", "live", { liveBrowserAdapter: browser });
  const ack = await engine.execute({ requestId: "diagnostic", type: "runtime.check", payload: { scope: "connection" } });
  assert.equal(ack.accepted, true); // completion of the check, not success of every checked gate
  const checks = engine.getSnapshot().lastCheck!.checks;
  assert.equal(checks.find(c => c.key === "host")?.status, "not_run");
  assert.equal(checks.find(c => c.key === "browser")?.status, "passed");
  assert.equal(checks.find(c => c.key === "account")?.status, "failed");
  assert.equal(checks.find(c => c.key === "tools")?.status, "not_run");
  assert.equal(engine.getSnapshot().integration.hostVersion, undefined);
});

test("G3 live truth: model selection needs a real provider and demo selection is blocked during active work", async () => {
  const live = new FakeRuntimeEngine("first_run", "live", { liveBrowserAdapter: new ControlledBrowser() });
  const ack = await live.execute({ requestId: "select-live", type: "model.select", payload: { modelId: "gemini-3.8-flash-high" } });
  assert.equal(ack.accepted, false);
  if (!ack.accepted) assert.equal(ack.error.code, "MODEL_UNAVAILABLE");
  const demo = new FakeRuntimeEngine("tool_running", "demo");
  const busy = await demo.execute({ requestId: "select-busy", type: "model.select", payload: { modelId: demo.getSnapshot().availableModels[0]!.id } });
  assert.equal(busy.accepted, false);
  if (!busy.accepted) assert.equal(busy.error.code, "BUSY");
});
