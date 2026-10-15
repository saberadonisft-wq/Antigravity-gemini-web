import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LiveGeminiBrowserAdapter } from "@antigravity-gemini-web/gemini-browser";
import { GeminiMcpService } from "./service.js";
import { createGeminiMcpServer } from "./server.js";
import { isMcpClientAllowed, serveFilteredClient } from "./client-filter.js";
import { runSharedStdio, runtimeFingerprint } from "./shared-stdio.js";

if (!process.argv.includes("--shared-service") && !await isMcpClientAllowed()) { await serveFilteredClient("gemini-web-browser"); process.exit(0); }
const root = path.join(os.homedir(), ".gemini", "antigravity-gemini-web-live", "app_data");
const profile = path.resolve(process.env.AG_MCP_BROWSER_PROFILE ?? path.join(root, "browser_profile"));
const state = path.resolve(process.env.AG_MCP_STATE_DIR ?? path.join(root, "mcp"));
const port = Number(process.env.AG_MCP_DEBUG_PORT ?? 9223);
const chromePath = process.env.AG_MCP_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("Invalid CDP port");
if (Number(process.versions.node.split(".")[0]) < 22 || !globalThis.WebSocket) throw Error("Node 22+ required");
try {
  await runSharedStdio({
    scope: `browser:${profile}`, descriptorFile: path.join(profile, "browser-stdio-owner.json"),
    fingerprint: runtimeFingerprint({ version: 2, profile, state, port, chromePath }),
    createRuntime: async () => {
      fs.mkdirSync(state, { recursive: true }); fs.mkdirSync(profile, { recursive: true });
      const browser = new LiveGeminiBrowserAdapter({ userDataDir: profile, debugPort: port, chromePath, headless: false });
      const service = new GeminiMcpService(browser, path.join(state, "receipts.json"));
      return { createServer: () => createGeminiMcpServer(service), close: () => service.close() };
    }
  });
  process.exit(0);
} catch { console.error("Browser MCP runtime unavailable or configuration conflicts with its active owner. No browser prompts were automatically replayed."); process.exit(1); }
