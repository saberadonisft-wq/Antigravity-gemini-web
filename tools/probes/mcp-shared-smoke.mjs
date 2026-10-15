import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const base = path.join(os.homedir(), ".gemini", "antigravity-gemini-web-live", "app_data");
const owners = () => ({ host: JSON.parse(fs.readFileSync(path.join(base, "mcp-host", "host-stdio-owner.json"), "utf8")).pid, browser: JSON.parse(fs.readFileSync(path.join(base, "browser_profile", "browser-stdio-owner.json"), "utf8")).pid });
const clients = [];
const waitFile = process.argv[2] === "--wait-for" ? path.resolve(process.argv[3] ?? "") : undefined;
if (process.argv.length > 2 && !waitFile) throw Error("Only --wait-for <owned .tmp marker> is supported");
if (waitFile && (path.dirname(waitFile) !== path.join(root, ".tmp") || !/^mcp-shared-probe-[\w-]+\.ready$/.test(path.basename(waitFile)) || fs.existsSync(waitFile))) throw Error("A fresh probe marker under the project .tmp directory is required");
const watchdog = setTimeout(() => { console.error("Read-only shared MCP probe exceeded its budget"); process.exit(1); }, 55000);
try {
  const before = owners(); // Require the IDE-owned runtime to be running before starting this probe.
  for (let pair = 0; pair < 2; pair++) for (const file of ["host-cli.js", "cli.js"]) {
    const client = new Client({ name: `parallel-readonly-${pair}-${file}`, version: "1" });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "packages", "mcp-server", "dist", file)], env: { AG_MCP_TARGET_CLIENT: "any" }, stderr: "pipe" }));
  }
  const counts = await Promise.all(clients.map(async client => (await client.listTools()).tools.length));
  if (String(counts) !== "4,5,4,5") throw Error("Unexpected tool inventory");
  console.log(JSON.stringify({ phase: "connected", clientPairs: 2, toolCounts: counts, ownerPids: before, readOnly: true }));
  if (waitFile) {
    const deadline = Date.now() + 40000;
    while (!fs.existsSync(waitFile)) {
      if (Date.now() >= deadline) throw Error("UI refresh observation budget exceeded");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const status = JSON.parse((await clients[1].callTool({ name: "gemini_status", arguments: {} })).content[0].text);
  const after = owners();
  if (before.host !== after.host || before.browser !== after.browser) throw Error("Shared owner changed while a frontend was still connected");
  await Promise.all(clients.map(client => client.close()));
  await new Promise(resolve => setTimeout(resolve, 400));
  const retained = owners();
  if (before.host !== retained.host || before.browser !== retained.browser) throw Error("Closing probes terminated the IDE's runtime");
  const evidence = { version: 1, checkedAt: new Date().toISOString(), result: "PASS", clientPairs: 2, toolCounts: counts, ownersBefore: before, ownersAfterRefresh: after, ownersAfterProbeClose: retained, uiRefreshWhileConnected: Boolean(waitFile), browserState: status.browserState, accountState: status.accountState, activeRequestId: status.activeRequestId, readOnly: true, promptsSent: 0, nativeToolsExecuted: 0 };
  fs.writeFileSync(path.join(root, "docs/evidence/mcp/shared-live-status.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence));
} catch { console.error("Read-only shared MCP validation failed; no browser prompt or host task was submitted."); process.exitCode = 1; }
finally { await Promise.allSettled(clients.map(client => client.close())); clearTimeout(watchdog); }
