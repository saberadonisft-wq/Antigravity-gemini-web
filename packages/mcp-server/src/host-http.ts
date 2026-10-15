import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { HostTurnBroker } from "./host-broker.js";
import { createWebHostServer } from "./host-server.js";

export async function startHostHttp(broker: HostTurnBroker, port = 9234) {
  const bearer = randomBytes(32).toString("base64url");
  const connections = new Set<ReturnType<typeof createWebHostServer>>();
  let endpoint: string;
  let stopping = false;
  const server = http.createServer(async (request, response) => {
    const denied = (status: number) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: "Request rejected" })); };
    if (stopping || connections.size >= 16) return denied(503);
    const expectedHost = new URL(endpoint).host;
    if (request.headers.host !== expectedHost || (request.headers.origin && request.headers.origin !== new URL(endpoint).origin)) return denied(403);
    if (request.url !== "/mcp") return denied(404);
    const auth = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${bearer}`);
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return denied(401);
    if (request.method !== "POST") { response.setHeader("Allow", "POST"); return denied(405); }
    if (!request.headers["content-type"]?.startsWith("application/json")) return denied(415);
    let body: unknown;
    const deadline = setTimeout(() => request.destroy(), 5000);
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 131072) { denied(413); request.destroy(); return; }
        chunks.push(Buffer.from(chunk));
      }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch { if (!response.destroyed) denied(400); return; }
    finally { clearTimeout(deadline); }
    // Stateless MCP transport; task authority lives only in HostTurnBroker, never in HTTP sessions.
    const mcp = createWebHostServer(broker);
    connections.add(mcp);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const close = async () => { connections.delete(mcp); await mcp.close(); };
    response.once("close", () => { void close().catch(() => {}); });
    try { await mcp.connect(transport); await transport.handleRequest(request, response, body); }
    catch { if (!response.headersSent && !response.destroyed) denied(500); }
  });
  server.headersTimeout = 5000; server.requestTimeout = 7000;
  server.keepAliveTimeout = 1000; server.maxHeadersCount = 32;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  return { endpoint, bearer, async close() {
    stopping = true; broker.abort();
    await Promise.all([...connections].map(c => c.close()));
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
