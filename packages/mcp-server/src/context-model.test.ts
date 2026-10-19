import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { GeminiBrowserAdapter, BrowserModelSelection } from "@antigravity-gemini-web/gemini-browser";
import { GeminiMcpService } from "./service.js";
import { ModelRestoreJournal } from "./model-restore.js";
import { removeOwnedFixture } from "./fixture-cleanup.js";

const primary = { model: "4 Argon", effort: "High" }, context = { model: "3.8 Flash" };
const email = "context-model@example.test", fingerprint = createHash("sha256").update(email).digest("hex");
function fixture(journal: string) {
  let current: BrowserModelSelection = { ...primary }, identity = email, sends = 0, failRestore = false;
  const selected: BrowserModelSelection[] = [];
  const browser: GeminiBrowserAdapter = {
    checkStatus: async () => ({ browserState: "ready", accountState: "signed_in", accountIdentity: identity, checkedAt: new Date().toISOString() }),
    openBrowser: async () => ({ opened: true }), supportsRetainedConversations: true,
    openFreshConversation: async () => ({ close: async () => {}, suspend: async () => {}, resume: async () => {} }),
    captureModelSelection: async () => ({ ...current }),
    selectModel: async policy => {
      if (failRestore && policy.model === primary.model && current.model === context.model) throw { code: "MODEL_UNAVAILABLE" };
      current = { ...policy }; selected.push({ ...current }); return { ...current };
    },
    submitPrompt: async turnId => {
      sends++;
      if (current.model === context.model) assert.equal(fs.existsSync(journal), true, "Persist the return policy before temporary selection can send.");
      return { turnId, status: "accepted", submittedAt: new Date().toISOString() };
    },
    pollResponse: async turnId => ({ turnId, status: "completed", text: "CONTEXT_ACK", completedAt: new Date().toISOString() }),
    cancelPrompt: async turnId => ({ turnId, cancelled: false }), cleanup: async () => {}, sendPrompt: async () => { throw Error("Unused"); },
  };
  return { browser, selected, get sends() { return sends; }, get current() { return current; }, set failRestore(value: boolean) { failRestore = value; }, set identity(value: string) { identity = value; } };
}
const options = () => ({ expectedAccountFingerprint: fingerprint, conversation: { key: "context_model_chat", revision: "a".repeat(64) }, modelSelection: context, temporaryModelSelection: true });

test("Context ACK uses 3.8 and restores the exact primary model and effort before publishing its checkpoint", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-test-")), ledger = path.join(root, "receipts.json"), journal = ledger + ".model-restore.json";
  const fake = fixture(journal), service = new GeminiMcpService(fake.browser, ledger);
  t.after(async () => { await service.close(); removeOwnedFixture(root); });
  await service.submit("context_stage_001", "Synthetic context only", options());
  const result = await service.result("context_stage_001", 1000);
  assert.equal(result.status, "completed"); assert.deepEqual(result.verifiedModel, context); assert.deepEqual(result.restoredModel, primary);
  assert.deepEqual(fake.selected, [context, primary]); assert.deepEqual(fake.current, primary); assert.equal(fs.existsSync(journal), false);
  await service.submit("context_stage_001", "Synthetic context only", options()); assert.equal(fake.sends, 1);
});

test("Interrupted model restoration persists across restart, blocks Send, rejects a changed account and recovers without replay", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-test-")), ledger = path.join(root, "receipts.json"), journal = ledger + ".model-restore.json";
  const fake = fixture(journal); fake.failRestore = true;
  const first = new GeminiMcpService(fake.browser, ledger); let second: GeminiMcpService | undefined;
  t.after(async () => { await first.close(); await second?.close(); removeOwnedFixture(root); });
  await first.submit("context_stage_002", "Synthetic context only", options());
  assert.equal((await first.result("context_stage_002", 1000)).status, "failed");
  assert.equal((await first.status()).modelRestorePending, true); assert.equal(fs.existsSync(journal), true);
  await first.close(); second = new GeminiMcpService(fake.browser, ledger);
  await assert.rejects(second.submit("context_stage_003", "Never send while restoration is pending"), { code: "MODEL_RESTORE_PENDING" });
  fake.identity = "other@example.test";
  await assert.rejects(second.openBrowser(), { code: "ACCOUNT_IDENTITY_CHANGED" }); assert.equal(fake.sends, 1);
  fake.identity = email; fake.failRestore = false;
  assert.equal((await second.openBrowser()).modelRestorePending, false);
  assert.deepEqual(fake.current, primary); assert.equal(fake.sends, 1); assert.equal(fs.existsSync(journal), false);
  await assert.rejects(second.submit("context_stage_002", "Synthetic context only", options()), { code: "OUTCOME_UNKNOWN" });
});

test("A stale restoration callback or corrupt journal cannot remove a newer saved return policy", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-test-")), file = path.join(root, "model-restore.json"), journal = new ModelRestoreJournal(file);
  t.after(() => removeOwnedFixture(root));
  const old = journal.begin(primary, fingerprint); journal.finish(old);
  const current = journal.begin(primary, fingerprint);
  assert.throws(() => journal.finish(old), { code: "STALE_AUTHORITY" }); assert.equal(journal.pending()?.token, current.token);
  fs.writeFileSync(file, '{"version":1'); assert.throws(() => journal.pending(), { code: "MODEL_RESTORE_PENDING" });
});
