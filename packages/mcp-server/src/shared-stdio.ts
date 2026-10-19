import fs from "node:fs";
import net, { type Socket } from "node:net";
import { spawn } from "node:child_process";
import { z } from "zod";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { acquireOwnership } from "./ownership.js";
import { digest, secret, sameSecret, readPrivateFile, writePrivateFile } from "./gateway-state.js";
import { mcpNodeMemoryArgs, type McpNodeSemiSpace } from "@antigravity-gemini-web/contracts";
import { assertNodeMemoryStartup } from "./node-memory.js";

export interface SharedRuntime { createServer(): McpServer; close(): Promise<void> }
export interface SharedOptions {
  scope: string;
  descriptorFile: string;
  fingerprint: string;
  createRuntime(): Promise<SharedRuntime>;
  onClosing?(): void;
  nodeSemiSpaceMiB?: McpNodeSemiSpace;
}
const Descriptor = z.object({ version: z.literal(1), pid: z.number().int().positive(), port: z.number().int().min(1).max(65535), token: z.string().regex(/^[\w-]{43}$/), scopeHash: z.string().regex(/^[a-f0-9]{64}$/), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
export const runtimeFingerprint = (config: Record<string, string | number>) => digest(JSON.stringify(Object.entries(config).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, typeof value === "string" ? normalize(value) : value])));
const scopeHash = (scope: string) => digest(normalize(scope));
const closeListener = (server: net.Server) => new Promise<void>(resolve => server.close(() => resolve()));

function frame(socket: Socket, timeout: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    const cleanup = () => { socket.off("data", data); socket.off("error", failed); socket.off("end", ended); socket.off("timeout", expired); socket.setTimeout(0); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const ended = () => failed(Error("Private MCP connection closed"));
    const expired = () => failed(Error("Private MCP handshake expired"));
    const data = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 1024) { failed(Error("Private MCP handshake too large")); return; }
      const newline = pending.indexOf(10);
      if (newline < 0) return;
      cleanup(); socket.pause();
      const rest = pending.subarray(newline + 1); if (rest.length) socket.unshift(rest);
      try { const value: unknown = JSON.parse(pending.subarray(0, newline).toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid frame"); resolve(value as Record<string, unknown>); }
      catch { reject(Error("Invalid private MCP handshake")); }
    };
    socket.on("data", data); socket.once("error", failed); socket.once("end", ended); socket.once("timeout", expired); socket.setTimeout(timeout); socket.resume();
  });
}

/** One process owns resources; each authenticated local connection gets its own MCP protocol instance. */
export async function startSharedRuntime(options: SharedOptions) {
  assertNodeMemoryStartup(options.nodeSemiSpaceMiB ?? null);
  const owner = await acquireOwnership(options.scope);
  let runtime: SharedRuntime;
  try { runtime = await options.createRuntime(); }
  catch (error) { await closeListener(owner); throw error; }
  const token = secret(), hash = scopeHash(options.scope);
  const sockets = new Set<Socket>(), servers = new Set<McpServer>();
  let active = 0, stopping = false, idle: ReturnType<typeof setTimeout>;
  let closedResolve!: () => void, closedReject!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => { closedResolve = resolve; closedReject = reject; });
  void closed.catch(() => {});
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    stopping = true; clearTimeout(idle); options.onClosing?.();
    closing = (async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.allSettled([...servers].map(server => server.close()));
      try { await runtime.close(); }
      finally {
        await closeListener(listener);
        try { const data = Descriptor.parse(JSON.parse(readPrivateFile(options.descriptorFile, 2048))); if (data.pid === process.pid && sameSecret(data.token, token)) fs.unlinkSync(options.descriptorFile); } catch {}
        await closeListener(owner);
      }
    })();
    closing.then(closedResolve, closedReject);
    return closing;
  };
  const armIdle = (delay: number) => { clearTimeout(idle); idle = setTimeout(() => { void close().catch(() => {}); }, delay); };
  const listener = net.createServer(socket => {
    if (stopping || sockets.size >= 32) { socket.destroy(); return; }
    sockets.add(socket); socket.setNoDelay(true);
    let mcp: McpServer | undefined, authenticated = false, disconnected = false;
    const disconnect = () => {
      if (disconnected) return; disconnected = true;
      socket.destroy(); sockets.delete(socket);
      if (mcp) { servers.delete(mcp); void mcp.close().catch(() => {}); }
      if (authenticated) { active--; if (!active && !stopping) armIdle(250); }
    };
    socket.once("close", disconnect); socket.once("end", disconnect); socket.once("error", disconnect);
    void (async () => {
      try {
        const auth = await frame(socket, 2000);
        if (disconnected || socket.destroyed) return;
        if (stopping || typeof auth.token !== "string" || !sameSecret(auth.token, token) || auth.scopeHash !== hash || typeof auth.nonce !== "string" || !/^[\w-]{43}$/.test(auth.nonce)) { disconnect(); return; }
        if (auth.fingerprint !== options.fingerprint) { socket.end(JSON.stringify({ error: "CONFIG_CONFLICT", nonce: auth.nonce }) + "\n"); return; }
        authenticated = true; active++; clearTimeout(idle);
        mcp = runtime.createServer(); servers.add(mcp);
        const onclose = mcp.server.onclose;
        mcp.server.onclose = () => { onclose?.(); disconnect(); };
        await mcp.connect(new StdioServerTransport(socket, socket, { maxBufferSize: 2 * 1024 * 1024 }));
        if (disconnected || stopping) { disconnect(); return; }
        socket.write(JSON.stringify({ ready: true, nonce: auth.nonce, scopeHash: hash }) + "\n"); socket.resume();
      } catch { disconnect(); }
    })();
  });
  listener.maxConnections = 32;
  try {
    await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
    const port = (listener.address() as net.AddressInfo).port;
    writePrivateFile(options.descriptorFile, JSON.stringify({ version: 1, pid: process.pid, port, token, scopeHash: hash, fingerprint: options.fingerprint }));
    armIdle(10000); // An abandoned startup is bounded even when its frontend is killed before connecting.
    return { port, closed, close };
  } catch (error) { await close(); throw error; }
}

