import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { AccountRegistry } from "./account-registry.js";
import { NativeBrowserBackendPool } from "./browser-backend-pool.js";
import { startNativeProxy } from "./native-proxy.js";
import { canonical, NativeRouteError, sha256, WEB_MODEL } from "./native-protocol.js";
import { NativeConversationState } from "./conversation-state.js";
import { ensureNativeBrowserReady, observedAccountFingerprint } from "./browser-readiness.js";

function temporary(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ag-account-safety-"));
  t.after(() => { assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith("ag-account-safety-")); fs.rmSync(directory, { recursive: true, force: true }); });
  return directory;
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { resolve, promise }; };
const envelope = (text = "synthetic review") => ({ model: WEB_MODEL, sessionId: "safety-session", conversationId: "safety-chat", request: { contents: [{ role: "user", parts: [{ text }] }], tools: [] } });
const reply = (prompt: string) => JSON.stringify({ nonce: /"nonce":"([a-f0-9]{48})"/.exec(prompt)![1], type: "final", text: "fixture complete" });
const post = (port: number, value = envelope()) => fetch(`http://127.0.0.1:${port}/v1internal:generateContent`, { method: "POST", headers: { authorization: "Bearer synthetic-caller", "content-type": "application/json" }, body: JSON.stringify(value) });
function fixtureRegistry(directory: string) {
  const filename = path.join(directory, "accounts.json"), registry = new AccountRegistry(filename);
  const add = (name: string, extra = {}) => registry.add({ displayName: name, profilePath: path.join(directory, name, "profile"), statePath: path.join(directory, name, "state"), ...extra });
  return { registry, filename, add };
}

test("Disabling every account survives restart and CLI bootstrap without re-enabling or duplicating profiles", t => {
  const { registry, filename, add } = fixtureRegistry(temporary(t)); const a = add("A");
  registry.disable(a.accountId);
  const restarted = new AccountRegistry(filename);
  assert.equal(restarted.getActive(), undefined);
  assert.equal(restarted.ensureDefault({ profilePath: a.profilePath, statePath: a.statePath }), undefined);
  assert.equal(restarted.list().length, 1);
  restarted.enable(a.accountId);
  assert.equal(new AccountRegistry(filename).getActive()?.accountId, a.accountId);
});

test("Registry stale writers retain additions, selection CAS and lock prevent lost updates", t => {
  const { registry, filename, add } = fixtureRegistry(temporary(t)); add("A");
  const stale = new AccountRegistry(filename); const before = stale.snapshot().revision;
  const b = add("B");
  stale.add({ displayName: "C", profilePath: filename + ".C-profile", statePath: filename + ".C-state" });
  assert.deepEqual(registry.list().map(a => a.displayName), ["A", "B", "C"]);
  assert.throws(() => stale.setActive(b.accountId, before), { code: "STALE_ACCOUNT_SELECTION" });
  const saved = fs.readFileSync(filename, "utf8");
  fs.writeFileSync(filename + ".lock", "another writer", { flag: "wx" });
  try { assert.throws(() => registry.disable(b.accountId), { code: "ACCOUNT_REGISTRY_BUSY" }); assert.equal(fs.readFileSync(filename, "utf8"), saved); }
  finally { fs.unlinkSync(filename + ".lock"); }
});

test("Invalid input and directory aliases never corrupt the saved registry", t => {
  const { registry, filename, add } = fixtureRegistry(temporary(t)); const a = add("CaseAccount"); const saved = fs.readFileSync(filename, "utf8");
  for (const debugPort of [0, NaN, 65536, 9224.5]) assert.throws(() => add("Invalid", { debugPort }), { code: "INVALID_ARGUMENT" });
  assert.throws(() => add("Other", { statePath: a.statePath }), { code: "ACCOUNT_STATE_CONFLICT" });
  assert.throws(() => add("Nested", { profilePath: path.join(a.profilePath, "child") }), { code: "ACCOUNT_PROFILE_CONFLICT" });
  if (process.platform === "win32") assert.throws(() => add("Alias", { profilePath: a.profilePath.toUpperCase() }), { code: "ACCOUNT_PROFILE_CONFLICT" });
  assert.equal(fs.readFileSync(filename, "utf8"), saved);
  assert.equal(new AccountRegistry(filename).list().length, 1);
});

