import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GeminiBrowserAdapter, BrowserPollOptions, PromptTurnResponse } from "@antigravity-gemini-web/gemini-browser";
import { GeminiMcpService } from "./service.js";
import { removeOwnedFixture } from "./fixture-cleanup.js";

const revision = (c: string) => c.repeat(64);
function controlled() {
  const events: string[] = [];
  let finish!: (value: PromptTurnResponse) => void;
  let options: BrowserPollOptions | undefined;
  const adapter: GeminiBrowserAdapter = {
    supportsRetainedConversations: true, supportsProgressStreaming: true,
    checkStatus: async () => ({ browserState: "ready", accountState: "signed_in", checkedAt: new Date().toISOString() }),
    openBrowser: async () => ({ opened: true }),
    selectModel: async policy => { events.push("select"); return { effort: policy.effort, model: policy.model }; },
    openFreshConversation: async () => { events.push("create"); return { close: async () => { events.push("close"); }, suspend: async () => { events.push("suspend"); }, resume: async () => { events.push("resume"); } }; },
    submitPrompt: async turnId => { events.push("send"); return { turnId, status: "accepted", submittedAt: new Date().toISOString() }; },
    pollResponse: async (_id, value) => { options = value; return new Promise(resolve => { finish = resolve; }); },
    cancelPrompt: async turnId => ({ turnId, cancelled: false }), cleanup: async () => {}, sendPrompt: async () => "unused",
  };
  return { adapter, events, finish: () => finish({ turnId: "fixture", status: "completed", text: "fixture reply", completedAt: new Date().toISOString() }), progress: () => options!.onProgress!({ revision: 1, elapsedMs: 10, silentMs: 0, stage: "responding", text: "partial" }) };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("A terminal persistence failure still allows owned cleanup without reopening submission", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-test-")), browser = controlled();
  const service = new GeminiMcpService(browser.adapter, path.join(root, "ledger.json"));
  t.after(async () => { await service.close(); removeOwnedFixture(root); });
  browser.adapter.openFreshConversation = async () => ({
    close: async () => { browser.events.push("close"); }, suspend: async () => {}, resume: async () => {},
    preserve: async () => { browser.events.push("preserve"); },
  });
  const receipts = (service as unknown as { receipts: { transition(...args: unknown[]): void } }).receipts;
  const transition = receipts.transition.bind(receipts);
  receipts.transition = (...args) => { if (args[1] === "terminal") throw Error("Synthetic terminal write failure"); transition(...args); };
  await service.submit("request_faulted_cleanup", "synthetic", { conversation: { key: "faulted_cleanup_key", revision: revision("a") } });
  await tick(); browser.finish();
  assert.equal((await service.result("request_faulted_cleanup", 1000)).error?.code, "LEDGER_UNAVAILABLE");
  await assert.rejects(service.status(), { code: "SERVICE_UNAVAILABLE" });
  assert.deepEqual(await service.releaseConversation("faulted_cleanup_key", true), { released: true, preserved: true });
  assert.deepEqual(await service.releaseConversation("faulted_cleanup_key", true), { released: false });
  await assert.rejects(service.submit("request_faulted_resend", "must stay fenced"), { code: "SERVICE_UNAVAILABLE" });
  assert.equal(browser.events.filter(event => event === "send").length, 1);
  assert.equal(browser.events.filter(event => event === "preserve").length, 1);
});

test("A busy profile ignores cleanup of an unknown conversation and exposes actual release work as busy",async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"gemini-mcp-test-")),browser=controlled();
  let finishClose!:()=>void;const closing=new Promise<void>(resolve=>{finishClose=resolve;});
  browser.adapter.openFreshConversation=async()=>({suspend:async()=>{},resume:async()=>{},close:async()=>{await closing;}});
  const service=new GeminiMcpService(browser.adapter,path.join(root,"ledger.json"));t.after(async()=>{finishClose();await service.close();removeOwnedFixture(root);});
  await service.submit("cleanup_fixture_001","synthetic",{conversation:{key:"owned_fixture_key",revision:revision("a")}});for(let i=0;i<5;i++)await tick();
  assert.deepEqual(await service.releaseConversation("another_account_key"),{released:false});await assert.rejects(service.releaseConversation("owned_fixture_key"),{code:"BUSY"});
  browser.finish();assert.equal((await service.result("cleanup_fixture_001",1000)).status,"completed");
  const release=service.releaseConversation("owned_fixture_key");await tick();assert.equal((await service.status()).browserOperationActive,true);
  assert.deepEqual(await service.releaseConversation("another_account_key"),{released:false});
  await assert.rejects(service.submit("cleanup_fixture_002","must wait"),{code:"BUSY"});finishClose();await release;assert.equal((await service.status()).browserOperationActive,false);
});

