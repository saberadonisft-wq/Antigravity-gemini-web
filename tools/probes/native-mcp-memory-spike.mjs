// Actual MCP shared-owner/frontends/SQLite; all browser responses are synthetic.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const arg = (name, fallback) => process.argv.find(value => value.startsWith(name + "="))?.slice(name.length + 1) ?? fallback;
const semiSpace = arg("--semi-space", "off"), rounds = Number(arg("--rounds", "40")), warmup = Number(arg("--warmup", "8"));
assert.ok(["off", "8", "16"].includes(semiSpace));
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 500);
assert.ok(Number.isInteger(warmup) && warmup >= 1 && warmup <= 100);
const repo = fileURLToPath(new URL("../../", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ag-mcp-memory-"));
const output = path.resolve(arg("--output", ".tmp/native-mcp-memory-spike.json"));
const ownerEntry = fileURLToPath(new URL("fixtures/native-mcp-memory-owner.mjs", import.meta.url));
const frontendEntry = path.join(repo, "packages/mcp-server/dist/testing/shared-client-fixture.js");
const execFileAsync = promisify(execFile), sha = value => createHash("sha256").update(value).digest("hex");
const owners = [], clients = [], transports = [], frontendExits = [], latencies = [], samples = [];
const started = performance.now(); let evidence, cleanupPassed = false;

async function bounded(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + " deadline")), ms); })]); }
  finally { clearTimeout(timer); }
}
async function call(client, name, args = {}) {
  assert.ok(performance.now() - started < 180000, "Owned MCP benchmark exceeded its total work budget");
  const response = await client.callTool({ name, arguments: args });
  const result = JSON.parse(response.content[0].text);
  assert.ok(!response.isError, `Fixture ${name} rejected: ${result.code}`);
  return result;
}
async function windowsProcesses(pids) {
  if (process.platform !== "win32") return { status: "NOT_MEASURED_ON_THIS_PLATFORM", processes: [] };
  assert.ok(pids.every(pid => Number.isInteger(pid) && pid > 0));
  const script = `$ErrorActionPreference='Stop'; @(Get-Process -Id ${pids.join(",")} | Select-Object Id,WorkingSet64,PrivateMemorySize64,HandleCount) | ConvertTo-Json -Compress`;
  const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15000 });
  const processes = JSON.parse(result.stdout);
  assert.equal(processes.length, pids.length);
  return { status: "WINDOWS_GET_PROCESS", processes };
}
async function sample(stage) {
  const workerSamples = await Promise.all(owners.map(async owner => {
    const value = await call(owner.clients[0], "fixture_process_memory");
    assert.equal(value.pid, owner.child.pid); assert.equal(value.owner, owner.label); assert.equal(value.semiSpace, semiSpace);
    assert.equal(value.submissions, value.completions); assert.equal(value.activeSyntheticTurns, 0);
    return value;
  }));
  const pids = [...owners.map(owner => owner.child.pid), ...transports.map(transport => transport.pid)];
  assert.equal(new Set(pids).size, 6);
  const physical = await windowsProcesses(pids);
  samples.push({ stage, elapsedMs: Math.round(performance.now() - started), workers: workerSamples, osProcesses: physical });
}
async function exercise(owner, count, phase) {
  for (let round = 0; round < count; round++) {
    const context = (`SYNTHETIC_MEMORY_${owner.label}_${phase}_${round}\n` + "owned_fixture_data_".repeat(15000)).slice(0, 260000);
    assert.equal(context.length, 260000);
    for (let offset = 0, fragment = 0; offset < context.length; offset += 26000, fragment++) {
      const prompt = context.slice(offset, offset + 26000), id = `memory_${owner.label}_${phase}_${round}_${fragment}`;
      const client = owner.clients[(round + fragment) % 2], start = performance.now();
      const accepted = await call(client, "gemini_submit", { request_id: id, prompt });
      assert.equal(accepted.requestId, id);
      const result = await call(client, "gemini_result", { request_id: id, wait_ms: 5000 });
      assert.equal(result.status, "completed"); assert.ok(result.text.startsWith(`SYNTHETIC:${owner.label}:${sha(prompt)}\n`));
      if (phase !== "warm") latencies.push(performance.now() - start);
      owner.lastRequest = { id, prompt, text: result.text };
    }
  }
}

