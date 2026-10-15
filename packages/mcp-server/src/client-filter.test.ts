import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { classifyMcpClient, clientPolicyAllows } from "./client-filter.js";
import { removeOwnedFixture } from "./fixture-cleanup.js";

test("MCP client policy separates agy/VS Code from native IDE and permits an explicit any-client override", () => {
  const vscode = [{ name: "agy.exe" }, { name: "Code.exe" }];
  const ide = [{ name: "language_server_windows_x64.exe" }, { name: "Antigravity IDE.exe" }];
  assert.equal(classifyMcpClient(vscode), "agy");
  assert.equal(classifyMcpClient(ide), "antigravity_ide");
  assert.equal(classifyMcpClient([{ name: "agy.exe" }, ...ide]), "antigravity_ide");
  assert.equal(clientPolicyAllows("antigravity_ide", vscode), false);
  assert.equal(clientPolicyAllows("antigravity_ide", ide), true);
  assert.equal(clientPolicyAllows("antigravity_ide", []), false);
  assert.equal(clientPolicyAllows("any", vscode), true);
  assert.equal(clientPolicyAllows("disabled", ide), false);
  assert.throws(() => clientPolicyAllows("typo", ide));
});

test("Filtered host/browser stdio clients initialize with zero tools and never touch receipts, profiles or ownership", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-host-test-"));
  const clients: Client[] = [];
  t.after(async () => { for (const client of clients) await client.close(); removeOwnedFixture(directory); });
  for (const name of ["host-cli.js", "cli.js"]) {
    const client = new Client({ name: "excluded-host-fixture", version: "1" });
    clients.push(client);
    const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL(name, import.meta.url))], env: { AG_MCP_TARGET_CLIENT: "disabled", AG_MCP_HOST_STATE_DIR: path.join(directory, "host-state"), AG_MCP_STATE_DIR: path.join(directory, "browser-state"), AG_MCP_BROWSER_PROFILE: path.join(directory, "profile") }, stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", data => { stderr += String(data); });
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools, []);
    assert.match(client.getInstructions()!, /restricted by AG_MCP_TARGET_CLIENT/);
    assert.equal(stderr, "");
    assert.deepEqual(fs.readdirSync(directory), []);
    await client.close();
  }
});
