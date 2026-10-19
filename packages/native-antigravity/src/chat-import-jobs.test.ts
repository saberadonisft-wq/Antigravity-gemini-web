import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NativeChatImportJobs } from "./chat-import-jobs.js";
import { AccountRegistry } from "./account-registry.js";
import { sha256 } from "./native-protocol.js";
import { writeSyntheticChatArchive } from "./testing/chat-import-archive.fixture.js";

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ag-chat-import-jobs-test-")), registry = new AccountRegistry(path.join(root, "accounts.json"));
  const accounts = ["A", "B"].map(name => registry.add({ displayName: name, profilePath: path.join(root, "profile" + name), statePath: path.join(root, "state" + name), identityFingerprint: sha256(name) }));
  let current = registry.snapshot(), now = 0;
  const ownerId = randomUUID(), jobs = new NativeChatImportJobs(() => structuredClone(current), ownerId, () => now), file = await writeSyntheticChatArchive(root);
  t.after(async () => { await jobs.close(); const target = fs.realpathSync(root); assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase()); assert.match(path.basename(target), /^ag-chat-import-jobs-test-/); fs.rmSync(target, { recursive: true, force: true }); });
  const status = () => jobs.snapshot(true, true);
  const inspect = () => { const snapshot = status(); return jobs.inspect({ expectedOwnerId: ownerId, expectedRevision: snapshot.revision, expectedAccountRevision: snapshot.accountRevision, accountId: accounts[0]!.accountId, identityEpoch: accounts[0]!.identityEpoch, provider: "chatgpt" }, file, true, true); };
  return { root, ownerId, accounts, jobs, file, status, inspect, mutateTarget: () => { current.accounts[0]!.identityEpoch++; }, advance: (delta: number) => { now += delta; } };
}
async function settled(status: () => ReturnType<NativeChatImportJobs["snapshot"]>) {
  const deadline = performance.now() + 10000;
  while (status().inspectionActive) { assert.ok(performance.now() < deadline, "Actual inspection worker did not exit"); await new Promise(resolve => setTimeout(resolve, 10)); }
  return status();
}
test("Actual inspection worker publishes a path-free account-bound preview only after exit", { timeout: 15000 }, async t => {
  const fixture = await setup(t), initial = fixture.inspect();
  assert.equal(initial.inspectionActive, true); assert.equal(initial.jobs[0]!.state, "checking"); assert.equal(initial.jobs[0]!.inspection, undefined);
  const done = await settled(fixture.status), job = done.jobs[0]!;
  assert.equal(job.state, "ready"); assert.equal(job.accountId, fixture.accounts[0]!.accountId); assert.equal(job.inspection!.directory.files, 2);
  assert.equal(job.bytesRead, job.inspection!.bytes); assert.equal(done.googleSubmission, "not_submitted");
  assert.ok(!JSON.stringify(done).includes(fixture.root)); assert.ok(!JSON.stringify(done).includes("SYNTHETIC_ARCHIVE_DATA_ONLY"));
  fixture.jobs.execute({ action: "clear", expectedOwnerId: fixture.ownerId, jobId: job.jobId }); assert.equal(fixture.status().jobs.length, 0); assert.ok(fs.existsSync(fixture.file));
});
test("Cancel retains its worker slot until physical exit and never publishes a late result", { timeout: 15000 }, async t => {
  const fixture = await setup(t), initial = fixture.inspect(), id = initial.jobs[0]!.jobId;
  fixture.jobs.execute({ action: "cancel", expectedOwnerId: fixture.ownerId, jobId: id });
  assert.equal(fixture.status().jobs[0]!.state, "cancelling"); assert.equal(fixture.status().canInspect, false);
  assert.throws(() => fixture.inspect(), { code: "BUSY" });
  const done = await settled(fixture.status); assert.equal(done.jobs[0]!.state, "cancelled"); assert.equal(done.jobs[0]!.inspection, undefined); assert.equal(done.canInspect, true);
});
test("Shutdown waits for the active worker exit and cannot publish its late inspection", { timeout: 15000 }, async t => {
  const fixture=await setup(t);fixture.inspect();assert.equal(fixture.status().inspectionActive,true);
  const closing=fixture.jobs.close();assert.strictEqual(fixture.jobs.close(),closing);assert.equal(fixture.status().canInspect,false);
  await closing;const done=fixture.status();assert.equal(done.inspectionActive,false);assert.equal(done.jobs[0]!.state,"cancelled");assert.equal(done.jobs[0]!.inspection,undefined);
});
test("Changing a target epoch invalidates active and completed previews even without a revision bump", { timeout: 15000 }, async t => {
  const fixture = await setup(t); fixture.inspect(); fixture.mutateTarget();
  assert.equal(fixture.status().jobs[0]!.state, "stale"); await settled(fixture.status);
  // A new request must explicitly use the new epoch; the old one cannot be reused.
  assert.throws(() => fixture.inspect(), { code: "STALE_AUTHORITY" });
});
test("Completed previews expire on monotonic time and shutdown cannot start another inspection", { timeout: 15000 }, async t => {
  const fixture = await setup(t); fixture.inspect(); await settled(fixture.status); fixture.advance(15 * 60 * 1000);
  const expired = fixture.status().jobs[0]!; assert.equal(expired.state, "expired"); assert.equal(expired.inspection, undefined);
  assert.throws(() => fixture.jobs.execute({ action: "clear", expectedOwnerId: randomUUID(), jobId: expired.jobId }), { code: "STALE_AUTHORITY" });
  const closing = fixture.jobs.close(); assert.strictEqual(fixture.jobs.close(), closing); await closing; assert.equal(fixture.status().canInspect, false); assert.throws(() => fixture.inspect(), { code: "BUSY" });
});
test("Preview retention is bounded and a completed result is withdrawn when its account changes", { timeout: 20000 }, async t => {
  const fixture = await setup(t); let first = "";
  for (let index = 0; index < 9; index++) { const started = fixture.inspect(); if (!index) first = started.jobs[0]!.jobId; await settled(fixture.status); }
  assert.equal(fixture.status().jobs.length, 8); assert.ok(!fixture.status().jobs.some(job => job.jobId === first));
  fixture.mutateTarget(); assert.ok(fixture.status().jobs.every(job => job.state === "stale" && !job.inspection));
});
