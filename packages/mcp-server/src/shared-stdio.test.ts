import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { GeminiBrowserAdapter, PromptTurnResponse } from "@antigravity-gemini-web/gemini-browser";
import { startSharedRuntime, runtimeFingerprint } from "./shared-stdio.js";
import { digest, secret } from "./gateway-state.js";
import { GeminiMcpService } from "./service.js";
import { createGeminiMcpServer } from "./server.js";
import { removeOwnedFixture } from "./fixture-cleanup.js";

const decode = (result: unknown): Record<string, any> => JSON.parse((result as { content: { text: string }[] }).content[0].text);
const entry = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const waitFor = async (check: () => boolean | Promise<boolean>, budget = 5000) => {
  const deadline = Date.now() + budget;
  while (!await check()) { if (Date.now() >= deadline) throw Error("Owned shared-runtime deadline exceeded"); await new Promise(resolve => setTimeout(resolve, 25)); }
};

test("Parallel native host frontends share one owner; task authority remains bound to its original connection", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-host-test-"));
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await waitFor(() => !fs.existsSync(path.join(directory, "host-stdio-owner.json")));
    removeOwnedFixture(directory);
  });
  const params = { command: process.execPath, args: [entry("host-cli.js")], env: { AG_MCP_TARGET_CLIENT: "any", AG_MCP_HOST_STATE_DIR: directory, AG_MCP_HOST_HTTP_PORT: "0" }, stderr: "pipe" as const };
  const a = new Client({ name: "native-window-a", version: "1" }), b = new Client({ name: "native-window-b", version: "1" }); clients.push(a, b);
  const ta = new StdioClientTransport(params), tb = new StdioClientTransport(params);
  await Promise.all([a.connect(ta), b.connect(tb)]);
  const descriptor = JSON.parse(fs.readFileSync(path.join(directory, "connector.json"), "utf8"));
  const owner = JSON.parse(fs.readFileSync(path.join(directory, "host-stdio-owner.json"), "utf8"));
  assert.equal(owner.pid, descriptor.pid); assert.notEqual(owner.pid, ta.pid); assert.notEqual(owner.pid, tb.pid);
  assert.equal((await a.listTools()).tools.length, 4); assert.equal((await b.listTools()).tools.length, 4);
  const tools = [{ name: "read_file", description: "Owned fixture inventory", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
  const task = decode(await a.callTool({ name: "ide_host_begin", arguments: { task_id: "shared_task_a1", workspace_id: "owned workspace", tools, ttl_ms: 10000 } }));
  assert.equal(decode(await b.callTool({ name: "ide_host_next", arguments: { task_id: task.taskId } })).code, "STALE_AUTHORITY");
  assert.equal(decode(await b.callTool({ name: "ide_host_abort", arguments: { task_id: task.taskId } })).code, "STALE_AUTHORITY");
  assert.equal(decode(await b.callTool({ name: "ide_host_begin", arguments: { task_id: "shared_task_b1", workspace_id: "other workspace", tools } })).code, "BUSY");
  const web = new Client({ name: "labelled-web-fixture", version: "1" }); clients.push(web);
  await web.connect(new StreamableHTTPClientTransport(new URL(descriptor.endpoint), { requestInit: { headers: { Authorization: `Bearer ${descriptor.bearerToken}` } } }));
  await web.callTool({ name: "ide_tool_call", arguments: { turn_token: task.turn_token, call_id: "shared_call_a1", tool: "read_file", arguments: { path: "fixture.txt" } } });
  assert.equal(decode(await a.callTool({ name: "ide_host_next", arguments: { task_id: task.taskId } })).status, "action");
  assert.equal(decode(await a.callTool({ name: "ide_host_next", arguments: { task_id: task.taskId } })).status, "awaiting_result");
  assert.equal(decode(await b.callTool({ name: "ide_host_result", arguments: { task_id: task.taskId, call_id: "shared_call_a1", result: "forged", is_error: false } })).code, "STALE_AUTHORITY");
  await a.close();
  await waitFor(async () => decode(await web.callTool({ name: "ide_tool_result", arguments: { turn_token: task.turn_token, call_id: "shared_call_a1" } })).code === "OUTCOME_UNKNOWN");
  assert.equal((await b.listTools()).tools.length, 4);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "connector.json"), "utf8")).pid, descriptor.pid, "Closing one frontend must not kill the owner used by the other");
  const next = decode(await b.callTool({ name: "ide_host_begin", arguments: { task_id: "shared_task_b2", workspace_id: "other workspace", tools } }));
  assert.ok(next.turn_token);
  await b.close(); await web.close();
  await waitFor(() => !fs.existsSync(path.join(directory, "host-stdio-owner.json")));
  const c = new Client({ name: "explicit-reconnect", version: "1" }); clients.push(c);
  await c.connect(new StdioClientTransport(params));
  assert.equal(decode(await c.callTool({ name: "ide_host_begin", arguments: { task_id: next.taskId, workspace_id: "other workspace", tools } })).code, "OUTCOME_UNKNOWN", "Restart must not replay the old host task");
});

