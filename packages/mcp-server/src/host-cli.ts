import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostTurnBroker } from "./host-broker.js";
import { createHostServer } from "./host-server.js";
import { startHostHttp } from "./host-http.js";
import { HostTaskLedger } from "./task-ledger.js";
import { isMcpClientAllowed, serveFilteredClient } from "./client-filter.js";
import { runSharedStdio, runtimeFingerprint } from "./shared-stdio.js";
import { writePrivateFile } from "./gateway-state.js";

if (!process.argv.includes("--shared-service") && !await isMcpClientAllowed()) { await serveFilteredClient("gemini-ide-host"); process.exit(0); }
const state = path.resolve(process.env.AG_MCP_HOST_STATE_DIR ?? path.join(os.homedir(), ".gemini", "antigravity-gemini-web-live", "app_data", "mcp-host"));
const port = Number(process.env.AG_MCP_HOST_HTTP_PORT ?? 9234);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error("Invalid host MCP port");
try {
  await runSharedStdio({
    scope: `host-ledger:${state}`, descriptorFile: path.join(state, "host-stdio-owner.json"),
    fingerprint: runtimeFingerprint({ version: 1, state, port }),
    createRuntime: async () => {
      fs.mkdirSync(state, { recursive: true });
      const ledger = new HostTaskLedger(path.join(state, "task-receipts.json"));
      const broker = new HostTurnBroker(undefined, (task, workspace) => ledger.reserve(task, workspace));
      const http = await startHostHttp(broker, port);
      try { writePrivateFile(path.join(state, "connector.json"), JSON.stringify({ version: 1, pid: process.pid, endpoint: http.endpoint, bearerToken: http.bearer, authentication: "local_bearer", oauthGateway: "not_configured", createdAt: new Date().toISOString() })); }
      catch (error) { await http.close(); throw error; }
      return { createServer: () => createHostServer(broker), close: () => http.close() };
    }
  });
  process.exit(0);
} catch { console.error("Host MCP runtime unavailable or configuration conflicts with its active owner. No requests were automatically replayed."); process.exit(1); }
