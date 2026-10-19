import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
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

test("Receipt correlation survives restart and inspection never calls browser readiness or resends", async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"gemini-mcp-test-")),ledger=path.join(root,"receipts.json"),adapter=browser();
  const nativeOwner={logicalRequestId:"native_"+"a".repeat(64),logicalAttemptId:randomUUID(),accountId:"acc_A",identityEpoch:2};
  const first=new GeminiMcpService(adapter,ledger);let second:GeminiMcpService|undefined;
  t.after(async()=>{await first.close();await second?.close();removeOwnedFixture(root);});
  await first.submit("receipt_owner_001","synthetic",{nativeOwner});assert.equal((await first.result("receipt_owner_001",1000)).status,"completed");
  assert.deepEqual((await first.inspectReceipt("receipt_owner_001")).receipt?.owner,nativeOwner);
  await assert.rejects(first.submit("receipt_owner_001","synthetic",{nativeOwner:{...nativeOwner,logicalAttemptId:randomUUID()}}),{code:"CONFIG_CONFLICT"});await first.close();
  adapter.checkStatus=async()=>{throw Error("Read-only receipt inspection must not touch the browser");};adapter.submitPrompt=async()=>{throw Error("No Send permitted");};
  second=new GeminiMcpService(adapter,ledger);
  const result=await second.inspectReceipt("receipt_owner_001");assert.deepEqual(result.receipt?.owner,nativeOwner);assert.equal(result.resultAvailable,false);assert.equal(result.replayAllowed,false);
  assert.equal((await second.inspectReceipt("receipt_missing_001")).found,false);
});

test("Account fingerprint reaches the browser at Send, participates in request identity and preserves proven not_sent delivery", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-test-")), adapter = browser();
  const fingerprint = "a".repeat(64); let observed: string | undefined;
  adapter.submitPrompt = async (_id, _text, options) => { observed = options?.expectedAccountFingerprint; throw { code: "ACCOUNT_IDENTITY_CHANGED", message: "Synthetic mismatch before click.", delivery: "not_sent", retryable: false }; };
  const service = new GeminiMcpService(adapter, path.join(root, "receipts.json"));
  t.after(async () => { await service.close(); removeOwnedFixture(root); });
  await service.submit("identity_guard_001", "synthetic only", { expectedAccountFingerprint: fingerprint });
  const result = await service.result("identity_guard_001", 1000);
  assert.equal(observed, fingerprint); assert.equal(result.status, "failed"); assert.equal(result.delivery, "not_sent"); assert.equal(result.error?.code, "ACCOUNT_IDENTITY_CHANGED");
  await assert.rejects(service.submit("identity_guard_001", "synthetic only", { expectedAccountFingerprint: "b".repeat(64) }), { code: "CONFIG_CONFLICT" });
});

test("Submission diagnostics accept only bounded structural fields and never copy arbitrary driver payloads", async t => {
  for (const extra of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-test-")), adapter = browser();
    const diagnostic = { inputChars: 12, readbackVerified: true, sendClickAttempted: false, acceptanceObserved: false };
    adapter.submitPrompt = async () => { throw { code: "INPUT_FAILED", message: "private raw driver message", delivery: "not_sent", submissionDiagnostic: { ...diagnostic, ...(extra ? { rawPrompt: "DO_NOT_COPY" } : {}) } }; };
    const service = new GeminiMcpService(adapter, path.join(root, "receipts.json"));
    t.after(async () => { await service.close(); removeOwnedFixture(root); });
    await service.submit("diagnostic_" + (extra ? "extra" : "valid"), "synthetic");
    const result = await service.result("diagnostic_" + (extra ? "extra" : "valid"), 1000);
    assert.deepEqual(result.submissionDiagnostic, extra ? undefined : diagnostic);
    assert.ok(!JSON.stringify(result).includes("DO_NOT_COPY")); assert.ok(!JSON.stringify(result).includes("private raw driver message"));
  }
});
test("Fresh browser result stays pending until tab cleanup; duplicate requests own one isolated lease", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-test-"));
  const adapter = browser(), closing = deferred(), seen = deferred();
  let opened = 0, sends = 0;
  adapter.openFreshConversation = async () => { opened++; return { close: async () => { seen.resolve(); await closing.promise; } }; };
  adapter.submitPrompt = async turnId => { sends++; return { turnId, status: "accepted", submittedAt: new Date().toISOString() }; };
  const service = new GeminiMcpService(adapter, path.join(root, "receipts.json"));
  t.after(async () => { closing.resolve(); await service.close(); removeOwnedFixture(root); });
  const prompt = "x".repeat(MAX_BROWSER_PROMPT_CHARS);
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


test("Snapshot payload participates in durable request identity, validates before reserve and never persists file contents", async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"gemini-mcp-test-")), adapter=browser();
  const ledger=path.join(root,"receipts.json"); let sends=0, content="";
  adapter.supportsNativeSnapshotAttachment=true;adapter.supportsNativeSnapshotFileRetention=true;
  adapter.openFreshConversation=async()=>({close:async()=>{}});
  adapter.submitPrompt=async(turnId,_prompt,options)=>{sends++;content=options?.snapshotAttachment?.content??"";return {turnId,status:"accepted",submittedAt:new Date().toISOString()};};
  const snapshot=(text:string)=>{const sha256=createHash("sha256").update(text).digest("hex");return {version:1 as const,mediaType:"text/plain" as const,fileName:`ag-native-context-${sha256}.txt`,sha256,content:text};};
  const options={freshConversation:true,expectedAccountFingerprint:"a".repeat(64),snapshotAttachment:snapshot("PRIVATE_SYNTHETIC_CONTEXT_😀")};
  const service=new GeminiMcpService(adapter,ledger);t.after(async()=>{await service.close();removeOwnedFixture(root);});
  await assert.rejects(service.submit("snapshot_invalid","controller",{...options,snapshotAttachment:{...options.snapshotAttachment,content:"changed"}}),{code:"INVALID_SNAPSHOT"});
  assert.ok(!fs.existsSync(ledger));
  adapter.supportsNativeSnapshotFileRetention=false;
  await assert.rejects(service.submit("snapshot_old_lifetime","controller",options),{code:"UNSUPPORTED_OPERATION"});
  adapter.supportsNativeSnapshotFileRetention=true;
  await service.submit("snapshot_valid","controller",options);assert.equal((await service.result("snapshot_valid",1000)).status,"completed");
  assert.equal(content,options.snapshotAttachment.content);assert.equal(sends,1);
  await service.submit("snapshot_valid","controller",options);assert.equal(sends,1);
  await assert.rejects(service.submit("snapshot_valid","controller",{...options,snapshotAttachment:snapshot("OTHER_CONTEXT")}),{code:"CONFIG_CONFLICT"});
  assert.ok(!fs.readFileSync(ledger,"utf8").includes("PRIVATE_SYNTHETIC_CONTEXT"));
});
