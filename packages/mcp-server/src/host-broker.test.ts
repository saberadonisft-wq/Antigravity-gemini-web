import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HostTurnBroker, type HostInventory } from "./host-broker.js";
import { createHostServer } from "./host-server.js";
import { startHostHttp } from "./host-http.js";
import { HostTaskLedger } from "./task-ledger.js";
import { removeOwnedFixture } from "./fixture-cleanup.js";

const tools: HostInventory = [{ name: "read_file", description: "Native IDE read tool", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }];
const decode = (value: unknown): Record<string, any> => JSON.parse((value as { content: { text: string }[] }).content[0].text);

test("Host broker enforces schema/nonce, delivery once, immutable result, bounded final answer and stale task rejection", () => {
  let now = 1000;
  const broker = new HostTurnBroker(() => now);
  const task = broker.begin("host_task_01", "D:/owned-workspace", tools, 5000);
  assert.throws(() => broker.inventory("wrong token"), { code: "STALE_AUTHORITY" });
  assert.throws(() => broker.enqueue(task.turn_token, "action_0001", "run_shell", {}), { code: "TOOL_DENIED" });
  assert.throws(() => broker.enqueue(task.turn_token, "action_0001", "read_file", { path: 3 }), { code: "TOOL_DENIED" });
  broker.enqueue(task.turn_token, "action_0001", "read_file", { path: "test.txt" });
  broker.enqueue(task.turn_token, "action_0001", "read_file", { path: "test.txt" });
  assert.throws(() => broker.enqueue(task.turn_token, "action_0001", "read_file", { path: "different.txt" }), { code: "CONFIG_CONFLICT" });
  assert.equal(broker.next(task.taskId).status, "action");
  assert.equal(broker.next(task.taskId).status, "awaiting_result");
  assert.throws(() => broker.complete(task.turn_token, "done"), { code: "BUSY" });
  broker.finishAction(task.taskId, "action_0001", { text: "host result" }, false);
  assert.throws(() => broker.finishAction(task.taskId, "action_0001", "changed", false), { code: "CONFIG_CONFLICT" });
  assert.equal(broker.callResult(task.turn_token, "action_0001").status, "completed");
  broker.complete(task.turn_token, "actual final");
  assert.equal(broker.next(task.taskId).finalText, "actual final");
  assert.throws(() => broker.complete(task.turn_token, "late overwrite"), { code: "STALE_AUTHORITY" });
  const next = broker.begin("host_task_02", "D:/another-workspace", tools, 1000);
  assert.throws(() => broker.callResult(task.turn_token, "action_0001"), { code: "STALE_AUTHORITY" });
  broker.enqueue(next.turn_token, "action_0002", "read_file", { path: "test.txt" });
  now += 1001;
  assert.throws(() => broker.next(next.taskId), { code: "STALE_AUTHORITY" });
  assert.throws(() => broker.enqueue(next.turn_token, "action_0002", "read_file", { path: "test.txt" }), { code: "STALE_AUTHORITY" });
});

