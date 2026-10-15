import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GeminiBrowserAdapter } from "@antigravity-gemini-web/gemini-browser";
import { GeminiMcpService, MAX_BROWSER_PROMPT_CHARS } from "./service.js";
import { removeOwnedFixture } from "./fixture-cleanup.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function browser(): GeminiBrowserAdapter {
  return {
    checkStatus: async () => ({ browserState: "ready", accountState: "signed_in", checkedAt: new Date().toISOString() }),
    openBrowser: async () => ({ opened: true }),
    submitPrompt: async turnId => ({ turnId, status: "accepted", submittedAt: new Date().toISOString() }),
    pollResponse: async turnId => ({ turnId, status: "completed", text: "BOUND_REPLY", completedAt: new Date().toISOString() }),
    cancelPrompt: async turnId => ({ turnId, cancelled: false }),
    cleanup: async () => {},
    sendPrompt: async () => { throw Error("Unused"); },
  };
}
test("Fresh browser result stays pending until tab cleanup; duplicate requests own one isolated lease", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-test-"));
  const adapter = browser(), closing = deferred(), seen = deferred();
  let opened = 0, sends = 0;
  adapter.openFreshConversation = async () => { opened++; return { close: async () => { seen.resolve(); await closing.promise; } }; };
  adapter.submitPrompt = async turnId => { sends++; return { turnId, status: "accepted", submittedAt: new Date().toISOString() }; };
  const service = new GeminiMcpService(adapter, path.join(root, "receipts.json"));
  t.after(async () => { closing.resolve(); await service.close(); removeOwnedFixture(root); });
  const prompt = "x".repeat(40000);
  await Promise.all([service.submit("native_fixture_001", prompt, { freshConversation: true }), service.submit("native_fixture_001", prompt, { freshConversation: true })]);
  await seen.promise;
  assert.equal((await service.result("native_fixture_001")).status, "pending");
  await assert.rejects(service.submit("native_fixture_001", prompt), { code: "CONFIG_CONFLICT" });
  closing.resolve();
  assert.equal((await service.result("native_fixture_001", 100)).text, "BOUND_REPLY");
  assert.equal(opened, 1); assert.equal(sends, 1);
  assert.equal(fs.readFileSync(path.join(root, "receipts.json"), "utf8").includes(prompt), false);
  await assert.rejects(service.submit("native_fixture_big", "x".repeat(MAX_BROWSER_PROMPT_CHARS + 1)));
});

test("Cancellation during fresh-tab initialization is confirmed before Send and still closes its tab", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-test-"));
  const adapter = browser(), prepared = deferred(), ready = deferred();
  let sends = 0, closes = 0;
  adapter.openFreshConversation = async () => { prepared.resolve(); await ready.promise; return { close: async () => { closes++; } }; };
  adapter.submitPrompt = async () => { sends++; throw Error("Should never send"); };
  const service = new GeminiMcpService(adapter, path.join(root, "receipts.json"));
  t.after(async () => { ready.resolve(); await service.close(); removeOwnedFixture(root); });
  await service.submit("native_cancel_001", "cancel before Send", { freshConversation: true });
  await prepared.promise;
  assert.equal((await service.cancel("native_cancel_001")).cancelled, true);
  ready.resolve();
  assert.equal((await service.result("native_cancel_001", 100)).status, "cancelled");
  assert.equal(sends, 0); assert.equal(closes, 1);
});