test("Two browser MCP frontends share deduplication and results; closing one keeps the in-flight request alive", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-test-"));
  const scope = `fixture:${directory}`, descriptorFile = path.join(directory, "owner.json"), fingerprint = runtimeFingerprint({ version: 1, directory });
  let complete!: (value: PromptTurnResponse) => void;
  const response = new Promise<PromptTurnResponse>(resolve => { complete = resolve; });
  const stats = { sends: 0, cleaned: 0 };
  const adapter: GeminiBrowserAdapter = {
    checkStatus: async () => ({ browserState: "ready", accountState: "signed_in", checkedAt: new Date().toISOString() }),
    openBrowser: async () => ({ opened: true }),
    submitPrompt: async turnId => { stats.sends++; return { turnId, submittedAt: new Date().toISOString(), status: "accepted" }; },
    pollResponse: async () => response,
    cancelPrompt: async turnId => ({ turnId, cancelled: false }),
    cleanup: async () => { stats.cleaned++; complete({ turnId: "fixture", status: "failed", text: "", completedAt: new Date().toISOString() }); },
    sendPrompt: async () => { throw Error("Receipt API only"); }
  };
  const service = new GeminiMcpService(adapter, path.join(directory, "receipts.json"));
  const owner = await startSharedRuntime({ scope, descriptorFile, fingerprint, createRuntime: async () => ({ createServer: () => createGeminiMcpServer(service), close: () => service.close() }) });
  const clients: Client[] = [];
  t.after(async () => { for (const client of clients) await client.close(); await owner.close(); removeOwnedFixture(directory); });
  const params = { command: process.execPath, args: [entry("testing/shared-client-fixture.js")], env: { AG_TEST_SCOPE: scope, AG_TEST_DESCRIPTOR: descriptorFile, AG_TEST_FINGERPRINT: fingerprint }, stderr: "pipe" as const };
  const a = new Client({ name: "browser-window-a", version: "1" }), b = new Client({ name: "browser-window-b", version: "1" }); clients.push(a, b);
  await Promise.all([a.connect(new StdioClientTransport(params)), b.connect(new StdioClientTransport(params))]);
  const args = { request_id: "shared_browser_request", prompt: "labelled fixture only" };
  await Promise.all([a.callTool({ name: "gemini_submit", arguments: args }), b.callTool({ name: "gemini_submit", arguments: args })]);
  await waitFor(() => stats.sends === 1);
  await a.close(); assert.equal(stats.cleaned, 0);
  assert.equal(decode(await b.callTool({ name: "gemini_result", arguments: { request_id: args.request_id, wait_ms: 1 } })).status, "pending");
  complete({ turnId: args.request_id, status: "completed", text: "labelled fixture result", completedAt: new Date().toISOString() });
  assert.equal(decode(await b.callTool({ name: "gemini_result", arguments: { request_id: args.request_id, wait_ms: 100 } })).text, "labelled fixture result");
  await b.close(); await owner.closed;
  assert.equal(stats.cleaned, 1); assert.equal(fs.existsSync(descriptorFile), false);
});

test("Private shared endpoint rejects unauthenticated/scope-mismatched sockets before exposing MCP tools", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-test-"));
  const scope = `private-fixture:${directory}`, descriptorFile = path.join(directory, "owner.json"), fingerprint = runtimeFingerprint({ directory });
  let created = 0;
  const owner = await startSharedRuntime({ scope, descriptorFile, fingerprint, createRuntime: async () => ({ createServer: () => { created++; throw Error("Untrusted input must not create a protocol instance"); }, close: async () => {} }) });
  t.after(async () => { await owner.close(); removeOwnedFixture(directory); });
  const descriptor = JSON.parse(fs.readFileSync(descriptorFile, "utf8"));
  for (const request of [{ jsonrpc: "2.0", id: 1, method: "initialize" }, { token: "wrong", scopeHash: descriptor.scopeHash, fingerprint, nonce: secret() }, { token: descriptor.token, scopeHash: digest("different scope"), fingerprint, nonce: secret() }]) {
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: owner.port });
      socket.on("error", reject); socket.setTimeout(3000, () => { socket.destroy(); reject(Error("Unauthenticated socket was not closed")); });
      socket.once("connect", () => socket.write(JSON.stringify(request) + "\n"));
      socket.once("close", () => resolve());
    });
  }
  assert.equal(created, 0);
});
