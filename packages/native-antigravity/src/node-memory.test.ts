import test from "node:test";
import assert from "node:assert/strict";
import { McpNativeBrowserBackend } from "./browser-backend.js";
import { NativeRouteError, type JsonObject } from "./native-protocol.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { NativeBrowserBackendPool } from "./browser-backend-pool.js";
import { AccountRegistry } from "./account-registry.js";

function backend(memory: unknown, policy = "8") {
  const value = new McpNativeBrowserBackend("unused", { AG_MCP_NODE_SEMI_SPACE_MB: policy });
  const calls: string[] = [];
  Object.assign(value, { connect: async () => {} });
  const client = (value as unknown as { client: { callTool(args: { name: string }): Promise<unknown> } }).client;
  client.callTool = async ({ name }) => {
    calls.push(name);
    const status: JsonObject = { browserState: "ready", accountState: "signed_in", activeRequestId: null, ...(memory === undefined ? {} : { nodeMemory: memory }) };
    return { content: [{ type: "text", text: JSON.stringify(name === "gemini_status" ? status : { opened: true }) }] };
  };
  return { value, calls };
}
const applied = { scope: "shared_owner", pid: 123, requestedSemiSpaceMiB: 8, explicitCliSemiSpaceMiB: 8, status: "applied" };

test("A missing, wrong-owner or forged Node policy blocks before every browser action and Send", async () => {
  for (const memory of [undefined, { ...applied, scope: "frontend" }, { ...applied, explicitCliSemiSpaceMiB: 16 }, { ...applied, requestedSemiSpaceMiB: 16, explicitCliSemiSpaceMiB: 16 }]) {
    const { value, calls } = backend(memory);
    await assert.rejects(value.generate("memory_request_001", "Synthetic context", new AbortController().signal), error => {
      assert.ok(error instanceof NativeRouteError); assert.equal(error.code, "BROWSER_RUNTIME_UPDATE_REQUIRED");
      assert.equal(error.delivery, "not_sent"); assert.equal(error.phase, "checkpoint"); return true;
    });
    assert.deepEqual(calls, ["gemini_status"]);
    calls.length = 0;
    await assert.rejects(value.openBrowser(), { code: "BROWSER_RUNTIME_UPDATE_REQUIRED" });
    assert.deepEqual(calls, ["gemini_status"]);
    await value.close();
  }
});
test("A verified policy permits readiness while off preserves compatibility with legacy status", async () => {
  for (const [memory, policy] of [[applied, "8"], [undefined, "off"]] as const) {
    const { value, calls } = backend(memory, policy);
    await value.prepare(new AbortController().signal);
    assert.deepEqual(calls, ["gemini_status"]);
    await value.close();
  }
});
test("Invalid startup policy is rejected before connecting to any browser worker", () => {
  assert.throws(() => new McpNativeBrowserBackend("unused", { AG_MCP_NODE_SEMI_SPACE_MB: "8 --inspect" }), /must be off, 8, or 16/);
});

test("Actual Native frontend and shared owner retain their captured startup policy after environment changes", { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-test-native-memory-"));
  const previous = process.env.AG_MCP_NODE_SEMI_SPACE_MB;
  const descriptor = path.join(root, "profile/browser-stdio-owner.json");
  let value: McpNativeBrowserBackend | undefined, pool: NativeBrowserBackendPool | undefined;
  try {
    const server = net.createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve()));
    process.env.AG_MCP_NODE_SEMI_SPACE_MB = "8";
    pool = new NativeBrowserBackendPool(new AccountRegistry(path.join(root, "accounts.json")), "unused");
    value = new McpNativeBrowserBackend(fileURLToPath(new URL("../../mcp-server/dist/testing/node-memory-startup-fixture.js", import.meta.url)), {
      AG_MCP_BROWSER_PROFILE: path.join(root, "profile"), AG_MCP_STATE_DIR: path.join(root, "state"), AG_MCP_DEBUG_PORT: String(port), NODE_OPTIONS: "",
    });
    process.env.AG_MCP_NODE_SEMI_SPACE_MB = "16";
    assert.equal(pool.resourceStatus().requestedNodeSemiSpaceMiB, 8);
    // The fixture entry asserts policy 8 in BOTH processes before importing the
    // production CLI. Receipt inspection connects without opening Chrome.
    const receipt = await value.inspectReceipt("memory_startup_probe", new AbortController().signal);
    assert.equal(receipt.found, false); assert.equal(receipt.replayAllowed, false);
    assert.ok(JSON.parse(fs.readFileSync(descriptor, "utf8")).pid > 0);
  } finally {
    if (previous === undefined) delete process.env.AG_MCP_NODE_SEMI_SPACE_MB; else process.env.AG_MCP_NODE_SEMI_SPACE_MB = previous;
    await value?.close(); await pool?.close();
    const deadline = performance.now() + 5000;
    while (fs.existsSync(descriptor)) { assert.ok(performance.now() < deadline, "Owned memory worker cleanup timeout"); await new Promise(resolve => setTimeout(resolve, 25)); }
    const target = fs.realpathSync(root); assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase()); assert.match(path.basename(target), /^gemini-mcp-test-native-memory-/);
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