test("Explicit resume adopts the exact URL once, then uses revision-bound continuation; absent targets never create tabs", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-test-")); const browser = controlled();
  const service = new GeminiMcpService(browser.adapter, path.join(root, "ledger.json"));
  t.after(async () => { await service.close(); removeOwnedFixture(root); });
  const url = "https://gemini.google.com/app/selected_chat";
  browser.adapter.openExistingConversation = async selected => {
    assert.equal(selected, url); browser.events.push("adopt");
    return { close: async () => {}, suspend: async () => {}, resume: async () => { browser.events.push("resume"); } };
  };
  await service.submit("request_adopt", "full authoritative rebind", { conversation: { key: "adopted_chat", revision: revision("a"), resumeUrl: url } });
  await tick(); browser.finish(); assert.equal((await service.result("request_adopt", 1000)).conversationReused, true);
  await service.submit("request_continue", "delta", { conversation: { key: "adopted_chat", revision: revision("b"), baseRevision: revision("a") } });
  await tick(); browser.finish(); await service.result("request_continue", 1000);
  assert.deepEqual(browser.events, ["adopt", "send", "resume", "send"]);
  await assert.rejects(service.submit("request_invalid_adopt", "delta", { conversation: { key: "adopted_chat", revision: revision("c"), baseRevision: revision("b"), resumeUrl: url } }), { code: "INVALID_RESUME" });
  browser.adapter.openExistingConversation = async () => { throw Error("target missing"); };
  await service.submit("request_missing_adopt", "full", { conversation: { key: "missing_chat", revision: revision("a"), resumeUrl: url } });
  assert.equal((await service.result("request_missing_adopt", 1000)).status, "failed");
  assert.equal(browser.events.includes("create"), false); assert.equal(browser.events.filter(x => x === "send").length, 2);
});

test("Failed retained tasks preserve stopped tabs and fence their revision; unsafe preservation falls back to close", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-test-")); const browser = controlled();
  const service = new GeminiMcpService(browser.adapter, path.join(root, "ledger.json"));
  t.after(async () => { await service.close(); removeOwnedFixture(root); });
  let unsafe = false;
  browser.adapter.openFreshConversation = async () => ({ close: async () => { browser.events.push("close"); }, suspend: async () => {}, resume: async () => {}, preserve: async () => { if (unsafe) throw Error("unsettled"); browser.events.push("preserve"); } });
  browser.adapter.selectModel = async () => { throw { code: "MODEL_UNAVAILABLE" }; };
  await service.submit("request_preserve", "fixture", { conversation: { key: "owned_preserve", revision: revision("a") }, modelSelection: { model: "missing" } });
  assert.equal((await service.result("request_preserve", 1000)).status, "failed");
  assert.deepEqual(browser.events, ["preserve"]);
  await assert.rejects(service.submit("request_resume_preserved", "delta", { conversation: { key: "owned_preserve", revision: revision("b"), baseRevision: revision("a") } }), { code: "CONVERSATION_CHANGED" });
  unsafe = true;
  await service.submit("request_unsafe", "fixture", { conversation: { key: "owned_unsafe", revision: revision("a") }, modelSelection: { model: "missing" } });
  assert.equal((await service.result("request_unsafe", 1000)).status, "failed");
  assert.deepEqual(browser.events, ["preserve", "close"]);
});

test("Native post-parse failure can retire an idle successful lease without closing its visible page", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-test-")); const browser = controlled();
  const original = browser.adapter.openFreshConversation!;
  browser.adapter.openFreshConversation = async () => ({ ...await original(), preserve: async () => { browser.events.push("preserve"); } });
  const service = new GeminiMcpService(browser.adapter, path.join(root, "ledger.json"));
  t.after(async () => { await service.close(); removeOwnedFixture(root); });
  await service.submit("request_parse_failure", "fixture", { conversation: { key: "owned_parse_failure", revision: revision("a") } });
  await tick(); browser.finish(); await service.result("request_parse_failure", 1000);
  assert.deepEqual(await service.releaseConversation("owned_parse_failure", true), { released: true, preserved: true });
  await service.close(); assert.equal(browser.events.includes("close"), false);
});

