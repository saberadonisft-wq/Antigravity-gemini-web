import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveGeminiBrowserAdapter, GeminiBrowserDriver, CdpClient, isAllowedSurfaceUrl, type DomInspectionResult } from "./index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const dom: DomInspectionResult = {
  url: "http://127.0.0.1/app", origin: "http://127.0.0.1", pathname: "/app",
  title: "Synthetic", isAllowedSurface: true, hasComposer: true, hasSendButton: true,
  isGenerating: false, accountState: "signed_in", responseCount: 0,
  lastResponseText: "", hasCodeBlock: false,
};
const completed = { text: "Synthetic final answer", completed: true, cancelled: false, hasCodeBlock: false };

function readyAdapter() {
  const adapter = new LiveGeminiBrowserAdapter({ fixtureMode: true });
  let sends = 0;
  adapter.checkStatus = async () => ({ browserState: "ready", accountState: "signed_in", checkedAt: new Date().toISOString() });
  adapter.driver.inspectDom = async () => ({ ...dom });
  adapter.driver.inputPrompt = async () => true;
  adapter.driver.clickSend = async () => { sends++; return true; };
  adapter.driver.pollForResponse = async () => ({ ...completed });
  return { adapter, sends: () => sends };
}

test("Concurrent duplicates share submission and click Send exactly once", async () => {
  const { adapter, sends } = readyAdapter();
  const receipts = await Promise.all([adapter.submitPrompt("a", "same"), adapter.submitPrompt("a", "same")]);
  assert.equal(sends(), 1);
  assert.deepEqual(receipts[0], receipts[1]);
  await adapter.cleanup();
});

test("Concurrent different turns reserve one browser slot before status awaits", async () => {
  const { adapter, sends } = readyAdapter();
  const results = await Promise.allSettled([adapter.submitPrompt("a", "first"), adapter.submitPrompt("b", "second")]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const rejected = results.find(r => r.status === "rejected");
  assert.equal(rejected?.status === "rejected" ? rejected.reason.code : undefined, "BUSY");
  assert.equal(sends(), 1);
  await adapter.cleanup();
});

test("Concurrent conflicting content cannot overwrite the same turn ID", async () => {
  const { adapter, sends } = readyAdapter();
  const results = await Promise.allSettled([adapter.submitPrompt("a", "first"), adapter.submitPrompt("a", "different")]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].status === "rejected" ? results[1].reason.code : undefined, "CONFIG_CONFLICT");
  assert.equal(sends(), 1);
  await adapter.cleanup();
});

test("Failed input never becomes accepted on retry and thrown input releases the slot", async () => {
  for (const mode of ["false", "throw"] as const) {
    const { adapter, sends } = readyAdapter();
    adapter.driver.inputPrompt = async () => { if (mode === "throw") throw new Error("Synthetic input failure"); return false; };
    await assert.rejects(adapter.submitPrompt("failed", "same"));
    await assert.rejects(adapter.submitPrompt("failed", "same"));
    assert.equal(sends(), 0);
    adapter.driver.inputPrompt = async () => true;
    assert.equal((await adapter.submitPrompt("next", "new prompt")).status, "accepted");
    await adapter.cleanup();
  }
});

test("Uncertain Send failure blocks resubmission until cleanup", async () => {
  const { adapter, sends } = readyAdapter();
  adapter.driver.clickSend = async () => { throw new Error("Synthetic lost Send acknowledgement"); };
  await assert.rejects(adapter.submitPrompt("a", "first"));
  await assert.rejects(adapter.submitPrompt("a", "first"));
  await assert.rejects(adapter.submitPrompt("b", "new"), (error: { code?: string }) => error.code === "BUSY");
  assert.equal(sends(), 0);
  await adapter.cleanup();
});

test("Unconfirmed Stop false/throw cannot turn a normal response into cancelled", async () => {
  for (const mode of ["false", "throw"] as const) {
    const { adapter } = readyAdapter();
    await adapter.submitPrompt("a", "first");
    adapter.driver.clickStop = async () => { if (mode === "throw") throw new Error("Synthetic Stop failure"); return false; };
    assert.equal((await adapter.cancelPrompt("a")).cancelled, false);
    assert.equal((await adapter.pollResponse("a")).status, "completed");
    await adapter.cleanup();
  }
});

