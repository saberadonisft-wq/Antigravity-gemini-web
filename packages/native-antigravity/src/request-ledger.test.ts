import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NativeRequestLedger } from "./request-ledger.js";
import { sha256 } from "./native-protocol.js";

function directory(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ag-request-ledger-"));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith("ag-request-ledger-")); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
const id = (key: string) => "native_" + sha256(key);

test("Physical request mapping is persisted before transport, bounded and owned by one logical attempt", t=>{
  const root=directory(t),ledger=new NativeRequestLedger(root),record=ledger.reserve(id("mapping"),"acc_A",1);
  for(let i=0;i<11;i++)ledger.recordPhysical(record,"physical_request_"+i);
  ledger.recordPhysical(record,"physical_request_0");
  assert.equal(new NativeRequestLedger(root).inspect(record.requestId)?.physicalRequests?.length,11);
  assert.throws(()=>ledger.recordPhysical(record,"physical_request_12"),{code:"TRANSPORT_ATTEMPTS_EXHAUSTED"});
  ledger.discardNotSent(record);
  const replacement=ledger.reserve(record.requestId,"acc_B",2);
  assert.throws(()=>ledger.recordPhysical(record,"stale_physical_request"),{code:"STALE_AUTHORITY"});
  ledger.recordPhysical(replacement,"replacement_request");ledger.complete(replacement);
  assert.throws(()=>ledger.recordPhysical(replacement,"late_physical_request"),{code:"STALE_AUTHORITY"});
  assert.equal(ledger.inspect(id("absent")),undefined);
});

test("Durable logical reservations are global across accounts/process instances, including before Send", t => {
  const root = directory(t), first = new NativeRequestLedger(root), second = new NativeRequestLedger(root);
  const reservation = first.reserve(id("one"), "acc_A", 1);
  assert.throws(() => second.reserve(reservation.requestId, "acc_B", 2), { code: "OUTCOME_UNKNOWN" });
  first.submitted(reservation); first.complete(reservation);
  assert.throws(() => new NativeRequestLedger(root).reserve(reservation.requestId, "acc_B", 2), { code: "OUTCOME_UNKNOWN" });
  assert.throws(() => first.discardNotSent(reservation), { code: "STALE_AUTHORITY" });
});

test("Only a proven unsent owner can release a reservation; stale callbacks cannot delete its replacement", t => {
  const ledger = new NativeRequestLedger(directory(t));
  const before = ledger.reserve(id("retry"), "acc_A", 1);
  ledger.discardNotSent(before);
  const after = ledger.reserve(before.requestId, "acc_B", 1);
  assert.notEqual(before.attemptId, after.attemptId);
  assert.throws(() => ledger.discardNotSent(before), { code: "STALE_AUTHORITY" });
  assert.throws(() => ledger.complete(before), { code: "STALE_AUTHORITY" });
  ledger.submitted(after);
});

test("A corrupt or interrupted write keeps its fence instead of permitting replay", t => {
  const root = directory(t), ledger = new NativeRequestLedger(root), reservation = ledger.reserve(id("interrupted"), "acc_A", 1);
  const filename = path.join(root, reservation.requestId.slice(7, 9), reservation.requestId + ".json");
  fs.writeFileSync(filename, "{");
  assert.throws(() => ledger.discardNotSent(reservation), { code: "REQUEST_LEDGER_UNAVAILABLE" });
  assert.throws(() => new NativeRequestLedger(root).reserve(reservation.requestId, "acc_B", 1), { code: "OUTCOME_UNKNOWN" });
});

test("More than 2048 logical receipts remain directly addressable after restart with no prompt persistence", { timeout: 30000 }, t => {
  const root = directory(t), ledger = new NativeRequestLedger(root);
  const started = performance.now();
  for (let index = 0; index < 2100; index++) {
    const receipt = ledger.reserve(id("scale-" + index), "acc_A", 1); ledger.complete(receipt);
  }
  const restarted = new NativeRequestLedger(root);
  for (const index of [0, 1024, 2048, 2099]) assert.throws(() => restarted.reserve(id("scale-" + index), "acc_B", 2), { code: "OUTCOME_UNKNOWN" });
  const sample = JSON.parse(fs.readFileSync(path.join(root, id("scale-0").slice(7, 9), id("scale-0") + ".json"), "utf8"));
  assert.equal(sample.state, "completed"); assert.equal("prompt" in sample, false); assert.equal("text" in sample, false);
  t.diagnostic(`2100 metadata receipts reserved/completed in ${Math.round(performance.now() - started)}ms; this is the logical store, not the MCP physical receipt migration.`);
});