async function connectShared(options: SharedOptions, timeout: number): Promise<Socket> {
  const data = Descriptor.parse(JSON.parse(readPrivateFile(options.descriptorFile, 2048)));
  if (data.scopeHash !== scopeHash(options.scope)) throw Error("Private MCP scope does not match");
  const socket = net.createConnection({ host: "127.0.0.1", port: data.port });
  socket.setNoDelay(true);
  const nonce = secret();
  const response = frame(socket, timeout);
  socket.once("connect", () => socket.write(JSON.stringify({ token: data.token, scopeHash: data.scopeHash, fingerprint: options.fingerprint, nonce }) + "\n"));
  try {
    const ready = await response;
    if (ready.nonce !== nonce) throw Error("Invalid private MCP response");
    if (ready.error === "CONFIG_CONFLICT") throw Object.assign(Error("An active MCP runtime uses different receipt/profile/port settings. Keep all clients on the same configuration."), { code: "CONFIG_CONFLICT" });
    if (ready.ready !== true || ready.scopeHash !== data.scopeHash) throw Error("Private MCP runtime unavailable");
    return socket;
  } catch (error) { socket.destroy(); throw error; }
}

async function startOrConnect(options: SharedOptions): Promise<Socket> {
  const deadline = performance.now() + 10000;
  let bootstrap: net.Server | undefined, spawned = false;
  try {
    while (performance.now() < deadline) {
      try { return await connectShared(options, Math.max(1, Math.min(1000, deadline - performance.now()))); }
      catch (error) { if ((error as { code?: string }).code === "CONFIG_CONFLICT") throw error; }
      if (!bootstrap) { try { bootstrap = await acquireOwnership(`bootstrap:${options.scope}`); } catch {} }
      if (bootstrap && !spawned) {
        let probe: net.Server | undefined;
        try { probe = await acquireOwnership(options.scope); } catch {}
        if (probe) {
          await closeListener(probe);
          const child = spawn(process.execPath, [...mcpNodeMemoryArgs(options.nodeSemiSpaceMiB ?? null), process.argv[1], "--shared-service"], { env: process.env, detached: true, windowsHide: true, stdio: "ignore" });
          child.on("error", () => {}); child.unref(); spawned = true;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error("Shared MCP runtime could not start within its budget. Check configuration or restart a legacy bridge; no requests were replayed.");
  } finally { if (bootstrap) await closeListener(bootstrap); }
}

export async function runSharedStdio(options: SharedOptions) {
  if (process.argv.includes("--shared-service")) {
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const owner = await startSharedRuntime({ ...options, onClosing: () => { watchdog = setTimeout(() => process.exit(1), 7500); watchdog.unref(); } });
    const stop = () => { void owner.close().catch(() => {}); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try { await owner.closed; } finally { clearTimeout(watchdog); }
    return;
  }
  const socket = await startOrConnect(options);
  await new Promise<void>(resolve => {
    let stopped = false;
    const stop = () => { if (stopped) return; stopped = true; process.stdin.unpipe(socket); socket.unpipe(process.stdout); socket.destroy(); resolve(); };
    process.stdin.once("end", stop); process.stdin.once("close", stop); process.stdin.once("error", stop);
    process.stdout.once("error", stop); socket.once("end", stop); socket.once("close", stop); socket.once("error", stop);
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    // Only the initial private handshake can retry. Once bytes flow, a disconnect ends this frontend.
    process.stdin.pipe(socket); socket.pipe(process.stdout);
  });
}