test("Confirmed cancellation stays terminal when an earlier poll resolves later", async () => {
  const { adapter } = readyAdapter();
  await adapter.submitPrompt("a", "first");
  const response = deferred<typeof completed>();
  const started = deferred<void>();
  adapter.driver.pollForResponse = () => { started.resolve(); return response.promise; };
  adapter.driver.clickStop = async () => true;
  const pending = adapter.pollResponse("a");
  await started.promise;
  assert.equal((await adapter.cancelPrompt("a")).cancelled, true);
  const terminal = await adapter.pollResponse("a");
  response.resolve({ ...completed });
  const late = await pending;
  assert.equal(terminal.status, "cancelled");
  assert.deepEqual(late, terminal);
  assert.deepEqual(await adapter.pollResponse("a"), terminal);
  await adapter.cleanup();
});

test("Concurrent polls coalesce and caller mutation cannot alter terminal state", async () => {
  const { adapter } = readyAdapter();
  await adapter.submitPrompt("a", "first");
  let polls = 0;
  adapter.driver.pollForResponse = async () => { polls++; return { ...completed }; };
  const [first, second] = await Promise.all([adapter.pollResponse("a"), adapter.pollResponse("a")]);
  assert.equal(polls, 1);
  assert.deepEqual(first, second);
  first.status = "cancelled";
  assert.equal((await adapter.pollResponse("a")).status, "completed");
  await adapter.cleanup();
});

test("Cancellation before acceptance never clicks Send", async () => {
  const { adapter, sends } = readyAdapter();
  const status = deferred<Awaited<ReturnType<LiveGeminiBrowserAdapter["checkStatus"]>>>();
  adapter.checkStatus = () => status.promise;
  const submission = adapter.submitPrompt("a", "first");
  const rejected = assert.rejects(submission);
  const cancellation = adapter.cancelPrompt("a");
  status.resolve({ browserState: "ready", accountState: "signed_in", checkedAt: new Date().toISOString() });
  assert.equal((await cancellation).cancelled, true);
  await rejected;
  assert.equal(sends(), 0);
  await adapter.cleanup();
});

test("Cleanup invalidates an in-flight poll instead of publishing a late completion", async () => {
  const { adapter } = readyAdapter();
  await adapter.submitPrompt("a", "first");
  const response = deferred<typeof completed>();
  const started = deferred<void>();
  adapter.driver.pollForResponse = () => { started.resolve(); return response.promise; };
  const pending = adapter.pollResponse("a");
  await started.promise;
  await adapter.cleanup();
  response.resolve({ ...completed });
  assert.equal((await pending).status, "failed");
});

test("Repeated open preserves ownership and does not replace a live CDP connection", async (t) => {
  const driver = new GeminiBrowserDriver();
  driver.isOwnedProcess = true;
  let browserCloses = 0;
  let disconnects = 0;
  const originalFind = CdpClient.findTarget;
  CdpClient.findTarget = async () => ({ id: "synthetic", type: "page", title: "Synthetic", url: "https://gemini.google.com/app", webSocketDebuggerUrl: "ws://127.0.0.1:1/synthetic" });
  t.after(() => { CdpClient.findTarget = originalFind; });
  const client = { isConnected: true, send: async () => { browserCloses++; return {}; }, close: () => { disconnects++; } } as unknown as CdpClient;
  driver.cdp = client;
  assert.equal(await driver.launchOrAttach(), true);
  assert.equal(driver.isOwnedProcess, true);
  assert.equal(driver.cdp, client);
  await driver.close();
  assert.equal(browserCloses, 1);
  assert.equal(disconnects, 1);
});

test("Surface policy rejects lookalike hosts, unrelated paths and implicit fixture origins", () => {
  assert.equal(isAllowedSurfaceUrl("https://gemini.google.com/app/owned"), true);
  assert.equal(isAllowedSurfaceUrl("https://gemini.google.com.example.invalid/app"), false);
  assert.equal(isAllowedSurfaceUrl("https://gemini.google.com/support"), false);
  assert.equal(isAllowedSurfaceUrl("http://127.0.0.1:1234/app", { fixtureMode: true }), false);
  assert.equal(isAllowedSurfaceUrl("http://127.0.0.1:1234/app", { fixtureMode: true, allowedOrigins: ["http://127.0.0.1:1234"] }), true);
  assert.equal(isAllowedSurfaceUrl("http://localhost.example.invalid/app", { fixtureMode: true, allowedOrigins: ["http://localhost"] }), false);
});

test("Close invalidates a queued open before it can attach or spawn", async (t) => {
  const driver = new GeminiBrowserDriver();
  let lookups = 0;
  const original = CdpClient.findTarget;
  CdpClient.findTarget = async () => { lookups++; return null; };
  t.after(() => { CdpClient.findTarget = original; });
  const opening = driver.launchOrAttach();
  await driver.close();
  assert.equal(await opening, false);
  assert.equal(lookups, 0);
  assert.equal(driver.isProcessAlive, false);
});
