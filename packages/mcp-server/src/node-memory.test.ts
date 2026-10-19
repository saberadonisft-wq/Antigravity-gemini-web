import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpNodeMemoryStatusSchema } from "@antigravity-gemini-web/contracts";
import { describeNodeMemoryPolicy } from "./node-memory.js";
import { startSharedRuntime } from "./shared-stdio.js";
import { removeOwnedFixture } from "./fixture-cleanup.js";

test("Startup diagnostics follow the last explicit CLI value and distinguish an unrequested policy", () => {
  assert.equal(describeNodeMemoryPolicy(8, ["--max-semi-space-size=8"]).status, "applied");
  assert.equal(describeNodeMemoryPolicy(8, ["--max-semi-space-size=8", "--max_semi_space_size", "16"]).status, "mismatch");
  assert.equal(describeNodeMemoryPolicy(null, ["--max-semi-space-size=16"]).status, "not_requested");
});
test("A missing owner startup flag fails before constructing a runtime or acquiring its scope", async () => {
  const requested = describeNodeMemoryPolicy(8).status === "applied" ? 16 : 8;
  let constructed = 0;
  await assert.rejects(startSharedRuntime({ scope: "unused-memory-fixture", descriptorFile: "unused", fingerprint: "a".repeat(64), nodeSemiSpaceMiB: requested, createRuntime: async () => { constructed++; throw Error("Must not construct a browser"); } }), /did not reach the shared owner/);
  assert.equal(constructed, 0);
});

test("Production CLI bootstrap applies policy on the owner, preserves a conflicting active worker and never opens Chrome", { timeout: 25000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-test-node-memory-"));
  const cli = fileURLToPath(new URL("cli.js", import.meta.url));
  const clients: Client[] = [], descriptors: string[] = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    const deadline = performance.now() + 5000;
    while (descriptors.some(name => fs.existsSync(name))) {
      assert.ok(performance.now() < deadline, "Owned browser owner did not finish cleanup");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    removeOwnedFixture(root);
  });
  const portServer = net.createServer();
  await new Promise<void>(resolve => portServer.listen(0, "127.0.0.1", resolve));
  const port = (portServer.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => portServer.close(() => resolve()));
  const environment = (label: string, policy: string) => ({ ...process.env, NODE_OPTIONS: "", AG_MCP_TARGET_CLIENT: "any", AG_MCP_NODE_SEMI_SPACE_MB: policy, AG_MCP_BROWSER_PROFILE: path.join(root, label, "profile"), AG_MCP_STATE_DIR: path.join(root, label, "state"), AG_MCP_DEBUG_PORT: String(port) });
  const connect = async (label: string, policy: string) => {
    const client = new Client({ name: "node-memory-fixture", version: "1" }); clients.push(client);
    // No frontend Node flag: the actual bootstrap must put it on the shared owner.
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli], env: environment(label, policy), stderr: "pipe" });
    await client.connect(transport, { timeout: 8000 });
    return { client, transport };
  };
  const status = async (client: Client) => {
    const response = await client.callTool({ name: "gemini_status", arguments: {} }); assert.ok(!response.isError);
    return JSON.parse((response.content as { text: string }[])[0].text);
  };
  for (const policy of ["8", "16", "off"]) {
    const descriptorFile = path.join(root, policy, "profile/browser-stdio-owner.json"); descriptors.push(descriptorFile);
    const { client, transport } = await connect(policy, policy), observed = await status(client);
    const memory = McpNodeMemoryStatusSchema.parse(observed.nodeMemory);
    const descriptor = JSON.parse(fs.readFileSync(descriptorFile, "utf8"));
    assert.equal(memory.pid, descriptor.pid); assert.notEqual(memory.pid, transport.pid);
    assert.equal(memory.requestedSemiSpaceMiB, policy === "off" ? null : Number(policy));
    assert.equal(memory.explicitCliSemiSpaceMiB, policy === "off" ? null : Number(policy));
    assert.equal(memory.status, policy === "off" ? "not_requested" : "applied");
    assert.notEqual(observed.browserState, "ready"); assert.equal(observed.activeRequestId, null);
    if (policy === "8") {
      await assert.rejects(connect(policy, "16"));
      assert.equal(JSON.parse(fs.readFileSync(descriptorFile, "utf8")).pid, descriptor.pid);
      assert.equal((await status(client)).nodeMemory.pid, descriptor.pid);
    }
  }
  const env = environment("missing-startup-flag", "8");
  await assert.rejects(promisify(execFile)(process.execPath, [cli, "--shared-service"], { env, windowsHide: true, timeout: 5000 }), error => { assert.equal((error as { code: number }).code, 1); return true; });
  assert.equal(fs.existsSync(env.AG_MCP_BROWSER_PROFILE), false);
});