test("Revision-bound retained turns reuse a lease, expose progress, reject stale deltas and retire only owned targets", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-test-")); const browser = controlled();
  const service = new GeminiMcpService(browser.adapter, path.join(root, "ledger.json"));
  t.after(async () => { await service.close(); removeOwnedFixture(root); });
  const policy = { model: "4 Argon", effort: "Low" };
  await service.submit("request_first", "full context", { conversation: { key: "owned_conversation", revision: revision("a") }, modelSelection: policy });
  await tick();
  const waiting = service.result("request_first", 1000, 0); browser.progress();
  assert.equal((await waiting).progress!.text, "partial");
  browser.finish(); const first = await service.result("request_first", 1000); assert.equal(first.status, "completed"); assert.equal(first.conversationReused, false);
  assert.deepEqual(first.verifiedModel, policy); assert.deepEqual(browser.events, ["create", "select", "send", "suspend"]);
  await assert.rejects(service.submit("request_stale", "bad suffix", { conversation: { key: "owned_conversation", revision: revision("b"), baseRevision: revision("c") } }), { code: "CONVERSATION_CHANGED" });
  assert.equal(browser.events.filter(x => x === "send").length, 1);
  await service.submit("request_second", "only suffix", { conversation: { key: "owned_conversation", revision: revision("b"), baseRevision: revision("a") }, modelSelection: policy });
  await tick(); browser.finish(); assert.equal((await service.result("request_second", 1000)).conversationReused, true);
  assert.equal(browser.events.filter(x => x === "create").length, 1); assert.ok(browser.events.includes("resume"));
  assert.equal((await service.releaseConversation("owned_conversation")).released, true); assert.equal(browser.events.at(-1), "close");
  const ledger = fs.readFileSync(path.join(root, "ledger.json"), "utf8"); assert.ok(!ledger.includes("full context")); assert.ok(!ledger.includes("partial"));
});

test("A failed Stop cannot trap an owned request in pending or prevent the next turn, and late progress stays fenced", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-test-")); const browser = controlled();
  const service = new GeminiMcpService(browser.adapter, path.join(root, "ledger.json"));
  t.after(async () => { await service.close(); removeOwnedFixture(root); });
  await service.submit("request_cancel", "fixture", { freshConversation: true }); await tick();
  assert.equal((await service.cancel("request_cancel")).cancelled, false);
  assert.equal((await service.result("request_cancel", 1000)).status, "failed");
  assert.ok(browser.events.includes("close")); assert.equal((await service.status()).activeRequestId, null);
  browser.progress(); browser.finish(); await tick();
  assert.equal((await service.result("request_cancel")).status, "failed");
  await service.submit("request_after_cancel", "new authorized fixture", { freshConversation: true }); await tick(); browser.finish();
  assert.equal((await service.result("request_after_cancel", 1000)).status, "completed");
});

test("Invalid budgets reserve no retained slot, and failed checkpoint cannot become a completed result", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-test-")); const browser = controlled();
  const service = new GeminiMcpService(browser.adapter, path.join(root, "ledger.json"));
  t.after(async () => { await service.close(); removeOwnedFixture(root); });
  await assert.rejects(service.submit("request_invalid", "x", { conversation: { key: "owned_invalid", revision: revision("a") }, stallTimeoutMs: -1 }), { code: "INVALID_DEADLINE" });
  assert.equal((await service.status()).retainedConversations, 0);
  browser.adapter.openFreshConversation = async () => ({ close: async () => { browser.events.push("close"); }, resume: async () => {}, suspend: async () => { throw Error("checkpoint failed"); } });
  await service.submit("request_checkpoint", "x", { conversation: { key: "owned_checkpoint", revision: revision("a") } }); await tick(); browser.finish();
  assert.equal((await service.result("request_checkpoint", 1000)).status, "failed"); assert.ok(browser.events.includes("close"));
});

test("Model failure diagnostics retain only bounded stage metadata, never raw driver messages or arbitrary fields", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-test-")); const browser = controlled();
  const service = new GeminiMcpService(browser.adapter, path.join(root, "ledger.json"));
  t.after(async () => { await service.close(); removeOwnedFixture(root); });
  const diagnostic = { stage: "choose_effort" as const, verificationOnly: true };
  browser.adapter.selectModel = async () => { throw { code: "MODEL_UNAVAILABLE", message: "PRIVATE_DRIVER_DATA", modelSelection: diagnostic }; };
  await service.submit("request_diagnostic", "fixture", { freshConversation: true, modelSelection: { model: "4 Argon", effort: "Low" } });
  const failure = await service.result("request_diagnostic", 1000);
  assert.equal(failure.status, "failed"); assert.deepEqual(failure.error?.modelSelection, diagnostic);
  assert.ok(!JSON.stringify(failure).includes("PRIVATE_DRIVER_DATA"));
  browser.adapter.selectModel = async () => { throw { code: "MODEL_UNAVAILABLE", modelSelection: { ...diagnostic, rawPrompt: "PRIVATE_DRIVER_DATA" } }; };
  await service.submit("request_bad_diagnostic", "fixture", { freshConversation: true, modelSelection: { model: "4 Argon", effort: "Low" } });
  assert.equal((await service.result("request_bad_diagnostic", 1000)).error?.modelSelection, undefined);
  assert.equal(browser.events.includes("send"), false);
  assert.ok(!fs.readFileSync(path.join(root, "ledger.json"), "utf8").includes("PRIVATE_DRIVER_DATA"));
});
