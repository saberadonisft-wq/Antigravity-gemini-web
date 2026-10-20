import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LiveGeminiBrowserAdapter, extensionCredentials, startExtensionConnector, configureExtensionCdp } from "@antigravity-gemini-web/gemini-browser";
import { createHash } from "node:crypto";
import { GeminiMcpService } from "./service.js";
import { createGeminiMcpServer } from "./server.js";
import { isMcpClientAllowed, serveFilteredClient } from "./client-filter.js";
import { runSharedStdio, runtimeFingerprint } from "./shared-stdio.js";
import { parseMcpNodeSemiSpace } from "@antigravity-gemini-web/contracts";

if (!process.argv.includes("--shared-service") && !await isMcpClientAllowed()) { await serveFilteredClient("gemini-web-browser"); process.exit(0); }
const root = path.join(os.homedir(), ".gemini", "antigravity-gemini-web-live", "app_data");
const profile = path.resolve(process.env.AG_MCP_BROWSER_PROFILE ?? path.join(root, "browser_profile"));
const state = path.resolve(process.env.AG_MCP_STATE_DIR ?? path.join(root, "mcp"));
const port = Number(process.env.AG_MCP_DEBUG_PORT ?? 9223);
const nodeSemiSpaceMiB = parseMcpNodeSemiSpace(process.env.AG_MCP_NODE_SEMI_SPACE_MB);
const chromePath = process.env.AG_MCP_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const transport = process.env.AG_MCP_BROWSER_TRANSPORT ?? "cdp";
if (transport !== "cdp" && transport !== "extension") throw Error("Invalid browser transport");
const connector = transport === "extension" ? extensionCredentials(profile) : undefined;
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("Invalid CDP port");
const [nodeMajor,nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || nodeMajor === 23 || (nodeMajor === 22 && nodeMinor < 13) || !globalThis.WebSocket) throw Error("Node 22.13+ (22.x) or Node 24+ with built-in SQLite required");
try {
  await runSharedStdio({
    scope: `browser:${profile}`, descriptorFile: path.join(profile, "browser-stdio-owner.json"),
    fingerprint: runtimeFingerprint({ version: 27, profile, state, port, chromePath, transport, connectorIdentity:connector ? createHash("sha256").update(JSON.stringify(connector)).digest("hex") : "", nodeSemiSpaceMiB: nodeSemiSpaceMiB ?? 0 }),
    nodeSemiSpaceMiB,
    createRuntime: async () => {
      fs.mkdirSync(state, { recursive: true }); fs.mkdirSync(profile, { recursive: true });
      const connectorServer = connector ? await startExtensionConnector(connector, port) : undefined;
      if (connector) configureExtensionCdp({port, ...connector});
      const browser = new LiveGeminiBrowserAdapter({ userDataDir: profile, debugPort: port, chromePath, headless: false, requireProfileIdentity: true, connectorProfileId:connector?.profileId });
      const service = new GeminiMcpService(browser, path.join(state, "receipts.json"), nodeSemiSpaceMiB);
      return { createServer: () => createGeminiMcpServer(service), close: async () => { try { await service.close(); } finally { await connectorServer?.close(); configureExtensionCdp(); } } };
    }
  });
  process.exit(0);
} catch { console.error("Browser MCP runtime unavailable or configuration conflicts with its active owner. No browser prompts were automatically replayed."); process.exit(1); }