test("Identity uses stable email, requires enrollment and rejects missing or ambiguous observations", async () => {
  const expected = sha256("a@example.com");
  assert.equal(observedAccountFingerprint("Google Account: Name (A@EXAMPLE.COM)"), expected);
  assert.equal(observedAccountFingerprint("Name only"), undefined);
  assert.equal(observedAccountFingerprint("a@example.com b@example.com"), undefined);
  const ready = { browserState: "ready", accountState: "signed_in" };
  for (const [identity, fingerprint, code] of [[undefined, expected, "ACCOUNT_IDENTITY_UNVERIFIED"], ["a@example.com", "", "ACCOUNT_IDENTITY_UNVERIFIED"], ["b@example.com", expected, "ACCOUNT_IDENTITY_CHANGED"]] as const) {
    await assert.rejects(ensureNativeBrowserReady(async () => ({ ...ready, accountIdentity: identity }), new AbortController().signal, 1000, fingerprint), { code, phase: "checkpoint", delivery: "not_sent" });
  }
  await ensureNativeBrowserReady(async () => ({ ...ready, accountIdentity: "a@example.com" }), new AbortController().signal, 1000, expected);
});

test("Explicit account verification enrolls once, changes epoch, and recreates the worker with its pinned identity", async t => {
  const { registry, add } = fixtureRegistry(temporary(t)); const a = add("A"); let observed = "a@example.com", closed = 0;
  const configs: Array<string | undefined> = [];
  const pool = new NativeBrowserBackendPool(registry, "unused", account => { configs.push(account.identityFingerprint); return { async inspectIdentity() { return { accountIdentity: observed }; }, async generate() { return "ok"; }, async close() { closed++; } }; });
  t.after(() => pool.close());
  const verified = await pool.verifyAccount(a.accountId, new AbortController().signal);
  assert.equal(verified.identityVerified, true); assert.equal(registry.get(a.accountId)?.identityEpoch, 1); assert.equal(closed, 1);
  const pinned = pool.bindAccount(a.accountId);
  assert.deepEqual(configs, [undefined, sha256("a@example.com")]);
  observed = "b@example.com";
  await assert.rejects(pool.verifyAccount(a.accountId, new AbortController().signal), { code: "ACCOUNT_IDENTITY_CHANGED" });
  registry.update(a.accountId, { identityFingerprint: sha256("b@example.com") });
  await assert.rejects(pinned.generate("r", "p", new AbortController().signal), { code: "ACCOUNT_IDENTITY_CHANGED", delivery: "not_sent" });
});

test("Account identity epochs never reuse a previous identity's revision or Web URL", t => {
  const file = path.join(temporary(t), "context.json"), task = sha256("epoch-task"), context = { contents: ["old"], tools: [] };
  const state = new NativeConversationState(5, file);
  const original = state.prepare(task, context, false, undefined, "acc_A", 1)!;
  state.complete(original, "https://gemini.google.com/app/old_identity");
  const restarted = new NativeConversationState(5, file);
  const changed = restarted.prepare(task, { ...context, contents: ["new"] }, false, undefined, "acc_A", 2)!;
  assert.equal(changed.mode, "full"); assert.equal(changed.baseRevision, undefined); assert.equal(changed.resumeUrl, undefined); assert.notEqual(changed.key, original.key);
  assert.throws(() => restarted.complete({ ...changed, identityEpoch: 1 }), { code: "STALE_AUTHORITY" });
});

test("Unknown-outcome replay stays fenced across restart and account switch, including requests without task IDs", async t => {
  for (const hasTask of [true, false]) {
    const directory = path.join(temporary(t), hasTask ? "scoped" : "unscoped"); fs.mkdirSync(directory);
    const { registry, add } = fixtureRegistry(directory); add("A",{identityFingerprint:sha256("A")}); const b = add("B",{identityFingerprint:sha256("B")}); const sends: string[] = [];
    const pool = () => new NativeBrowserBackendPool(registry, "unused", account => ({ async generate(_id, _prompt, _signal, options) { sends.push(account.displayName); options?.onSubmissionStarted?.(); throw new NativeRouteError("BROWSER_TURN_FAILED", "Synthetic unknown outcome.", 502); }, async close() {} }));
    const request = envelope(); if (!hasTask) { delete (request as Partial<typeof request>).sessionId; delete (request as Partial<typeof request>).conversationId; }
    let proxy = await startNativeProxy({ port: 0, backend: pool(), accountRegistry: registry, stateDirectory: directory });
    try { const first = await post(proxy.port, request); await first.text(); assert.equal(first.status, 502); }
    finally { await proxy.close(); }
    registry.setActive(b.accountId);
    proxy = await startNativeProxy({ port: 0, backend: pool(), accountRegistry: registry, stateDirectory: directory });
    try { const retry = await post(proxy.port, request); assert.equal(retry.status, 409); assert.match(await retry.text(), /OUTCOME_UNKNOWN/); assert.deepEqual(sends, ["A"]); }
    finally { await proxy.close(); }
  }
});