test("Web Streamable HTTP and private host MCP make a real protocol roundtrip; web cannot spoof host results", async t => {
  const broker = new HostTurnBroker();
  const http = await startHostHttp(broker, 0);
  const hostServer = createHostServer(broker);
  const host = new Client({ name: "owned-host-fixture", version: "1" });
  const web = new Client({ name: "owned-web-fixture", version: "1" });
  t.after(async () => { await host.close(); await web.close(); await hostServer.close(); await http.close(); });
  const [a, b] = InMemoryTransport.createLinkedPair(); await hostServer.connect(a); await host.connect(b);
  await web.connect(new StreamableHTTPClientTransport(new URL(http.endpoint), { requestInit: { headers: { Authorization: `Bearer ${http.bearer}` } } }));
  const webTools = (await web.listTools()).tools.map(t => t.name);
  assert.ok(!webTools.includes("ide_host_result")); assert.ok(!webTools.includes("ide_host_begin"));
  const begin = decode(await host.callTool({ name: "ide_host_begin", arguments: { task_id: "real_task_01", workspace_id: "D:/owned-fixture", tools, ttl_ms: 5000 } }));
  const queued = decode(await web.callTool({ name: "ide_tool_call", arguments: { turn_token: begin.turn_token, call_id: "real_call_01", tool: "read_file", arguments: { path: "fixture.txt" } } }));
  assert.equal(queued.status, "pending");
  const action = decode(await host.callTool({ name: "ide_host_next", arguments: { task_id: begin.taskId } }));
  assert.equal(action.tool, "read_file"); assert.equal(action.workspaceId, "D:/owned-fixture");
  // Explicit fixture result: no native executor or filesystem action is claimed here.
  await host.callTool({ name: "ide_host_result", arguments: { task_id: begin.taskId, call_id: action.callId, result: { fixture: true, text: "fixture content" }, is_error: false } });
  assert.equal(decode(await web.callTool({ name: "ide_tool_result", arguments: { turn_token: begin.turn_token, call_id: action.callId } })).result.text, "fixture content");
  await web.callTool({ name: "ide_tool_call", arguments: { turn_token: begin.turn_token, call_id: "real_call_02", tool: "read_file", arguments: { path: "missing.txt" } } });
  const failed = decode(await host.callTool({ name: "ide_host_next", arguments: { task_id: begin.taskId } }));
  await host.callTool({ name: "ide_host_result", arguments: { task_id: begin.taskId, call_id: failed.callId, result: { fixture: true, error: "File not found" }, is_error: true } });
  assert.equal(decode(await web.callTool({ name: "ide_tool_result", arguments: { turn_token: begin.turn_token, call_id: failed.callId } })).isError, true);
  await web.callTool({ name: "ide_turn_complete", arguments: { turn_token: begin.turn_token, final_text: "Read completed in fixture" } });
  assert.equal(decode(await host.callTool({ name: "ide_host_next", arguments: { task_id: begin.taskId } })).status, "completed");
  const noAuth = await fetch(http.endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(noAuth.status, 401);
  const badOrigin = await fetch(http.endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${http.bearer}`, Origin: "https://untrusted.invalid" }, body: "{}" });
  assert.equal(badOrigin.status, 403);
  const spoof = await web.callTool({ name: "ide_host_result", arguments: {} });
  assert.equal(spoof.isError, true);
});

test("Real host stdio entry creates private HTTP descriptor and closes on client EOF", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-host-test-"));
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("./host-cli.js", import.meta.url))], env: { AG_MCP_HOST_STATE_DIR: directory, AG_MCP_HOST_HTTP_PORT: "0" }, stderr: "pipe" });
  const host = new Client({ name: "owned-native-host-fixture", version: "1" });
  const web = new Client({ name: "owned-custom-app-fixture", version: "1" });
  t.after(async () => { await web.close(); await host.close(); removeOwnedFixture(directory); });
  await host.connect(transport);
  const descriptor = JSON.parse(fs.readFileSync(path.join(directory, "connector.json"), "utf8"));
  assert.equal(descriptor.authentication, "local_bearer");
  const toolNames = (await host.listTools()).tools.map(t => t.name);
  assert.deepEqual(toolNames.sort(), ["ide_host_abort", "ide_host_begin", "ide_host_next", "ide_host_result"]);
  await web.connect(new StreamableHTTPClientTransport(new URL(descriptor.endpoint), { requestInit: { headers: { Authorization: `Bearer ${descriptor.bearerToken}` } } }));
  assert.equal((await web.listTools()).tools.length, 4);
  await web.close(); await host.close();
  const deadline = Date.now() + 5000;
  let closed = false;
  while (Date.now() < deadline) {
    try { await fetch(descriptor.endpoint, { signal: AbortSignal.timeout(500) }); }
    catch { closed = true; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(closed, true, "Shared owner stops after its last frontend disconnects");
});

test("Host task identity is reserved before queueing and cannot replay after process restart", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-host-test-"));
  t.after(() => removeOwnedFixture(directory));
  const file = path.join(directory, "ledger.json");
  const ledger = new HostTaskLedger(file);
  const broker = new HostTurnBroker(undefined, (id, workspace) => ledger.reserve(id, workspace));
  const task = broker.begin("persist_task_01", "private workspace path", tools, 5000);
  broker.enqueue(task.turn_token, "persist_call_01", "read_file", { path: "fixture.txt" });
  broker.next(task.taskId);
  const afterRestart = new HostTaskLedger(file);
  const replacement = new HostTurnBroker(undefined, (id, workspace) => afterRestart.reserve(id, workspace));
  assert.throws(() => replacement.begin(task.taskId, "private workspace path", tools, 5000), { code: "OUTCOME_UNKNOWN" });
  const raw = fs.readFileSync(file, "utf8");
  assert.equal(raw.includes(task.turn_token), false); assert.equal(raw.includes("private workspace path"), false); assert.equal(raw.includes("fixture.txt"), false);
  assert.throws(() => replacement.inventory(task.turn_token), { code: "STALE_AUTHORITY" });
  fs.writeFileSync(file, "[truncated");
  assert.throws(() => new HostTaskLedger(file), { code: "LEDGER_UNAVAILABLE" });
});
