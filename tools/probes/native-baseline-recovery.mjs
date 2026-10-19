// Cold-copy/restore and binary rollback acceptance on owned state only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { verifyRecoveryBuild } from "./native-recovery-build.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const arg = (name, fallback) => process.argv.find(value => value.startsWith(name + "="))?.slice(name.length + 1) ?? fallback;
assert.ok(arg("--baseline-dir") && arg("--current-dir"), "Prepare both isolated builds with native-recovery-build.mjs first");
const baseline = fs.realpathSync(arg("--baseline-dir")), current = fs.realpathSync(arg("--current-dir"));
assert.notEqual(baseline.toLowerCase(), current.toLowerCase());
const baselineBuild = verifyRecoveryBuild(repo, baseline, "baseline"), currentBuild = verifyRecoveryBuild(repo, current, "current");
const baselineCommit = baselineBuild.commit;
assert.equal(baselineCommit.slice(0, 7), "4e28d7a");
assert.equal(currentBuild.commit, execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
const { NativeRequestLedger } = await import(pathToFileURL(path.join(current,"packages/native-antigravity/dist/request-ledger.js")));
const { PhysicalReceiptStore } = await import(pathToFileURL(path.join(current,"packages/mcp-server/dist/receipt-store.js")));
const { compileNativeTurn, WEB_MODEL, sha256 } = await import(pathToFileURL(path.join(current,"packages/native-antigravity/dist/native-protocol.js")));
const { NATIVE_RUNTIME_REVISION: currentRevision } = await import(pathToFileURL(path.join(current,"packages/native-antigravity/dist/native-proxy.js")));
assert.equal(currentRevision, currentBuild.runtimeRevision); assert.ok(currentRevision >= 38);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-smoke-native-lifecycle-recovery-"));
const fixtureSource = fs.readFileSync(path.join(repo, "tools/probes/fixtures/native-lifecycle-owner.mjs"), "utf8");
const nativeHome = path.join(root, "home/.gemini/antigravity-gemini-web-live/app_data/native-route");
const groups = { native: nativeHome, mcp: path.join(root, "mcp") };
const output = path.resolve(arg("--output", ".tmp/native-baseline-recovery.json"));
const owners = [], starts = [], snapshots = [], authorization = "Bearer synthetic-recovery-fixed";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const request = text => ({ model: WEB_MODEL, sessionId: "recovery-fixture", conversationId: "recovery-fixture", request: { systemInstruction: { parts: [{ text: "Synthetic recovery authority" }] }, contents: [{ role: "user", parts: [{ text }] }] } });
const logicalId = text => compileNativeTurn(request(text), sha256(authorization)).requestId;
let evidence;

function owned(target) {
  const absolute = path.resolve(target);
  assert.ok(absolute.toLowerCase().startsWith((root + path.sep).toLowerCase()), "Outside the owned recovery root");
  return absolute;
}
async function bounded(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + " deadline")), ms); })]); }
  finally { clearTimeout(timer); }
}
function events() { return fs.existsSync(path.join(root, "events.jsonl")) ? fs.readFileSync(path.join(root, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(value => JSON.parse(value)) : []; }
const sends = () => events().filter(event => event.type === "synthetic_send").length;
function stopped() { assert.ok(owners.every(owner => owner.terminal), "A metadata writer is still live"); }
async function start(build, expectedRevision, hold = false) {
  stopped();
  const harness = owned(path.join(root, "harness", "owner-" + expectedRevision + ".mjs"));
  if (!fs.existsSync(harness)) {
    let imports = 0;
    const source = fixtureSource.replace(/from "\.\.\/\.\.\/\.\.\/packages\/([^\"]+)"/g, (_, relative) => { imports++; return "from " + JSON.stringify(pathToFileURL(path.join(build, "packages", relative)).href); });
    assert.equal(imports, 7); fs.mkdirSync(path.dirname(harness), { recursive: true }); fs.writeFileSync(harness, source, { flag: "wx", mode: 0o600 });
  }
  const child = fork(harness, [root, "0", "--recovery-mode", ...(hold ? ["--recovery-hold-response"] : [])], { cwd: build, execArgv: [], env: { ...process.env, NODE_OPTIONS: "", AG_MCP_NODE_SEMI_SPACE_MB: "off" }, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const owner = { child, terminal: false, stderr: "" }; owners.push(owner);
  owner.exited = new Promise(resolve => child.once("exit", (code, signal) => { owner.terminal = true; resolve({ code, signal }); }));
  child.stderr.on("data", bytes => { owner.stderr = (owner.stderr + String(bytes)).slice(-4096); });
  await bounded(new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", () => reject(Error("Fixture exited before ready"))); child.once("message", value => value?.ready ? resolve() : reject(Error("Invalid readiness"))); }), 15000, "Recovery owner startup");
  Object.assign(owner, JSON.parse(fs.readFileSync(path.join(root, "native-owner.json"), "utf8")));
  const health = await fetch(owner.endpoint + "/__native/health", { signal: AbortSignal.timeout(5000) }).then(response => response.json());
  assert.equal(health.runtimeRevision, expectedRevision); assert.equal(health.counters.active, 0);
  starts.push({ runtimeRevision: health.runtimeRevision, holdResponse: hold });
  return owner;
}
async function stop(owner, crash = false) {
  if (!owner.terminal) {
    if (crash) owner.child.kill("SIGKILL"); else if (owner.child.connected) owner.child.send({ id: randomUUID(), action: "stop" });
    const exit = await bounded(owner.exited, 10000, "Recovery owner exit");
    if (!crash) assert.equal(exit.code, 0);
  }
}
async function native(owner, text) {
  const response = await fetch(owner.endpoint + "/v1internal:generateContent", { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(request(text)), signal: AbortSignal.timeout(15000) });
  return { status: response.status, data: await response.json() };
}
function inventory(directory, prefix = "") {
  const result = {};
  if (!fs.existsSync(directory)) return result;
  assert.ok(!fs.lstatSync(directory).isSymbolicLink());
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name), relative = prefix + entry.name, stat = fs.lstatSync(file);
    assert.ok(!stat.isSymbolicLink(), "Linked state is forbidden");
    if (stat.isDirectory()) Object.assign(result, inventory(file, relative + "/"));
    else {
      assert.ok(stat.isFile() && stat.nlink === 1);
      if (prefix === "" && entry.name === "proxy-owner.json") continue;
      result[relative] = digest(fs.readFileSync(file));
    }
  }
  return result;
}
function liveInventory() { stopped(); return Object.fromEntries(Object.entries(groups).map(([name, directory]) => [name, inventory(directory)])); }
function snapshot(label) {
  stopped();
  const directory = owned(path.join(root, "snapshots", label)); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const hashes = liveInventory();
  for (const [name, files] of Object.entries(hashes)) for (const [relative, hash] of Object.entries(files)) {
    const target = owned(path.join(directory, name, relative)); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(groups[name], relative), target, fs.constants.COPYFILE_EXCL);
    assert.equal(digest(fs.readFileSync(target)), hash);
  }
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ version: 1, label, hashes }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  snapshots.push(label); return directory;
}
function verify(snapshotDirectory) {
  stopped(); const manifest = JSON.parse(fs.readFileSync(path.join(snapshotDirectory, "manifest.json"), "utf8"));
  for (const [name, files] of Object.entries(manifest.hashes)) {
    assert.ok(name in groups);
    assert.deepEqual(inventory(path.join(snapshotDirectory, name)), files, "BACKUP_CHECKSUM_MISMATCH");
  }
  // Open only a disposable validation clone: WAL recovery and read marks must
  // never alter the immutable backup bytes or the original stopped store.
  const clone = owned(path.join(root, "validation", randomUUID())); fs.mkdirSync(clone, { recursive: true });
  for (const name of Object.keys(groups)) fs.cpSync(path.join(snapshotDirectory, name), path.join(clone, name), { recursive: true, errorOnExist: true });
  const ledger = new NativeRequestLedger(path.join(clone, "native/native-turn-ledger")), logical = [];
  for (const file of Object.keys(manifest.hashes.native).filter(name => /^native-turn-ledger\/.*\.json$/.test(name))) {
    const id = path.basename(file, ".json"); logical.push(ledger.inspect(id));
  }
  const physical = [];
  for (const relative of Object.keys(manifest.hashes.mcp).filter(name => /(?:^|\/)receipts\.json$/.test(name))) {
    const store = new PhysicalReceiptStore(path.join(clone, "mcp", relative));
    try {
      const db = new DatabaseSync(store.databaseFile, { readOnly: true, allowExtension: false });
      try { assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok"); const rows = db.prepare("SELECT request_id,content_hash,phase,attempt_id,logical_request_id,logical_attempt_id,account_id,identity_epoch FROM receipts ORDER BY request_id").all(); physical.push(...rows); assert.equal(store.count(), rows.length); }
      finally { db.close(); }
    } finally { store.close(); }
  }
  return { manifest, logical, physical };
}
function restore(snapshotDirectory) {
  stopped(); const checked = verify(snapshotDirectory), current = liveInventory();
  // Conservative cold-restore guard: no existing metadata byte may be rewound
  // or omitted. This fixture does not implement merge/repair of damaged stores.
  for (const [name, files] of Object.entries(current)) for (const [relative, hash] of Object.entries(files)) assert.equal(checked.manifest.hashes[name][relative], hash, "RESTORE_WOULD_DROP_OR_REWIND_METADATA");
  const quarantine = owned(path.join(root, "quarantine", randomUUID())); fs.mkdirSync(quarantine, { recursive: true });
  for (const [name, directory] of Object.entries(groups)) {
    owned(fs.realpathSync(directory)); const displaced = owned(path.join(quarantine, name));
    fs.renameSync(directory, displaced);
    fs.cpSync(path.join(snapshotDirectory, name), owned(directory), { recursive: true, errorOnExist: true });
  }
  assert.deepEqual(liveInventory(), checked.manifest.hashes);
  return checked;
}
async function blocked(owner, text) { const before = sends(), result = await native(owner, text); assert.equal(result.status, 409); assert.equal(sends(), before); return result; }
async function reconcile(owner, id) {
  const response = await fetch(owner.endpoint + "/__native/reconcile", { method: "POST", headers: { "x-native-control-token": owner.controlToken, "content-type": "application/json" }, body: JSON.stringify({ requestId: id }), signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.replayAllowed, false); return result;
}

try {
  let owner = await start(baseline, 36);
  assert.equal((await native(owner, "baseline_A")).status, 200); assert.equal(sends(), 1);
  assert.throws(() => snapshot("live_writer_refused"), /metadata writer is still live/);
  assert.equal((await native(owner, "baseline_A")).status, 200); assert.equal(sends(), 1);
  await stop(owner); const old = snapshot("baseline_36"); assert.equal(verify(old).physical.length, 1);
  owner = await start(current, currentRevision); await blocked(owner, "baseline_A");
  assert.equal((await native(owner, "upgrade_B")).status, 200); assert.equal(sends(), 2); await stop(owner);
  const accounts = JSON.parse(fs.readFileSync(path.join(nativeHome, "accounts.json"), "utf8")).accounts;
  const ledger = new NativeRequestLedger(path.join(nativeHome, "native-turn-ledger"));
  const v2id = logicalId("seeded_v2_fence"), deadlineAt = new Date(Date.now() + 120000).toISOString();
  let v2 = ledger.reserve(v2id, accounts[0].accountId, accounts[0].identityEpoch, "synthetic-recovery", { maxAttempts: 2, deadlineAt });
  ledger.notSent(v2, { delivery: "not_sent", code: "MODEL_UNAVAILABLE", phase: "checkpoint", observedAt: new Date().toISOString() });
  v2 = ledger.nextAttempt(v2, accounts[1].accountId, accounts[1].identityEpoch); ledger.unknown(v2);
  const v2bytes = fs.readFileSync(path.join(nativeHome, "native-turn-ledger", v2id.slice(7, 9), v2id + ".json"));
  const latest = snapshot("upgraded_" + currentRevision); assert.equal(verify(latest).logical.length, 3);
  const beforeReject = liveInventory(); assert.throws(() => restore(old), /RESTORE_WOULD_DROP_OR_REWIND_METADATA/); assert.deepEqual(liveInventory(), beforeReject);
  const corrupt = owned(path.join(root, "snapshots/corrupt")); fs.cpSync(latest, corrupt, { recursive: true });
  const corruptFile = Object.keys(JSON.parse(fs.readFileSync(path.join(corrupt, "manifest.json"), "utf8")).hashes.native).find(name => name.startsWith("native-turn-ledger/"));
  fs.appendFileSync(path.join(corrupt, "native", corruptFile), "corruption");
  assert.throws(() => restore(corrupt), /BACKUP_CHECKSUM_MISMATCH/); assert.deepEqual(liveInventory(), beforeReject);
  owner = await start(current, currentRevision, true);
  const uncertain = native(owner, "crash_C").then(() => "unexpected_response", () => "connection_lost");
  const barrierDeadline = performance.now() + 10000;
  while (!events().some(event => event.type === "synthetic_response_barrier")) { assert.ok(performance.now() < barrierDeadline, "Accepted-response crash barrier deadline"); await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(sends(), 3); await stop(owner, true); assert.equal(await uncertain, "connection_lost");
  const crash = snapshot("crashed_" + currentRevision + "_with_wal");
  const walFiles = Object.keys(JSON.parse(fs.readFileSync(path.join(crash, "manifest.json"), "utf8")).hashes.mcp).filter(name => name.endsWith(".sqlite-wal"));
  assert.ok(walFiles.length && walFiles.some(name => fs.statSync(path.join(crash, "mcp", name)).size > 0));
  const recovered = restore(crash); assert.equal(recovered.physical.length, 3); assert.equal(recovered.logical.length, 4);
  owner = await start(baseline, 36);
  for (const text of ["baseline_A", "upgrade_B", "crash_C", "seeded_v2_fence"]) await blocked(owner, text);
  const receipt = await reconcile(owner, logicalId("crash_C"));
  assert.equal(receipt.physical.length, 1); assert.equal(receipt.physical[0].receipt.phase, "accepted"); assert.equal(receipt.physical[0].correlation, "verified");
  assert.deepEqual(fs.readFileSync(path.join(nativeHome, "native-turn-ledger", v2id.slice(7, 9), v2id + ".json")), v2bytes);
  const unresolved = await blocked(owner, "rollback_fresh_D");
  assert.equal(unresolved.data.error.details[0].reason, "OUTCOME_UNKNOWN");
  const resume = await fetch(owner.endpoint + "/__native/resume", { method: "POST", headers: { "x-native-control-token": owner.controlToken, "content-type": "application/json" }, body: JSON.stringify({ url: "https://gemini.google.com/app/synthetic_recovery_stopped", nextTurn: true }), signal: AbortSignal.timeout(5000) });
  assert.equal(resume.status, 200); assert.equal((await resume.json()).promptSent, false); assert.equal(sends(), 3);
  assert.equal((await native(owner, "rollback_fresh_D")).status, 200); assert.equal(sends(), 4); await stop(owner);
  owner = await start(current, currentRevision); for (const text of ["baseline_A", "upgrade_B", "crash_C", "seeded_v2_fence", "rollback_fresh_D"]) await blocked(owner, text); await stop(owner);
  const final = verify(snapshot("final_reupgrade_" + currentRevision)); assert.equal(final.logical.length, 5); assert.equal(final.physical.length, 4);
  evidence = { checkedAt: new Date().toISOString(), status: `PASS_COLD_RESTORE_AND_36_${currentRevision}_36_${currentRevision}_ROLLBACK`, baselineCommit, currentCommit:currentBuild.commit, currentRuntimeRevision:currentRevision, dependencyInstallations: "TWO_INDEPENDENT_NPM_CI_LOCKFILE_IGNORE_SCRIPTS", builds: "TWO_FULL_WORKSPACE_BUILDS", starts, snapshots,
    realHttp: true, realMcpServiceAndSqlite: true, browser: "SYNTHETIC", realGooglePromptRequests: 0, realChromeProcesses: 0, realIdeExecutor: "NOT_TESTED", windowsRestart: "NOT_TESTED",
    syntheticSends: sends(), duplicateSends: 0, currentFenceCount: final.logical.length, currentPhysicalReceipts: final.physical.length, v2AttemptHistoryAndDeadlineBytesPreserved: true,
    liveWriterBackupRejected: true, oldBackupRejectedWithoutMutation: true, corruptBackupRejectedWithoutMutation: true, coldWalRestore: true, crashedAcceptedReceiptRetained: true, unknownChatBlockedUntilExplicitResume: true, explicitResumeAddsNoSend: true, newRequestAfterRollbackCompleted: true,
    testHarness: "CURRENT_SYNTHETIC_HARNESS_IMPORTS_PINNED_BUILD_MODULES_BASELINE_SOURCES_UNMODIFIED",
    dependencyLocks: Object.fromEntries([["baseline",baselineBuild],["current",currentBuild]].map(([label,build])=>[label,{commit:build.commit,runtimeRevision:build.runtimeRevision,packageLockSha256:build.sha256["package-lock.json"],installedLockSha256:build.sha256["node_modules/.package-lock.json"],installExitCode:build.installExitCode,buildExitCode:build.buildExitCode}])),
    dependencyLocksDiffer: baselineBuild.sha256["package-lock.json"]!==currentBuild.sha256["package-lock.json"],
    scope: "OWNED_FIXTURE_ONLY_NO_PRODUCTION_REPAIR_OR_MULTI_DIRECTORY_ATOMICITY", backupExcludesControlTokensAndChromeProfiles: true,
    sourceSha256: { probe: digest(fs.readFileSync(fileURLToPath(import.meta.url))), preparation: digest(fs.readFileSync(fileURLToPath(new URL("./native-recovery-build.mjs",import.meta.url)))), fixture: digest(fs.readFileSync(path.join(repo, "tools/probes/fixtures/native-lifecycle-owner.mjs"))) },
    compiled: Object.fromEntries([["baseline36", baseline], ["current"+currentRevision, current]].map(([label, build]) => [label, Object.fromEntries(["native-antigravity/dist/native-proxy.js", "native-antigravity/dist/request-ledger.js", "mcp-server/dist/service.js", "mcp-server/dist/receipt-store.js"].map(name => [name, digest(fs.readFileSync(path.join(build, "packages", name)))]))])),
  };
} catch (error) { evidence = { checkedAt: new Date().toISOString(), status: "FAIL", errorType: error.name, starts, snapshots, syntheticSends: sends(), realGooglePromptRequests: 0 }; throw error; }
finally {
  for (const owner of owners.filter(value => !value.terminal)) { try { await stop(owner); } catch { owner.child.kill("SIGKILL"); await bounded(owner.exited, 5000, "Owned recovery child termination"); } }
  stopped();
  let cleanupError;
  try {
    if (evidence?.status.startsWith("PASS_")) { const target = fs.realpathSync(root); assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase()); assert.match(path.basename(target), /^launcher-smoke-native-lifecycle-recovery-/); fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  } catch (error) { cleanupError = error; if (evidence) evidence.status = "FAIL_OWNED_TEMP_CLEANUP"; }
  if (evidence) { evidence.fixtureWritersExited = true; evidence.tempRootRemoved = !fs.existsSync(root); evidence.tempRootPolicy = "PRESERVED_ON_FAILURE_REMOVED_ON_PASS"; fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n"); }
  if (fs.existsSync(root)) console.error("Owned recovery fixture retained for inspection: " + root);
  if (cleanupError) throw cleanupError;
}
console.log(JSON.stringify({ status: evidence.status, syntheticSends: evidence.syntheticSends, fences: evidence.currentFenceCount, receipts: evidence.currentPhysicalReceipts }));