try {
  for (const label of ["A", "B"]) {
    const child = fork(ownerEntry, [root, label, semiSpace], {
      cwd: repo, execArgv: ["--expose-gc", ...(semiSpace === "off" ? [] : ["--max-semi-space-size=" + semiSpace])],
      env: { ...process.env, NODE_OPTIONS: "" }, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const owner = { child, label, clients: [], stderr: "", exited: null }; owners.push(owner);
    owner.exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    child.stderr.on("data", chunk => { owner.stderr = (owner.stderr + String(chunk)).slice(-4096); });
    const ready = await bounded(new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(Error("Fixture owner exited before ready")));
      child.once("message", message => message?.ready === true ? resolve(message) : reject(Error("Invalid fixture readiness")));
    }), 15000, "Owner startup");
    assert.equal(ready.pid, child.pid);
    for (let index = 0; index < 2; index++) {
      const client = new Client({ name: `memory-fixture-${label}-${index}`, version: "1" });
      const transport = new StdioClientTransport({ command: process.execPath, args: [frontendEntry], stderr: "pipe", env: {
        AG_TEST_SCOPE: ready.scope, AG_TEST_DESCRIPTOR: ready.descriptorFile, AG_TEST_FINGERPRINT: ready.fingerprint,
      } });
      // SDK close can return just after SIGKILL. Observe its physical child-close
      // event as well, rather than treating a resolved client.close as exit proof.
      let exited;
      frontendExits.push(new Promise(resolve => { exited = resolve; }));
      const start = transport.start.bind(transport);
      transport.start = async () => {
        const previousClose = transport.onclose;
        transport.onclose = () => { try { previousClose?.(); } finally { exited(); } };
        try { await start(); } catch (error) { if (!transport.pid) exited(); throw error; }
      };
      clients.push(client); transports.push(transport); owner.clients.push(client);
      await bounded(client.connect(transport), 10000, "Frontend startup");
      assert.notEqual(transport.pid, child.pid);
    }
  }
  await Promise.all(owners.map(owner => exercise(owner, warmup, "warm")));
  await sample("after_warmup");
  const first = Math.ceil(rounds / 2);
  await Promise.all(owners.map(owner => exercise(owner, first, "soak")));
  await sample("mid_soak");
  // A distinct phase gives stable, noncolliding request IDs across the two halves.
  await Promise.all(owners.map(owner => exercise(owner, rounds - first, "tail")));
  await sample("after_soak");
  for (const owner of owners) {
    const before = await call(owner.clients[0], "fixture_process_memory"), request = owner.lastRequest;
    await call(owner.clients[1], "gemini_submit", { request_id: request.id, prompt: request.prompt });
    assert.equal((await call(owner.clients[0], "gemini_result", { request_id: request.id })).text, request.text);
    assert.equal((await call(owner.clients[1], "fixture_process_memory")).submissions, before.submissions);
    const other = owners.find(value => value !== owner);
    assert.equal((await call(other.clients[0], "gemini_receipt", { request_id: request.id })).found, false);
  }
  const sorted = latencies.toSorted((a, b) => a - b), percentile = fraction => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  const sources = ["packages/mcp-server/dist/service.js", "packages/mcp-server/dist/shared-stdio.js", "packages/mcp-server/dist/receipt-store.js", "tools/probes/native-mcp-memory-spike.mjs", "tools/probes/fixtures/native-mcp-memory-owner.mjs"];
  evidence = {
    checkedAt: new Date().toISOString(), status: "PASS_ACTUAL_MCP_PROCESSES_SYNTHETIC_BROWSER", semiSpace,
    actualSharedOwners: 2, actualStdioFrontends: 4, receiptStore: "REAL_SQLITE", browser: "SYNTHETIC", realChromeProcesses: 0, realGooglePromptRequests: 0,
    warmupContextsPerOwner: warmup, soakContextsPerOwner: rounds, syntheticContextChars: 260000, fragmentChars: 26000,
    nativeTransportProtocol: "NOT_EXERCISED_DIRECT_MCP_FRAGMENT_WORKLOAD", liveIdeExecutor: "NOT_TESTED",
    duplicateRetryAddsSubmission: false, crossOwnerReceiptLeak: false, elapsedMs: Math.round(performance.now() - started),
    measuredLatency: { scope: "soak_per_fragment_submit_and_result", samples: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) },
    ownerStartup: "EXPLICIT_OWNED_FIXTURE_START_SHARED_RUNTIME", frontend: "PRODUCTION_RUN_SHARED_STDIO_CONNECT_EXISTING_OWNER",
    automaticStartupFlagPropagation: "NOT_TESTED_NO_PRODUCTION_POLICY_CHANGE", samples,
    sourceSha256: Object.fromEntries(sources.map(name => [name, sha(fs.readFileSync(path.join(repo, name)))])),
  };
} catch (error) {
  evidence = { checkedAt: new Date().toISOString(), status: "FAIL", errorType: error.name, semiSpace, realGooglePromptRequests: 0, samples };
  throw error;
} finally {
  const closeResults = await Promise.allSettled(clients.map(client => client.close()));
  const frontendResults = await Promise.allSettled(frontendExits.map(exit => bounded(exit, 5000, "Frontend physical exit")));
  const stopResults = await Promise.allSettled(owners.map(async owner => {
    if (owner.child.connected) owner.child.send({ action: "stop" });
    let exit;
    try { exit = await bounded(owner.exited, 15000, "Owner cleanup"); }
    catch (error) { owner.child.kill(); await bounded(owner.exited, 5000, "Owned child termination"); throw error; }
    assert.equal(exit.code, 0);
  }));
  const cleanupFailures = [...closeResults, ...frontendResults, ...stopResults].filter(result => result.status === "rejected");
  const target = fs.realpathSync(root);
  assert.equal(target.toLowerCase(), path.resolve(root).toLowerCase());
  assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.match(path.basename(target), /^ag-mcp-memory-/);
  // Never remove a directory while one of its owned workers may still be alive.
  if (!cleanupFailures.length) { fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); cleanupPassed = true; }
  if (evidence) {
    evidence.observedFrontendExits = frontendResults.filter(result => result.status === "fulfilled").length;
    evidence.observedOwnerExits = stopResults.filter(result => result.status === "fulfilled").length;
    evidence.cleanup = cleanupPassed ? "OWNED_PROCESSES_EXITED_AND_TEMP_ROOT_REMOVED" : "FAILED_ROOT_PRESERVED";
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
  }
  if (cleanupFailures.length) throw new AggregateError(cleanupFailures.map(result => result.reason), "Owned MCP fixture cleanup failed");
}
console.log(JSON.stringify({ status: evidence.status, semiSpace, owners: 2, frontends: 4, rounds, cleanup: evidence.cleanup }));
