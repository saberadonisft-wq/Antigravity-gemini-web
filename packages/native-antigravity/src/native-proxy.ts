import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { NativeRouteError, WEB_MODEL, canonical, compileNativeTurn, object, sha256, type JsonObject } from "./native-protocol.js";
import type { NativeBrowserBackend } from "./browser-backend.js";

const PROD = "https://cloudcode-pa.googleapis.com";
const DAILY = "https://daily-cloudcode-pa.googleapis.com";
export const NATIVE_PROXY_PORT = 9236;
export interface UpstreamResult { status: number; body: Buffer; contentType: string }
export type ControlTransport = (origin: string, route: string, body: Buffer, headers: Record<string, string>, signal: AbortSignal) => Promise<UpstreamResult>;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_CONTROL_RESPONSE = 8 * 1024 * 1024;
const CONTROL_ROUTES = /^\/v1internal:(?:loadCodeAssist|onboardUser|fetchUserInfo|fetchAvailableModels|fetchCredits|retrieveUserQuota|retrieveUserQuotaSummary|fetchAdminControls|recordCodeAssistTelemetry|recordCodeAssistMetrics|fetchUserTier|fetchUserStatus|fetchMcpServerConfigs|listExperiments|fetchExperiments)$/;
const MODEL_PREFIX = "MODEL_PLACEHOLDER_M";

export const controlTransport: ControlTransport = async (origin, route, body, headers, signal) => {
  const response = await fetch(new URL(route, origin), { method: "POST", headers, body: new Uint8Array(body), signal, redirect: "manual" });
  const chunks: Buffer[] = [];
  let size = 0;
  if (response.body) for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_CONTROL_RESPONSE) { await response.body.cancel().catch(() => {}); throw new NativeRouteError("UPSTREAM_TOO_LARGE", "Cloud Code metadata exceeds its limit.", 502); }
    chunks.push(Buffer.from(chunk));
  }
  return { status: response.status, body: Buffer.concat(chunks), contentType: response.headers.get("content-type") ?? "application/json" };
};

/** Protocol/catalog shapes researched from antigravity-add-model; see THIRD_PARTY_NOTICES.md. */
export class NativeModelIdentity {
  private slot?: number;
  constructor(private readonly filename: string) {
    if (fs.existsSync(filename)) {
      const value: unknown = JSON.parse(fs.readFileSync(filename, "utf8"));
      if (!object(value) || value.version !== 1 || value.model !== WEB_MODEL || !Number.isInteger(value.slot) || Number(value.slot) < 0 || Number(value.slot) > 650) throw new NativeRouteError("INVALID_IDENTITY", "Native model identity state is invalid.", 503);
      this.slot = Number(value.slot);
    }
  }
  get symbol() { return this.slot === undefined ? undefined : MODEL_PREFIX + this.slot; }
  matches(value: unknown): boolean {
    return value === WEB_MODEL || value === "models/" + WEB_MODEL ||
      (this.slot !== undefined && (value === this.symbol || value === "models/" + this.symbol || value === this.slot + 1000));
  }
  merge(upstream: unknown): JsonObject {
    if (!object(upstream)) throw new NativeRouteError("INVALID_CATALOG", "Upstream model catalog is invalid.", 502);
    const used = new Set<number>();
    for (const key of ["models", "availableModels", "available_models"]) {
      const entries = upstream[key];
      if (!entries || typeof entries !== "object") continue;
      for (const [name, value] of Object.entries(entries)) if (name !== WEB_MODEL && object(value)) {
        const model = value.model;
        const index = typeof model === "number" ? model - 1000 : typeof model === "string" && /^MODEL_PLACEHOLDER_M\d+$/.test(model) ? Number(model.slice(MODEL_PREFIX.length)) : -1;
        if (Number.isInteger(index) && index >= 0 && index <= 650) used.add(index);
      }
    }
    if (this.slot !== undefined && used.has(this.slot)) throw new NativeRouteError("MODEL_IDENTITY_CONFLICT", "A native model now occupies the saved Gemini Web identity. Refusing to reassign cached selections.", 503);
    if (this.slot === undefined) {
      let slot = 650;
      while (used.has(slot)) slot--;
      if (slot < 0) throw new NativeRouteError("MODEL_IDENTITY_CAPACITY", "No native model identity is available.", 503);
      fs.mkdirSync(path.dirname(this.filename), { recursive: true });
      fs.writeFileSync(this.filename, JSON.stringify({ version: 1, model: WEB_MODEL, slot }) + "\n", { flag: "wx", mode: 0o600 });
      this.slot = slot;
    }
    const capabilities = { displayName: "Gemini Web (Local)", supportsImages: false, supportsThinking: false, supportsVideo: false, supportedMimeTypes: { "text/plain": true } };
    // IDE 2.5.5 validates a 50k checkpoint + 40k reserve. This is a catalog compatibility floor,
    // NOT a measured Gemini Web context window; compileNativeTurn enforces the real local text cap.
    const entry = { ...capabilities, recommended: true, maxTokens: 100000, maxOutputTokens: 8192,
      tokenizerType: "LLAMA_WITH_SPECIAL", model: this.symbol, apiProvider: "API_PROVIDER_GOOGLE_GEMINI", modelProvider: "MODEL_PROVIDER_GOOGLE",
      modelExperiments: { experiments: { CASCADE_USE_EXPERIMENT_CHECKPOINTER: { stringValue: JSON.stringify({ useLastPlannerModel: true, maxOutputTokens: 8192 }) } } },
    };
    const result = structuredClone(upstream);
    let merged = false;
    for (const key of ["models", "availableModels", "available_models"]) {
      if (Array.isArray(result[key])) {
        result[key] = [{ ...entry, name: "models/" + WEB_MODEL, inputTokenLimit: 100000, outputTokenLimit: 8192 }, ...result[key].filter((value: unknown) => !object(value) || value.name !== "models/" + WEB_MODEL)];
        merged = true;
      } else if (object(result[key])) { result[key] = { ...result[key], [WEB_MODEL]: entry }; merged = true; }
    }
    if (!merged) throw new NativeRouteError("INVALID_CATALOG", "Upstream did not provide a recognized native model collection.", 502);
    const sorts = Array.isArray(result.agentModelSorts) ? result.agentModelSorts : [];
    let attached = false;
    result.agentModelSorts = sorts.map(sort => {
      if (!object(sort) || !Array.isArray(sort.groups)) return sort;
      return { ...sort, groups: sort.groups.map(group => {
        if (!object(group) || !Array.isArray(group.modelIds)) return group;
        attached = true;
        return { ...group, modelIds: [...new Set([...group.modelIds, WEB_MODEL])] };
      }) };
    });
    if (!attached) (result.agentModelSorts as unknown[]).push({ displayName: "Gemini Web", groups: [{ modelIds: [WEB_MODEL] }] });
    return result;
  }
}

