import http from "node:http";
import { isIP } from "node:net";
import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { GatewayOAuth } from "./gateway-oauth.js";
import { readPrivateFile } from "./gateway-state.js";

export function publicIssuer(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || isIP(url.hostname) || !url.hostname.includes(".") || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local")) throw Error("AG_MCP_PUBLIC_URL must be an HTTPS domain at the origin root, without credentials/query/fragment.");
  return url;
}

const Descriptor = z.object({ version: z.literal(1), pid: z.number().int().positive(), endpoint: z.string(), bearerToken: z.string().regex(/^[a-zA-Z0-9_-]{43}$/), authentication: z.literal("local_bearer") });
export function readHostDescriptor(file: string) {
  const data = Descriptor.parse(JSON.parse(readPrivateFile(file, 4096)));
  const url = new URL(data.endpoint);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/mcp" || url.search || url.hash || url.username || url.password) throw Error("Invalid loopback backend descriptor");
  return { endpoint: url.href, bearer: data.bearerToken };
}

export async function startOAuthGateway(options: { publicUrl: string; stateDirectory: string; hostDescriptor: string; port?: number; now?: () => number }) {
  const issuer = publicIssuer(options.publicUrl);
  const resource = new URL("/mcp", issuer);
  const provider = new GatewayOAuth(options.stateDirectory, issuer, resource, options.now);
  const app = express();
  app.disable("x-powered-by");
  // Trust only our loopback TLS proxy, never client-provided forwarded IPs or URL-derived issuers.
  app.set("trust proxy", false);
  let active = 0, stopping = false;
  const forwarding = new Set<AbortController>();
  app.use((request, response, next) => {
    response.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", "Strict-Transport-Security": "max-age=31536000" });
    if (stopping || active >= 16) { response.status(503).json({ error: "temporarily_unavailable" }); return; }
    if (request.headers.host !== issuer.host || request.headers["x-forwarded-proto"] !== "https" || request.url.length > 8192) { response.status(403).json({ error: "access_denied" }); return; }
    delete request.headers["x-forwarded-for"]; delete request.headers.forwarded;
    active++;
    let released = false;
    const release = () => { if (!released) { released = true; active--; } };
    response.once("finish", release); response.once("close", release);
    const deadline = setTimeout(() => { if (!request.complete) request.destroy(); }, 5000);
    request.once("end", () => clearTimeout(deadline)); response.once("close", () => clearTimeout(deadline));
    next();
  });
  app.use(["/register"], express.json({ limit: "32kb" }));
  app.use(["/authorize", "/token", "/revoke", "/consent"], express.urlencoded({ extended: false, limit: "8kb", parameterLimit: 32 }));
  app.use(mcpAuthRouter({ provider, issuerUrl: issuer, resourceServerUrl: resource, scopesSupported: ["ide.tools"], resourceName: "Gemini IDE task tools" }));
  app.post("/consent", (request, response) => provider.consent(request, response));
  app.get("/health", (_request, response) => response.json({ gateway: "ready", authentication: "oauth2.1", backend: "descriptor_configured", publicReachability: "not_verified", nativeInference: "unverified" }));
  app.all("/mcp", (request, response, next) => {
    if (request.headers.origin && request.headers.origin !== issuer.origin) { response.status(403).json({ error: "access_denied" }); return; }
    next();
  }, requireBearerAuth({ verifier: provider, requiredScopes: ["ide.tools"], expectedResource: resource, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource) }), express.json({ limit: "128kb" }), async (request, response) => {
    if (request.method !== "POST") { response.set("Allow", "POST").status(405).json({ error: "method_not_allowed" }); return; }
    if (!request.is("application/json")) { response.status(415).json({ error: "invalid_request" }); return; }
    const abort = new AbortController();
    forwarding.add(abort);
    const disconnect = () => abort.abort();
    response.once("close", disconnect);
    try {
      // Re-read on each request: IDE restarts rotate its bearer and task capabilities. No retry/replay.
      const backend = readHostDescriptor(options.hostDescriptor);
      const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${backend.bearer}` };
      const version = request.headers["mcp-protocol-version"];
      if (typeof version === "string" && /^\d{4}-\d{2}-\d{2}$/.test(version)) headers["MCP-Protocol-Version"] = version;
      const upstream = await fetch(backend.endpoint, { method: "POST", headers, body: JSON.stringify(request.body), redirect: "error", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) });
      if ([202, 204].includes(upstream.status)) { await upstream.body?.cancel(); response.sendStatus(upstream.status); return; }
      if (!upstream.headers.get("content-type")?.startsWith("application/json")) { await upstream.body?.cancel(); throw Error("Unexpected MCP upstream response"); }
      const reader = upstream.body?.getReader();
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        if (reader) for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          length += chunk.value.length;
          if (length > 262144) throw Error("MCP upstream response limit reached");
          chunks.push(chunk.value);
        }
      } finally { await reader?.cancel().catch(() => {}); }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.status(upstream.status).json(body);
    } catch { if (!response.headersSent && !response.destroyed) response.status(503).json({ error: "temporarily_unavailable", error_description: "IDE task bridge is unavailable. No automatic retry was made." }); }
    finally { response.off("close", disconnect); forwarding.delete(abort); }
  });
  app.use((_request, response) => { response.status(404).json({ error: "not_found" }); });
  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (response.headersSent) { response.destroy(); return; }
    if (error instanceof OAuthError) response.status(error.errorCode === "server_error" ? 503 : 400).json(error.toResponseObject());
    else {
      const status = typeof error === "object" && error && "status" in error && [400, 413, 415].includes(Number(error.status)) ? Number(error.status) : 500;
      response.status(status).json({ error: status >= 500 ? "server_error" : "invalid_request" });
    }
  };
  app.use(errorHandler);
  const server = http.createServer(app);
  server.headersTimeout = 5000; server.requestTimeout = 7000; server.keepAliveTimeout = 1000; server.timeout = 15000; server.maxHeadersCount = 32; server.maxConnections = 64;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 9235, "127.0.0.1", resolve); });
  } catch (error) { provider.close(); throw error; }
  return { issuer: issuer.href, endpoint: resource.href, port: (server.address() as { port: number }).port, async close() {
    if (stopping) return;
    stopping = true; provider.close();
    for (const controller of forwarding) controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
