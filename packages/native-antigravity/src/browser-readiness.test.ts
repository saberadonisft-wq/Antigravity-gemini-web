import test from "node:test";
import assert from "node:assert/strict";
import { ensureNativeBrowserReady, type BrowserBrokerCall } from "./browser-readiness.js";
import { NativeRouteError } from "./native-protocol.js";

test("Native readiness opens a closed browser once and waits for the signed-in composer without submitting", async () => {
  const calls: string[] = [];
  const call: BrowserBrokerCall = async name => {
    calls.push(name);
    if (calls.length === 1) return { browserState: "closed", accountState: "unknown", activeRequestId: null };
    if (name === "gemini_open_browser") return { opened: true, browserState: "needs_user_action", accountState: "signed_in", activeRequestId: null };
    return { browserState: "ready", accountState: "signed_in", activeRequestId: null };
  };
  assert.equal((await ensureNativeBrowserReady(call, new AbortController().signal, 1000)).browserState, "ready");
  assert.deepEqual(calls, ["gemini_status", "gemini_open_browser", "gemini_status"]);
});

test("Native readiness never opens an already ready or busy browser and never automates sign-in", async () => {
  const ready = { browserState: "ready", accountState: "signed_in", activeRequestId: null };
  let calls = 0;
  await ensureNativeBrowserReady(async () => { calls++; return ready; }, new AbortController().signal);
  assert.equal(calls, 1);
  await assert.rejects(ensureNativeBrowserReady(async () => ({ ...ready, activeRequestId: "someone_else" }), new AbortController().signal), { code: "BUSY" });
  await assert.rejects(ensureNativeBrowserReady(async () => ({ ...ready, browserOperationActive:true }), new AbortController().signal), { code: "BUSY" });
  const seen: string[] = [];
  await assert.rejects(ensureNativeBrowserReady(async name => { seen.push(name); return { opened: true, browserState: "needs_user_action", accountState: "needs_user_action" }; }, new AbortController().signal), { code: "BROWSER_LOGIN_REQUIRED", status: 412 });
  assert.deepEqual(seen, ["gemini_status", "gemini_open_browser"]);
});

test("A saved temporary-model restoration opens the browser for recovery before readiness is granted", async () => {
  const calls: string[] = [];
  const status = await ensureNativeBrowserReady(async name => {
    calls.push(name);
    return { opened: true, browserState: "ready", accountState: "signed_in", activeRequestId: null, browserOperationActive: name === "gemini_status", modelRestorePending: name === "gemini_status" };
  }, new AbortController().signal);
  assert.equal(status.modelRestorePending, false);
  assert.deepEqual(calls, ["gemini_status", "gemini_open_browser"]);
});

test("Google traffic verification stops readiness without opening a new tab or suggesting a sign-in replay", async () => {
  const calls: string[] = [];
  await assert.rejects(ensureNativeBrowserReady(async name => {
    calls.push(name); return { browserState: "needs_user_action", accountState: "needs_user_action", browserActionRequired: "google_traffic_verification" };
  }, new AbortController().signal), { code: "BROWSER_USER_ACTION_REQUIRED", status: 412 });
  assert.deepEqual(calls, ["gemini_status"]);
});

test("Native readiness has a finite startup budget even if a broker ignores abort, and cancellation is not swallowed", { timeout: 1000 }, async () => {
  const started = performance.now();
  // AbortSignal.timeout is unref'ed, so keep the test process alive until it fires.
  const keepAlive = setTimeout(() => {}, 500);
  try {
    await assert.rejects(ensureNativeBrowserReady(async () => new Promise(() => {}), new AbortController().signal, 40), { code: "BROWSER_NOT_READY", status: 412 });
    assert.ok(performance.now() - started < 400);
    const controller = new AbortController(); let calls = 0;
    controller.abort(new NativeRouteError("CANCELLED", "cancelled", 499));
    await assert.rejects(ensureNativeBrowserReady(async () => { calls++; return {}; }, controller.signal), { code: "CANCELLED" });
    assert.equal(calls, 0);
  } finally { clearTimeout(keepAlive); }
});