async function readBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0;
    const deadline = setTimeout(() => { finish(); reject(new NativeRouteError("BODY_TIMEOUT", "Native request body timed out.", 408)); }, 5000);
    const finish = () => { clearTimeout(deadline); request.off("data", data); request.off("end", end); request.off("error", error); request.off("aborted", aborted); };
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY) { finish(); request.resume(); reject(new NativeRouteError("REQUEST_TOO_LARGE", "Native request exceeds 2 MiB.", 413)); }
      else chunks.push(chunk);
    };
    const end = () => { finish(); resolve(Buffer.concat(chunks)); };
    const error = () => { finish(); reject(new NativeRouteError("CLIENT_DISCONNECTED", "Native client disconnected.", 499)); };
    const aborted = error;
    request.on("data", data).once("end", end).once("error", error).once("aborted", aborted);
  });
}
interface PendingTurn { controller: AbortController; promise: Promise<JsonObject>; waiters: number; settled: boolean }
export interface NativeProxyOptions {
  backend: NativeBrowserBackend;
  stateDirectory: string;
  port?: number;
  control?: ControlTransport;
  controlToken?: string;
  generationTimeoutMs?: number;
}
export async function startNativeProxy(options: NativeProxyOptions) {
  const identity = new NativeModelIdentity(path.join(options.stateDirectory, "native-model-identity.json"));
  const upstream = options.control ?? controlTransport;
  const turns = new Map<string, PendingTurn>();
  const controllers = new Set<AbortController>();
  const routes = new Map<string, { origin: string; expires: number }>();
  const counters = { catalog: 0, control: 0, nativeRequests: 0, browserRequests: 0, completed: 0, failed: 0, active: 0 };
  const observations: Array<{ method: string; route: string; status: number }> = [];
  let stopping = false; let closePromise: Promise<void> | undefined;
  const json = (response: http.ServerResponse, status: number, body: unknown) => {
    if (!response.destroyed && !response.writableEnded) { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(body)); }
  };
  const server = http.createServer((request, response) => {
    response.once("finish", () => {
      const route = request.url?.split("?")[0] ?? "";
      if (/^\/v1internal:[a-zA-Z]{1,80}$/.test(route)) {
        observations.push({ method: request.method ?? "", route, status: response.statusCode });
        if (observations.length > 64) observations.shift();
      }
    });
    void handle(request, response).catch(error => {
    const known = error instanceof NativeRouteError;
    if (response.headersSent) { if (!response.destroyed) response.destroy(); return; }
    json(response, known ? error.status : 502, { error: { code: known ? error.code : "NATIVE_PROXY_FAILED", message: known ? error.message : "Native route failed without a model fallback or automatic resend." } });
  }); });
  async function handle(request: http.IncomingMessage, response: http.ServerResponse) {
    const address = server.address();
    const port = address && typeof address !== "string" ? address.port : options.port;
    if (request.headers.origin || !["127.0.0.1:" + port, "localhost:" + port].includes(request.headers.host ?? "") ||
      !request.url?.startsWith("/") || request.url.startsWith("//")) throw new NativeRouteError("FORBIDDEN_ORIGIN", "Only native loopback clients may use this proxy.", 403);
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/__native/health") {
      json(response, 200, { service: "gemini-native-proxy", version: 1, pid: process.pid, model: WEB_MODEL, symbol: identity.symbol, nativeInference: "unverified_until_live_acceptance", mode: "gemini_web", counters, observations, stopping }); return;
    }
    if (request.method === "POST" && ["/__native/stop", "/__native/browser"].includes(url.pathname)) {
      const token = request.headers["x-native-control-token"];
      if (!options.controlToken || typeof token !== "string" || token.length !== options.controlToken.length || !timingSafeEqual(Buffer.from(token), Buffer.from(options.controlToken))) throw new NativeRouteError("UNAUTHORIZED", "Owner control token required.", 401);
      if (counters.active) throw new NativeRouteError("BUSY", "A native generation is still active.", 409);
      if (url.pathname === "/__native/browser") {
        if (!options.backend.openBrowser) throw new NativeRouteError("UNSUPPORTED_OPERATION", "No live browser opener is installed.", 503);
        json(response, 200, await options.backend.openBrowser()); return;
      }
      json(response, 200, { stopping: true }); setImmediate(() => { void close(); }); return;
    }
    if (stopping) throw new NativeRouteError("SERVICE_UNAVAILABLE", "Native proxy is stopping.", 503);
    if (request.method !== "POST" || !url.pathname.startsWith("/v1internal:") || (url.search && url.search !== "?alt=sse")) throw new NativeRouteError("UNSUPPORTED_ROUTE", "This native route is not supported.", 404);
    if (!/^Bearer \S{1,16384}$/.test(request.headers.authorization ?? "")) throw new NativeRouteError("UNAUTHORIZED", "The IDE must complete its normal Google sign-in.", 401);
    const body = await readBody(request);
    const caller = sha256(request.headers.authorization!);
    if (url.pathname === "/v1internal:streamGenerateContent" || url.pathname === "/v1internal:generateContent") {
      counters.nativeRequests++;
      let envelope: unknown;
      try { envelope = JSON.parse(body.toString("utf8")); } catch { throw new NativeRouteError("INVALID_REQUEST", "Invalid native JSON request."); }
      if (!object(envelope) || ![envelope.model, envelope.modelId, envelope.model_id].some(value => identity.matches(value))) throw new NativeRouteError("NATIVE_MODEL_NOT_SELECTED", "Select Gemini Web (Local). This proxy never silently sends generation to a Google API model.", 409);
      const compiled = compileNativeTurn(envelope, caller);
      let turn = turns.get(compiled.requestId);
      if (!turn) {
        if (turns.size >= 128) throw new NativeRouteError("QUEUE_FULL", "Native request cache is full; no identities are evicted or replayed.", 503);
        const controller = new AbortController();
        const current: PendingTurn = { controller, waiters: 0, settled: false, promise: Promise.resolve({}) };
        turns.set(compiled.requestId, current);
        counters.browserRequests++; counters.active++;
        const timer = setTimeout(() => controller.abort(new NativeRouteError("TIMEOUT", "Native generation exceeded its deadline; acceptance may be uncertain and will not be replayed.", 504)), options.generationTimeoutMs ?? 145000);
        let onAbort!: () => void;
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(controller.signal.reason instanceof NativeRouteError ? controller.signal.reason : new NativeRouteError("OUTCOME_UNKNOWN", "Native request was interrupted; no automatic resend.", 499));
          controller.signal.addEventListener("abort", onAbort, { once: true });
        });
        current.promise = Promise.race([Promise.resolve().then(() => options.backend.generate(compiled.requestId, compiled.prompt, controller.signal)), aborted])
          .then(text => { controller.signal.throwIfAborted(); const result = compiled.parseReply(text); counters.completed++; return result; })
          .catch(error => { counters.failed++; throw error; })
          .finally(() => { clearTimeout(timer); controller.signal.removeEventListener("abort", onAbort); current.settled = true; counters.active--; });
        // Observe leader-only failures even when its HTTP socket disappears.
        void current.promise.catch(() => {});
        turn = current;
      }
      const current = turn; current.waiters++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true; current.waiters--;
        if (!current.waiters && !current.settled) current.controller.abort();
      };
      response.once("close", release);
      const streaming = url.pathname.includes("streamGenerateContent");
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      if (streaming) {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
        response.write(": Gemini Web native request accepted by the local proxy; waiting for browser completion\n\n");
        heartbeat = setInterval(() => { if (!response.destroyed) response.write(": waiting\n\n"); }, 10000);
      }
      try {
        const result = await current.promise;
        if (response.destroyed) return;
        if (streaming) response.end("data: " + JSON.stringify(result) + "\n\n");
        else json(response, 200, result);
      } catch (error) {
        if (streaming && !response.destroyed) {
          response.end("event: error\ndata: " + JSON.stringify({ error: { code: error instanceof NativeRouteError ? error.code : "NATIVE_GENERATION_FAILED", message: "Gemini Web request did not complete; no fallback or automatic resend." } }) + "\n\n");
        } else throw error;
      } finally { clearInterval(heartbeat); response.off("close", release); release(); }
      return;
    }
    if (!CONTROL_ROUTES.test(url.pathname)) throw new NativeRouteError("UNSUPPORTED_ROUTE", "Unsupported Cloud Code metadata route.", 404);
    const controller = new AbortController(); controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15000);
    const cancel = () => { if (!response.writableEnded) controller.abort(); };
    response.once("close", cancel);
    try {
      const forwarded: Record<string, string> = { "content-type": "application/json", "accept-encoding": "identity" };
      for (const key of ["authorization", "user-agent", "x-goog-user-project", "x-goog-api-client"]) if (typeof request.headers[key] === "string") forwarded[key] = request.headers[key];
      const route = routes.get(caller);
      const origin = route && route.expires > Date.now() ? route.origin : PROD;
      counters.control++;
      const result = await upstream(origin, url.pathname, body, forwarded, controller.signal);
      if (result.status >= 300 && result.status < 400) throw new NativeRouteError("UPSTREAM_REDIRECT_DENIED", "Cloud Code redirect was not followed with the IDE credential.", 502);
      if (url.pathname === "/v1internal:loadCodeAssist" && result.status === 200) {
        const tier: unknown = JSON.parse(result.body.toString("utf8"));
        if (object(tier)) {
          const paid = tier.paidTier ?? tier.paid_tier;
          const usesGcp = object(paid) ? paid.usesGcpTos ?? paid.uses_gcp_tos : undefined;
          if (usesGcp === undefined || typeof usesGcp === "boolean") {
            if (routes.size >= 128 && !routes.has(caller)) routes.delete(routes.keys().next().value!);
            routes.set(caller, { origin: usesGcp === true ? PROD : DAILY, expires: Date.now() + 3600000 });
          }
        }
      }
      if (url.pathname === "/v1internal:fetchAvailableModels" && result.status === 200) {
        counters.catalog++;
        json(response, 200, identity.merge(JSON.parse(result.body.toString("utf8")))); return;
      }
      // Keep the IDE's account-selected endpoint on this proxy. Never rewrite arbitrary URLs.
      const text = result.body.toString("utf8").replace(/https:\/\/(?:daily-)?cloudcode-pa\.googleapis\.com(?=[/"\\])/g, "http://127.0.0.1:" + port);
      if (!response.destroyed) { response.writeHead(result.status, { "content-type": result.contentType, "cache-control": "no-store" }); response.end(text); }
    } finally { clearTimeout(timeout); controllers.delete(controller); response.off("close", cancel); }
  }
  async function close() {
    if (closePromise) return closePromise;
    stopping = true;
    for (const turn of turns.values()) if (!turn.settled) turn.controller.abort();
    for (const controller of controllers) controller.abort();
    closePromise = (async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await options.backend.close();
    })();
    return closePromise;
  }
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? NATIVE_PROXY_PORT, "127.0.0.1", resolve); });
  const address = server.address() as { port: number };
  return { port: address.port, close, counters, identity, server };
}
