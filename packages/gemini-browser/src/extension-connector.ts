import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { ExtensionCredentials } from "./extension-credentials.js";

const geminiUrl = (value: unknown): value is string => {
  try { const url = new URL(String(value)); return url.origin === "https://gemini.google.com" && !url.username && !url.password; } catch { return false; }
};
const safeEqual = (a: unknown, b: string) => typeof a === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const commands = new Set(["Runtime.evaluate", "Input.insertText", "Input.dispatchMouseEvent", "Emulation.setFocusEmulationEnabled"]);

/** One authenticated extension installation, one account, no Chrome process ownership. */
export async function startExtensionConnector(credentials: ExtensionCredentials, port: number) {
  let extension: WebSocket | undefined, closed = false, sequence = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const workers = new Set<WebSocket>();
  const failPending = () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error("Profile connector disconnected; delivery may be unknown. No command was replayed.")); } pending.clear(); };
  const call = (method: string, params: unknown = {}, targetId?: string) => new Promise<any>((resolve, reject) => {
    if (!extension || extension.readyState !== WebSocket.OPEN || closed) return reject(Error("Chrome profile connector is offline."));
    if (pending.size >= 128) return reject(Error("Connector command limit reached."));
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error("Connector command timed out; no retry was performed.")); }, 15000);
    pending.set(id, { resolve, reject, timer });
    extension.send(JSON.stringify({ id, method, params, targetId }));
  });
  const targetList = async () => {
    const result = await call("Connector.listTargets");
    if (!Array.isArray(result) || result.length > 256) throw Error("Invalid profile target list.");
    return result.filter(t => t && /^tab_[0-9]+$/.test(t.targetId) && geminiUrl(t.url)).map(t => ({ id: t.targetId, targetId: t.targetId, type: "page", url: t.url, title: "Gemini", webSocketDebuggerUrl: `ws://127.0.0.1:${actualPort}/page/${t.targetId}` }));
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.headers.origin || request.headers.host !== `127.0.0.1:${actualPort}` || !safeEqual(request.headers.authorization, "Bearer " + credentials.token)) { response.writeHead(403).end(); return; }
    if (request.method !== "GET") { response.writeHead(405).end(); return; }
    try {
      const value = request.url === "/json/list" ? await targetList() : request.url === "/json/version" ? { webSocketDebuggerUrl: `ws://127.0.0.1:${actualPort}/devtools/browser/connector` } : undefined;
      if (!value) { response.writeHead(404).end(); return; }
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value));
    } catch { response.writeHead(503).end(JSON.stringify({ error: "CONNECTOR_OFFLINE" })); }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  let actualPort = port;
  server.on("upgrade", (request, socket, head) => {
    const extensionOrigin = typeof request.headers.origin === "string" && /^chrome-extension:\/\/[a-p]{32}$/.test(request.headers.origin);
    const worker = !request.headers.origin && /^\/(devtools\/browser\/connector|page\/tab_[0-9]+)$/.test(request.url ?? "");
    if (closed || sockets.clients.size >= 64 || request.headers.host !== `127.0.0.1:${actualPort}` || !(request.url === "/extension" && extensionOrigin || worker)) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, ws => {
      let authenticated = false;
      const authTimer = setTimeout(() => ws.close(1008, "Pairing required"), 3000);
      const reply = (value: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
      ws.on("error", () => {});
      ws.on("message", async data => {
        let message: any; try { message = JSON.parse(data.toString()); } catch { ws.close(1008); return; }
        if (!authenticated) {
          if (message?.type !== "auth" || !safeEqual(message.token, credentials.token) || message.profileId !== credentials.profileId || message.role !== (worker ? "worker" : "extension") || !worker && extension) { ws.close(1008, "Pairing refused"); return; }
          authenticated = true; clearTimeout(authTimer);
          if (worker) workers.add(ws); else extension = ws;
          reply({ type: "ready", profileId: credentials.profileId }); return;
        }
        if (!worker) {
          if (message?.type === "ping") { reply({ type: "pong" }); return; }
          const item = pending.get(message.id); if (!item) return;
          pending.delete(message.id); clearTimeout(item.timer);
          if (message.error) item.reject(Error("Chrome connector command failed: " + String(message.error).slice(0, 160))); else item.resolve(message.result);
          return;
        }
        if (!Number.isSafeInteger(message.id) || message.id <= 0 || typeof message.method !== "string" || !message.params || typeof message.params !== "object" || Array.isArray(message.params)) { ws.close(1008); return; }
        try {
          const method = message.method, params = message.params;
          let result: any;
          if (method === "Connector.profileIdentity") {
            if (!extension) throw Error("Profile is offline.");
            result = { profileId: credentials.profileId, transport: "chrome_extension" };
          } else if (method === "Target.getTargets") result = { targetInfos: await targetList() };
          else if (method === "Target.createTarget") {
            if (!geminiUrl(params.url)) throw Error("Only Gemini pages may be opened.");
            result = await call(method, { url: params.url });
          } else if (method === "Target.closeTarget") {
            if (!/^tab_[0-9]+$/.test(params.targetId)) throw Error("Invalid target.");
            result = await call(method, { targetId: params.targetId });
          } else if (commands.has(method)) {
            const targetId = request.url?.split("/")[2];
            if (!targetId || !/^tab_[0-9]+$/.test(targetId)) throw Error("A profile page target is required.");
            result = await call(method, params, targetId);
          } else throw Error("Unsupported connector operation.");
          reply({ id: message.id, result });
        } catch { reply({ id: message.id, error: { code: -32000, message: "Connector unavailable or operation refused; no retry was performed." } }); }
      });
      ws.on("close", () => {
        clearTimeout(authTimer); workers.delete(ws);
        if (extension === ws) { extension = undefined; failPending(); for (const client of workers) client.close(1011, "Profile disconnected"); }
      });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); actualPort = (server.address() as { port: number }).port; resolve(); }); });
  return { port: actualPort, get connected() { return !!extension; }, async close() { closed = true; failPending(); for (const ws of sockets.clients) ws.terminate(); sockets.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