test("Slow account:disable control cannot switch a generation from its pinned worker", { timeout: 5000 }, async t => {
  const directory = temporary(t), { registry, add } = fixtureRegistry(directory), a = add("A",{identityFingerprint:sha256("A")}); add("B",{identityFingerprint:sha256("B")});
  const preparing = deferred(), release = deferred(), sends: string[] = [];
  const pool = new NativeBrowserBackendPool(registry, "unused", account => ({ async prepare() { preparing.resolve(); await release.promise; }, async generate(_id, prompt) { sends.push(account.displayName); return reply(prompt); }, async close() {} }));
  const proxy = await startNativeProxy({ port: 0, backend: pool, accountRegistry: registry, stateDirectory: directory, controlToken: "owned-test" });
  t.after(() => { release.resolve(); return proxy.close(); });
  const body = JSON.stringify({ action: "disable", accountId: a.accountId });
  const incoming = once(proxy.server, "request");
  const req = http.request({ hostname: "127.0.0.1", port: proxy.port, method: "POST", path: "/__native/account", headers: { "x-native-control-token": "owned-test", "content-type": "application/json", "content-length": Buffer.byteLength(body) } });
  const disabled = new Promise<number>(resolve => req.on("response", response => { response.resume(); response.on("end", () => resolve(response.statusCode!)); }));
  req.write(body.slice(0, 1)); await incoming;
  const generated = post(proxy.port); await preparing.promise;
  req.end(body.slice(1)); assert.equal(await disabled, 409); assert.equal(registry.getActive()?.accountId, a.accountId);
  release.resolve(); const response = await generated; assert.equal(response.status, 200); await response.text(); assert.deepEqual(sends, ["A"]);
});

test("Legacy unbound metadata is backed up, fences every account, and requires explicit recovery without replaying its old context", t => {
  const directory = temporary(t), filename = path.join(directory, "legacy.json"), task = sha256("legacy-task");
  const old = { contents: ["old request"], tools: [] }, revision = sha256(canonical(old)), url = "https://gemini.google.com/app/legacy_owned_chat";
  const legacy = JSON.stringify({ version: 1, entries: [{ taskKey: task, key: "conv_legacy", resumeUrl: url, pendingRevision: revision, outcomeUnknown: true, updatedAt: new Date().toISOString() }] });
  fs.writeFileSync(filename, legacy);
  const states = new NativeConversationState(5, filename);
  assert.equal(fs.readFileSync(filename + ".v1.backup", "utf8"), legacy);
  assert.equal(JSON.parse(fs.readFileSync(filename, "utf8")).version, 2);
  const next = { contents: ["old request", "explicit follow-up after inspection"], tools: [] };
  assert.throws(() => states.prepare(task, next, false, undefined, "acc_A", 1), { code: "OUTCOME_UNKNOWN" });
  assert.throws(() => states.prepare(task, old, true, url, "acc_A", 1), { code: "OUTCOME_UNKNOWN" });
  const plan = states.prepare(task, next, true, url, "acc_A", 1)!;
  assert.equal(plan.resumeUrl, url); states.complete(plan, url);
  const restarted = new NativeConversationState(5, filename);
  assert.throws(() => restarted.prepare(task, old, false, undefined, "acc_B", 1), { code: "OUTCOME_UNKNOWN" });
  const continued = restarted.prepare(task, { ...next, contents: [...next.contents, "new B turn"] }, false, undefined, "acc_B", 1)!;
  assert.equal(continued.mode, "full"); assert.equal(continued.resumeUrl, undefined);
});
