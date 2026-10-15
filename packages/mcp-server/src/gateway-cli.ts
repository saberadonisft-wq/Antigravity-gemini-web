import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireOwnership } from "./ownership.js";
import { startOAuthGateway } from "./gateway-http.js";
import { createOwnerPairing, writePrivateFile } from "./gateway-state.js";

const base = path.join(os.homedir(), ".gemini", "antigravity-gemini-web-live", "app_data");
const state = path.resolve(process.env.AG_MCP_GATEWAY_STATE_DIR ?? path.join(base, "mcp-gateway"));
const command = process.argv[2];
async function main() {
  if (command && command !== "--pair") throw Error("Usage: npm run mcp:gateway or npm run mcp:gateway:pair");
  fs.mkdirSync(state, { recursive: true });
  if (command === "--pair") {
    const owner = await acquireOwnership(`gateway-pair:${state}`);
    try {
      const result = createOwnerPairing(state);
      console.log(JSON.stringify({ codeFile: result.codeFile, expiresAt: new Date(result.expiresAt).toISOString(), oneUse: true, instruction: "Open the local code file yourself and enter it only on your gateway consent page. Do not paste it into IDE/Gemini prompts." }));
    } finally { await new Promise<void>(resolve => owner.close(() => resolve())); }
    return;
  }
  const publicUrl = process.env.AG_MCP_PUBLIC_URL;
  if (!publicUrl) throw Error("Set AG_MCP_PUBLIC_URL to your HTTPS gateway origin before starting. No public endpoint is created automatically.");
  const port = Number(process.env.AG_MCP_GATEWAY_PORT ?? 9235);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error("Invalid gateway port");
  const hostState = path.resolve(process.env.AG_MCP_HOST_STATE_DIR ?? path.join(base, "mcp-host"));
  const owner = await acquireOwnership(`oauth-gateway:${state}`);
  let gateway: Awaited<ReturnType<typeof startOAuthGateway>> | undefined;
  try {
    gateway = await startOAuthGateway({ publicUrl, stateDirectory: state, hostDescriptor: path.join(hostState, "connector.json"), port });
    writePrivateFile(path.join(state, "gateway.json"), JSON.stringify({ version: 1, pid: process.pid, issuer: gateway.issuer, endpoint: gateway.endpoint, bind: `127.0.0.1:${gateway.port}`, authentication: "oauth2.1", publicReachability: "not_verified", createdAt: new Date().toISOString() }, null, 2));
  } catch (error) { await gateway?.close(); await new Promise<void>(resolve => owner.close(() => resolve())); throw error; }
  console.log(JSON.stringify({ gateway: "listening", bind: `127.0.0.1:${gateway.port}`, endpoint: gateway.endpoint, authentication: "oauth2.1", publicReachability: "not_verified", instruction: "Configure your HTTPS reverse proxy to preserve Host and set X-Forwarded-Proto: https. Only expose the gateway, never port 9234 or connector.json." }));
  let closing = false;
  const stop = () => {
    if (closing) return; closing = true;
    const deadline = setTimeout(() => process.exit(1), 5000); deadline.unref();
    const finish = (code: number) => owner.close(() => { clearTimeout(deadline); process.exit(code); });
    void gateway!.close().then(() => finish(0), () => finish(1));
  };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
main().catch(() => {
  // Never include raw OAuth state, descriptors or tokens in error output.
  console.error("Gateway could not start. Check AG_MCP_PUBLIC_URL, port, state ownership and private state files. No public endpoint was created.");
  process.exitCode = 1;
});
