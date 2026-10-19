import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { NativeRouteError, WEB_MODEL, canonical, compileNativeTurn, nativeToolCacheStats, object, sha256, type JsonObject } from "./native-protocol.js";
import type { NativeBrowserBackend } from "./browser-backend.js";
import type { AccountRegistry } from "./account-registry.js";
import { NativeConversationState, nativePartialText, nativeTextFrame } from "./conversation-state.js";

import { AccountControlRequestSchema, NativeLogicalReceiptQuerySchema, PhysicalReceiptInspectionSchema, WebModelSelectionSchema } from "@antigravity-gemini-web/contracts";
import { NativeRequestLedger,type NativeRequestReservation } from "./request-ledger.js";
import { NativeAccountRouter,type NativeAccountLease } from "./account-router.js";
import { NativeRoutingControlSchema } from "@antigravity-gemini-web/contracts";
import { nativeNotSentProof,permitsAccountFailover } from "./failover-policy.js";
import { NativeManagementRequestSchema } from "@antigravity-gemini-web/contracts";
import { buildManagementSnapshot } from "./management-snapshot.js";
import { NativeKnowledgeRegistry,type KnowledgeResolution } from "./knowledge-registry.js";
import { NativeChatImportJobs } from "./chat-import-jobs.js";
import { ChatImportRequestSchema, ChatImportCapabilitySchema } from "@antigravity-gemini-web/contracts";
import { KnowledgeRequestSchema } from "@antigravity-gemini-web/contracts";

const PROD = "https://cloudcode-pa.googleapis.com";
const DAILY = "https://daily-cloudcode-pa.googleapis.com";
export const NATIVE_PROXY_PORT = 9236;
export const NATIVE_RUNTIME_REVISION = 40;
/**
 * The picker identifier is deliberately distinct from WEB_MODEL (the internal
 * bridge route) and from MODEL_PLACEHOLDER_M* (the IDE enum).  Antigravity
 * keeps picker IDs in its model sort/cache, while it serializes the enum in a
 * generation request.  Keeping them separate mirrors the native catalog
 * contract and avoids an external-looking route name being treated as a
 * Google model identifier.
 */
export const WEB_CATALOG_MODEL = "custom-antigravity-gemini-web";
export interface UpstreamResult { status: number; body: Buffer; contentType: string }
export type ControlTransport = (origin: string, route: string, body: Buffer, headers: Record<string, string>, signal: AbortSignal) => Promise<UpstreamResult>;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_CONTROL_RESPONSE = 8 * 1024 * 1024;
const CONTROL_ROUTES = /^\/v1internal:(?:loadCodeAssist|onboardUser|fetchUserInfo|fetchAvailableModels|fetchCredits|retrieveUserQuota|retrieveUserQuotaSummary|fetchAdminControls|recordCodeAssistTelemetry|recordCodeAssistMetrics|fetchUserTier|fetchUserStatus|fetchMcpServerConfigs|listExperiments|fetchExperiments)$/;
const MODEL_PREFIX = "MODEL_PLACEHOLDER_M";

/**
 * Keep the health endpoint useful when an IDE build changes its catalog wire
 * shape.  This deliberately contains only public catalog identifiers and
 * model enum values: never prompts, account details, or credentials.
 */
function catalogModelReferences(value: unknown): JsonObject {
  const references: JsonObject[] = [];
  if (!object(value)) return { collections: 0, references };
  let collections = 0;
  for (const collection of ["models", "availableModels", "available_models"]) {
    const entries = value[collection];
    if (!entries || typeof entries !== "object") continue;
    collections++;
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (!object(entry) || references.length >= 128) continue;
        const name = entry.name;
        const model = entry.model;
        if ((typeof name === "string" || typeof name === "number") && (typeof model === "string" || typeof model === "number")) {
          references.push({ collection, key: String(name), model: String(model) });
        }
      }
    } else {
      for (const [key, entry] of Object.entries(entries)) {
        if (!object(entry) || references.length >= 128) continue;
        const model = entry.model;
        if (typeof model === "string" || typeof model === "number") references.push({ collection, key, model: String(model) });
      }
    }
  }
  return { collections, references };
}

function modelSelectors(value: unknown): JsonObject {
  if (!object(value)) return {};
  const selected: JsonObject = {};
  for (const key of ["model", "modelId", "model_id"]) {
    const candidate = value[key];
    if (typeof candidate === "string" || typeof candidate === "number") selected[key] = String(candidate);
  }
  return selected;
}

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
      value === WEB_CATALOG_MODEL || value === "models/" + WEB_CATALOG_MODEL ||
      (this.slot !== undefined && (value === this.symbol || value === "models/" + this.symbol || value === this.slot + 1000));
  }
  merge(upstream: unknown): JsonObject {
    if (!object(upstream)) throw new NativeRouteError("INVALID_CATALOG", "Upstream model catalog is invalid.", 502);
    const used = new Set<number>();
    for (const key of ["models", "availableModels", "available_models"]) {
      const entries = upstream[key];
      if (!entries || typeof entries !== "object") continue;
      for (const [name, value] of Object.entries(entries)) if (
        name !== WEB_MODEL && name !== WEB_CATALOG_MODEL &&
        (!object(value) || (value.name !== "models/" + WEB_MODEL && value.name !== "models/" + WEB_CATALOG_MODEL))
      ) {
        if (!object(value)) continue;
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
      tokenizerType: "LLAMA_WITH_SPECIAL", model: this.symbol, apiProvider: "API_PROVIDER_GOOGLE_GEMINI", modelProvider: "MODEL_PROVIDER_GOOGLE" };
    // The native checkpoint experiment must only be advertised when a model
    // has a verified checkpoint configuration.  Supplying a generic one makes
    // some IDE versions resolve an unrelated cached placeholder (for example
    // M36) before a user turn reaches this proxy.
    const listEntry = { ...capabilities, name: "models/" + WEB_CATALOG_MODEL, version: "1.0",
      description: "Uses the signed-in Gemini Web conversation in this local browser.",
      inputTokenLimit: 100000, outputTokenLimit: 8192, supportedGenerationMethods: ["generateContent", "countTokens"] };
    const result = structuredClone(upstream);
    let merged = false;
    for (const key of ["models", "availableModels", "available_models"]) {
      if (Array.isArray(result[key])) {
        result[key] = [listEntry, ...result[key].filter((value: unknown) => !object(value) || (value.name !== "models/" + WEB_MODEL && value.name !== "models/" + WEB_CATALOG_MODEL))];
        merged = true;
      } else if (object(result[key])) {
        const collection = { ...result[key] };
        delete collection[WEB_MODEL];
        collection[WEB_CATALOG_MODEL] = entry;
        result[key] = collection;
        merged = true;
      }
    }
    if (!merged) throw new NativeRouteError("INVALID_CATALOG", "Upstream did not provide a recognized native model collection.", 502);
    const sorts = Array.isArray(result.agentModelSorts) ? result.agentModelSorts : [];
    let attached = false;
    result.agentModelSorts = sorts.map(sort => {
      if (!object(sort) || !Array.isArray(sort.groups)) return sort;
      return { ...sort, groups: sort.groups.map(group => {
        if (!object(group) || !Array.isArray(group.modelIds)) return group;
        attached = true;
        return { ...group, modelIds: [...new Set([...group.modelIds, WEB_CATALOG_MODEL])] };
      }) };
    });
    if (!attached) (result.agentModelSorts as unknown[]).push({ displayName: "Gemini Web", groups: [{ modelIds: [WEB_CATALOG_MODEL] }] });
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
interface PendingTurn { controller: AbortController; ready: Promise<void>; promise: Promise<JsonObject>; waiters: number; settled: boolean; settledAt?: number; retryableNotSent?: boolean; text: string; diagnostic?:JsonObject; knowledge?:KnowledgeResolution; listeners: Set<() => void>; cancellationResult?: Promise<boolean>; resolveCancellationResult?: (confirmed: boolean) => void }
const MAX_CACHED_TURNS = 32;
const RESULT_TTL_MS = 10 * 60 * 1000;
const MAX_REQUEST_IDENTITIES = 65536;
export interface NativeProxyOptions {
  backend: NativeBrowserBackend;
  stateDirectory: string;
  port?: number;
  control?: ControlTransport;
  controlToken?: string;
  generationTimeoutMs?: number;
  stallTimeoutMs?: number;
  modelSelection?: { model: string; effort?: string };
  contextModelSelection?: { model: string; effort?: string };
  batchToolCalls?: boolean;
  snapshotAttachment?: boolean;
  routingExperimental?:boolean;
  accountRegistry?: AccountRegistry;
  knowledgeExperimental?:boolean;
  importsExperimental?:boolean;
}
export async function startNativeProxy(options: NativeProxyOptions) {
  if (options.contextModelSelection && !WebModelSelectionSchema.safeParse(options.contextModelSelection).success) throw new NativeRouteError("INVALID_MODEL_SELECTION", "The context Web model/effort configuration is invalid.");
  const router=options.accountRegistry?new NativeAccountRouter(options.accountRegistry,path.join(options.stateDirectory,"routing.json"),options.routingExperimental===true):undefined;
  const identity = new NativeModelIdentity(path.join(options.stateDirectory, "native-model-identity.json"));
  const upstream = options.control ?? controlTransport;
  const turns = new Map<string, PendingTurn>();
  // Identities outlive result objects. Eviction must never turn a retry into another Send.
  const retiredRequests = new Set<string>();
  const pruneTurns = () => {
    for (const [id, turn] of turns) {
      if (!turn.settled || turn.waiters) continue;
      if (turn.retryableNotSent || turns.size > MAX_CACHED_TURNS || Date.now() - turn.settledAt! >= RESULT_TTL_MS) {
        if (!turn.retryableNotSent) retiredRequests.add(id);
        turns.delete(id);
      }
    }
  };
  const conversations = new NativeConversationState(5, path.join(options.stateDirectory, "native-conversation-cache.json"));
  const requestLedger = new NativeRequestLedger(path.join(options.stateDirectory, "native-turn-ledger"));
  let knowledgeRegistry:NativeKnowledgeRegistry|undefined;
  const knowledgeStore=()=>knowledgeRegistry??=new NativeKnowledgeRegistry(path.join(options.stateDirectory,"knowledge.json"));
  const resolveKnowledge=(taskScope:string|undefined,accountId:string,identityEpoch:number):KnowledgeResolution|undefined=>{
    if(!options.knowledgeExperimental)return;
    try{return knowledgeStore().resolve(taskScope,accountId,identityEpoch);}catch{return {used:false,issues:["SOURCE_REGISTRY_UNAVAILABLE"],assertCurrent:()=>{}};}
  };
  const verifiedAccounts = new Map<string, { epoch: number; observedAt: string }>();
  const managementOwnerId=randomUUID(),accountFailures=new Map<string,{epoch:number;code:string}>();
  let chatImports: NativeChatImportJobs | undefined;
  const importJobs = () => chatImports ??= new NativeChatImportJobs(() => options.accountRegistry!.snapshot(), managementOwnerId);
  const observeAccountFailure=(accountId:string,error:unknown)=>{
    const codes=["BROWSER_LOGIN_REQUIRED","ACCOUNT_IDENTITY_CHANGED","ACCOUNT_IDENTITY_UNVERIFIED","BROWSER_USER_ACTION_REQUIRED","MODEL_UNAVAILABLE","MODEL_RESTORE_PENDING","ACCOUNT_RUNTIME_STALE","BROWSER_UI_CHANGED"];
    if(error instanceof NativeRouteError&&codes.includes(error.code)){
      const account=options.accountRegistry?.get(accountId);if(account)accountFailures.set(accountId,{epoch:account.identityEpoch,code:error.code});
    }
  };
  const managementSnapshot=()=>{
    pruneTurns();
    if(!options.accountRegistry||!router)throw new NativeRouteError("UNSUPPORTED_OPERATION","Account management requires the native account registry.",503);
    return buildManagementSnapshot({ownerId:managementOwnerId,runtimeRevision:NATIVE_RUNTIME_REVISION,registry:options.accountRegistry.snapshot(),router:router.snapshot(),canMutate:!counters.active&&!router.activeCount&&!accountControlActive&&!stopping,accountControlActive,resumeArmed:!!resumeRequest&&resumeRequest.expiresAt>Date.now(),verified:verifiedAccounts,failures:accountFailures,turns,lastTurn});
  };
  let accountControlActive = false;
  const modelSelection = options.modelSelection;
  // Keep the historical default scope identity so a deployment that changes
  // from forced model selection to user-selected Web models does not bypass an
  // existing task's durable uncertain-outcome fence.
  const conversationScopePolicy = modelSelection ?? { model: "4 Argon", effort: "Low" };
  const maximum = options.generationTimeoutMs ?? 1800000;
  const idleBudget = Math.min(options.stallTimeoutMs ?? 300000, maximum);
  if (![maximum, idleBudget].every(n => Number.isSafeInteger(n) && n > 0 && n <= 1800000)) throw new NativeRouteError("INVALID_DEADLINE", "Native generation budgets must be between 1 and 1800000 milliseconds.");
  let lastTurn: JsonObject | undefined;
  let lastTaskScope: string | undefined;
  let resumeRequest: { url: string; scope?: string; accountId: string; identityEpoch: number; expiresAt: number } | undefined;
  const controllers = new Set<AbortController>();
  const routes = new Map<string, { origin: string; expires: number }>();
  const counters = { catalog: 0, control: 0, nativeRequests: 0, browserRequests: 0, completed: 0, failed: 0, active: 0 };
  const observations: Array<{ method: string; route: string; status: number }> = [];
  let upstreamCatalog: JsonObject | undefined;
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
    const status = known ? error.status : 502;
    const code = known ? error.code : "NATIVE_PROXY_FAILED";
    const message = known ? error.message : "Native route failed without a model fallback or automatic resend.";
    const generation = /^\/v1internal:(?:streamGenerateContent|generateContent)(?:\?|$)/.test(request.url ?? "");
    json(response, status, { error: generation ? { code: status, status: status === 412 ? "FAILED_PRECONDITION" : status === 499 ? "CANCELLED" : status === 504 ? "DEADLINE_EXCEEDED" : status === 401 ? "UNAUTHENTICATED" : status === 409 ? "ABORTED" : status >= 500 ? "UNAVAILABLE" : "INVALID_ARGUMENT", message, details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: code, domain: "gemini-web.local" }] } : { code, message } });
  }); });
  async function handle(request: http.IncomingMessage, response: http.ServerResponse) {
    const address = server.address();
    const port = address && typeof address !== "string" ? address.port : options.port;
    if (request.headers.origin || !["127.0.0.1:" + port, "localhost:" + port].includes(request.headers.host ?? "") ||
      !request.url?.startsWith("/") || request.url.startsWith("//")) throw new NativeRouteError("FORBIDDEN_ORIGIN", "Only native loopback clients may use this proxy.", 403);
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/__native/health") {
      pruneTurns();
      const routing=router?.snapshot();
      const effectiveModelSelection=routing?.settings.modelSelection??modelSelection;
      const activeAccount = options.accountRegistry?.getActive();
      const accountSummary = activeAccount ? {
        accountId: activeAccount.accountId,
        displayName: activeAccount.displayName,
        debugPort: activeAccount.debugPort,
        identityRegistered: !!activeAccount.identityFingerprint,
        identityVerified: verifiedAccounts.get(activeAccount.accountId)?.epoch === activeAccount.identityEpoch && Date.now() - Date.parse(verifiedAccounts.get(activeAccount.accountId)!.observedAt) < 30000,
        identityObservedAt: verifiedAccounts.get(activeAccount.accountId)?.observedAt,
        identityEpoch: activeAccount.identityEpoch,
      } : undefined;
      json(response, 200, { service: "gemini-native-proxy", version: 1, runtimeRevision: NATIVE_RUNTIME_REVISION, pid: process.pid, model: WEB_MODEL, catalogModel: WEB_CATALOG_MODEL, symbol: identity.symbol, nativeInference: "unverified_until_live_acceptance", mode: "gemini_web", modelSelection: effectiveModelSelection ?? null, modelSelectionMode: effectiveModelSelection ? "proxy_selected" : "user_selected_in_web",
        contextModelSelection:options.contextModelSelection??null,contextModelScope:"initial_full_context",accountManagementSupported:!!options.accountRegistry,knowledgeExperimental:options.knowledgeExperimental===true,importInspectionExperimental:options.importsExperimental===true,
        routing:routing?{mode:routing.settings.mode,revision:routing.revision,modelSelection:routing.settings.modelSelection,experimentalEnabled:routing.experimentalEnabled,automaticRoutingEnabled:routing.automaticRoutingEnabled,failoverEnabled:routing.failoverEnabled,failoverPolicy:routing.settings.failover,stickyBindings:routing.bindings.length,activeLeases:routing.activeLeases}:undefined,
        snapshotAttachmentExperimental: options.snapshotAttachment === true, batchToolCallsEnabled: options.batchToolCalls === true, persistentConversationMetadata: true,
        account: accountSummary, accountRevision: options.accountRegistry?.snapshot().revision, accountControlActive, durableLogicalLedger: true,
        requestCache: { retainedResults: turns.size, retiredIdentities: retiredRequests.size, maxResults: MAX_CACHED_TURNS, resultTtlMs: RESULT_TTL_MS, maxIdentities: MAX_REQUEST_IDENTITIES },
        toolSchemaCache: nativeToolCacheStats(),
        backendResources:options.backend.resourceStatus?.(),
        resumeArmed: !!resumeRequest && resumeRequest.expiresAt > Date.now(), deadlines: { stallTimeoutMs: idleBudget, maxDurationMs: maximum }, upstreamCatalog, lastTurn, counters, observations, stopping }); return;
    }
    if (request.method === "POST" && ["/__native/stop", "/__native/browser", "/__native/cancel", "/__native/resume", "/__native/account", "/__native/reconcile", "/__native/router", "/__native/manage", "/__native/knowledge", "/__native/imports"].includes(url.pathname)) {
      const token = request.headers["x-native-control-token"];
      const receivedToken=typeof token==="string"?Buffer.from(token):undefined,expectedToken=Buffer.from(options.controlToken??"");
      if (!options.controlToken || !receivedToken || receivedToken.length!==expectedToken.length || !timingSafeEqual(receivedToken,expectedToken)) throw new NativeRouteError("UNAUTHORIZED", "Owner control token required.", 401);
      if (url.pathname === "/__native/imports") {
        let raw: unknown; try { raw = JSON.parse((await readBody(request)).toString("utf8")); } catch { throw new NativeRouteError("INVALID_ARGUMENT", "Expected one local inspection command."); }
        const parsed = ChatImportRequestSchema.safeParse(raw); if (!parsed.success) throw new NativeRouteError("INVALID_ARGUMENT", "Invalid local inspection command.");
        const command = parsed.data, enabled = options.importsExperimental === true && !!options.accountRegistry;
        const idle = !counters.active && !router?.activeCount && !accountControlActive && !stopping && ![...turns.values()].some(turn => turn.waiters > 0);
        if (command.action === "status" && !enabled && !chatImports) { json(response, 200, { service: "gemini-native-chat-import", version: 1, ownerId: managementOwnerId, revision: 0, accountRevision: options.accountRegistry?.snapshot().revision ?? 0, experimentalEnabled: false, canInspect: false, inspectionActive: false, jobs: [], googleSubmission: "not_submitted" }); return; }
        if (!enabled) throw new NativeRouteError("IMPORT_EXPERIMENT_DISABLED", "Local import inspection is disabled in this native owner.", 412);
        if (command.action === "probe") {
          if (command.expectedOwnerId !== managementOwnerId) throw new NativeRouteError("STALE_AUTHORITY", "Refresh the Native owner before inspecting imports.", 409);
          if (!idle) throw new NativeRouteError("BUSY", "Wait for Native operations to finish before inspecting imports.", 409);
          const registry = options.accountRegistry!.snapshot(), account = registry.accounts.find(value => value.accountId === command.accountId);
          if (registry.revision !== command.expectedAccountRevision || !account?.enabled || !account.identityFingerprint || account.identityEpoch !== command.identityEpoch) throw new NativeRouteError("STALE_ACCOUNT_SELECTION", "Refresh and select the registered account identity.", 409);
          if (!options.backend.bindAccount) throw new NativeRouteError("UNSUPPORTED_OPERATION", "Account-bound browser inspection is unavailable.", 412);
          const backend = options.backend.bindAccount(account.accountId, account);
          if (!backend.inspectImportSurface) throw new NativeRouteError("UNSUPPORTED_OPERATION", "This browser worker cannot inspect imports.", 412);
          const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
          const disconnected = () => { if (!response.writableEnded) controller.abort(); };
          controllers.add(controller); response.once("close", disconnected); accountControlActive = true;
          try {
            const observation = await backend.inspectImportSurface(controller.signal);
            controller.signal.throwIfAborted(); backend.assertAuthority?.();
            if (options.accountRegistry!.snapshot().revision !== registry.revision) throw new NativeRouteError("STALE_ACCOUNT_SELECTION", "Account configuration changed during import inspection.", 409);
            json(response, 200, ChatImportCapabilitySchema.parse({ service: "gemini-native-chat-import-capability", version: 1, ownerId: managementOwnerId, accountRevision: registry.revision, accountId: account.accountId, identityEpoch: account.identityEpoch, observation }));
          } finally { clearTimeout(timer); response.off("close", disconnected); controllers.delete(controller); accountControlActive = false; }
          return;
        }
        const store = importJobs();
        if (command.action === "inspect") { json(response, 200, store.inspect(command, command.file, enabled, idle)); return; }
        if (command.action !== "status") store.execute(command);
        json(response, 200, store.snapshot(enabled, idle)); return;
      }
      if(url.pathname==="/__native/knowledge"){
        let raw:unknown;try{raw=JSON.parse((await readBody(request)).toString("utf8"));}catch{throw new NativeRouteError("INVALID_ARGUMENT","Expected one knowledge request.");}
        const parsed=KnowledgeRequestSchema.safeParse(raw);if(!parsed.success)throw new NativeRouteError("INVALID_ARGUMENT","Invalid knowledge command.");
        const command=parsed.data,canMutate=!counters.active&&!router?.activeCount&&!accountControlActive&&!stopping&&![...turns.values()].some(turn=>turn.waiters>0);
        if(command.action==="status"){
          json(response,200,options.knowledgeExperimental?knowledgeStore().status(managementOwnerId,true,canMutate,lastTaskScope):{service:"gemini-native-knowledge",version:1,ownerId:managementOwnerId,revision:0,experimentalEnabled:false,canMutate:false,lastTaskScope,sources:[],bindings:[]});return;
        }
        if(!options.knowledgeExperimental)throw new NativeRouteError("SOURCE_EXPERIMENT_DISABLED","Restart with AG_NATIVE_KNOWLEDGE_EXPERIMENTAL=1 before configuring project sources.",412);
        if(command.expectedOwnerId!==managementOwnerId)throw new NativeRouteError("STALE_AUTHORITY","The native owner changed; refresh knowledge status.",409);
        if(!canMutate)throw new NativeRouteError("BUSY","Wait for native turns and browser operations to settle before changing sources.",409);
        const store=knowledgeStore();if(store.snapshot().revision!==command.expectedRevision)throw new NativeRouteError("SOURCE_CONFIG_CONFLICT","Source selection changed; refresh knowledge status.",409);
        if(command.action==="import_code")store.importCode(command.source,command.expectedRevision);
        else if(command.action==="register_external")store.registerExternal({kind:command.kind,label:command.label,url:command.url,instructionVersion:command.instructionVersion},command.expectedRevision);
        else if(command.action==="refresh")store.refresh(command.sourceId,command.expectedRevision,command.overlayFiles);
        else if(command.action==="check")store.check(command.sourceId);
        else if(command.action==="remove")store.remove(command.sourceId,command.expectedRevision);
        else{
          const account=options.accountRegistry?.get(command.accountId);
          if(!account?.enabled||!account.identityFingerprint||account.identityEpoch!==command.identityEpoch)throw new NativeRouteError("STALE_AUTHORITY","Bind sources only to the current registered account identity epoch.",409);
          store.bind(command.taskScope,command.accountId,command.identityEpoch,command.sourceIds,command.expectedRevision);
        }
        json(response,200,store.status(managementOwnerId,true,true,lastTaskScope));return;
      }
      if(url.pathname==="/__native/manage"){
        let raw:unknown;try{raw=JSON.parse((await readBody(request)).toString("utf8"));}catch{throw new NativeRouteError("INVALID_ARGUMENT","Expected a native management request.");}
        const parsed=NativeManagementRequestSchema.safeParse(raw);if(!parsed.success)throw new NativeRouteError("INVALID_ARGUMENT","Invalid native management command.");
        const command=parsed.data;
        if(command.action==="status"){json(response,200,managementSnapshot());return;}
        const snapshot=managementSnapshot();
        if(command.expectedOwnerId!==managementOwnerId)throw new NativeRouteError("STALE_AUTHORITY","The native owner restarted; refresh before another action.",409);
        if(command.expectedRevision!==snapshot.revision)throw new NativeRouteError("CONFIG_CONFLICT","Account settings changed; refresh before another action.",409);
        if(command.action==="cancel"){
          for(const turn of turns.values())if(!turn.settled&&!turn.controller.signal.aborted){turn.cancellationResult??=new Promise<boolean>(resolve=>{turn.resolveCancellationResult=resolve;});turn.controller.abort(new NativeRouteError("CANCELLED","Native generation cancelled by its local owner.",499));}
          json(response,200,managementSnapshot());return;
        }
        if(!snapshot.canMutate)throw new NativeRouteError("BUSY","A native operation is active; wait for it to settle.",409);
        accountControlActive=true;
        try{
          const registry=options.accountRegistry!;
          if(command.action==="add"){
            const accountRoot=path.join(options.stateDirectory,"accounts",randomUUID());
            registry.add({displayName:command.displayName,profilePath:path.join(accountRoot,"profile"),statePath:path.join(accountRoot,"mcp")},command.expectedRevision);
          }else if(command.action==="use")registry.setActive(command.accountId,command.expectedRevision);
          else if(command.action==="enable")registry.enable(command.accountId,command.expectedRevision);
          else if(command.action==="disable"){registry.disable(command.accountId,command.expectedRevision);verifiedAccounts.delete(command.accountId);}
          else if(command.action==="open"){
            if(!registry.get(command.accountId)?.enabled)throw new NativeRouteError("ACCOUNT_DISABLED","Open an enabled account profile.",409);
            if(!options.backend.openBrowser)throw new NativeRouteError("UNSUPPORTED_OPERATION","No live browser opener installed.",503);
            verifiedAccounts.delete(command.accountId);await options.backend.openBrowser(command.accountId);
          }else if(command.action==="verify"){
            if(!options.backend.verifyAccount)throw new NativeRouteError("UNSUPPORTED_OPERATION","No account identity verifier installed.",503);
            await options.backend.verifyAccount(command.accountId,AbortSignal.timeout(25000));
            const account=registry.get(command.accountId)!;router!.identityVerified(account.accountId);verifiedAccounts.set(account.accountId,{epoch:account.identityEpoch,observedAt:new Date().toISOString()});accountFailures.delete(account.accountId);
          }else if(command.action==="unbind")router!.unbind(command.taskScope,command.expectedRoutingRevision);
          else if(command.action==="resume"){
            const selected=registry.getActive();if(!selected)throw new NativeRouteError("ACCOUNT_NOT_FOUND","Select an enabled account first.",412);
            resumeRequest={url:command.url,scope:undefined,accountId:selected.accountId,identityEpoch:selected.identityEpoch,expiresAt:Date.now()+300000};
          }else if(command.action==="clear_resume")resumeRequest=undefined;
        }catch(error){
          if("accountId" in command)observeAccountFailure(command.accountId,error);
          throw error;
        }finally{accountControlActive=false;}
        json(response,200,managementSnapshot());return;
      }
      if (url.pathname === "/__native/cancel") {
        const activeTurns = [...turns.values()].filter(turn => !turn.settled && !turn.controller.signal.aborted);
        for (const turn of activeTurns) {
          turn.cancellationResult ??= new Promise<boolean>(resolve => { turn.resolveCancellationResult = resolve; });
          turn.controller.abort(new NativeRouteError("CANCELLED", "Native generation cancelled by its local owner.", 499));
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const confirmation = activeTurns.length
          ? await Promise.race([Promise.all(activeTurns.map(turn => turn.cancellationResult!)), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1800); })])
          : [];
        if (timer) clearTimeout(timer);
        const browserStopConfirmed = confirmation !== undefined && confirmation.length > 0 && confirmation.every(Boolean);
        json(response, 200, { cancelRequested: activeTurns.length, browserStopConfirmed, browserStopConfirmationPending: activeTurns.length > 0 && confirmation === undefined }); return;
      }
      if(url.pathname==="/__native/router"){
        if(!router)throw new NativeRouteError("UNSUPPORTED_OPERATION","No account router is configured.",503);
        let body:unknown;try{body=JSON.parse((await readBody(request)).toString("utf8"));}catch{throw new NativeRouteError("INVALID_ARGUMENT","Invalid routing control request.");}
        const parsed=NativeRoutingControlSchema.safeParse(body);if(!parsed.success)throw new NativeRouteError("INVALID_ARGUMENT","Invalid routing settings or missing model/round-robin opt-in.");
        if(parsed.data.action==="status"){json(response,200,router.snapshot());return;}
        if(counters.active||router.activeCount||accountControlActive)throw new NativeRouteError("BUSY","A native turn or browser operation is still active; routing was not changed.",409);
        if(parsed.data.action==="configure")json(response,200,router.configure(parsed.data.settings,parsed.data.expectedRevision));
        else json(response,200,router.unbind(parsed.data.taskScope,parsed.data.expectedRevision));
        return;
      }
      if (counters.active || router?.activeCount || accountControlActive) throw new NativeRouteError("BUSY", "A native generation or account operation is still active.", 409);
      if(url.pathname==="/__native/reconcile"){
        let body:unknown;
        try{body=JSON.parse((await readBody(request)).toString("utf8"));}catch{throw new NativeRouteError("INVALID_ARGUMENT","Expected one logical request ID.");}
        const parsed=NativeLogicalReceiptQuerySchema.safeParse(body);
        if(!parsed.success)throw new NativeRouteError("INVALID_ARGUMENT","Expected one logical request ID.");
        if(counters.active||router?.activeCount||accountControlActive)throw new NativeRouteError("BUSY","A native operation became active; receipt inspection was not started.",409);
        const logical=requestLedger.inspect(parsed.data.requestId);
        if(!logical)throw new NativeRouteError("REQUEST_NOT_FOUND","Logical request metadata is unavailable.",404);
        const sources=requestLedger.attempts(logical).map(attempt=>({attempt,account:options.accountRegistry?.get(attempt.accountId)}));
        if(options.accountRegistry&&sources.some(({attempt,account})=>!account||account.identityEpoch!==attempt.identityEpoch))throw new NativeRouteError("STALE_AUTHORITY","An original attempt account identity epoch is unavailable; no other account was queried.",409);
        const physical=[];
        accountControlActive=true;
        try{
          const inspectionSignal=AbortSignal.timeout(110000);
          for(const {attempt,account} of sources){
          const target=account&&options.backend.bindAccount?options.backend.bindAccount(account.accountId,account):options.backend;
          for(const requestId of attempt.physicalRequests??[]){
            if(!target.inspectReceipt)throw new NativeRouteError("UNSUPPORTED_OPERATION","The backend cannot inspect physical receipts.",503);
            const result=PhysicalReceiptInspectionSchema.safeParse(await target.inspectReceipt(requestId,inspectionSignal));
            if(!result.success||result.data.requestId!==requestId)throw new NativeRouteError("BROWSER_PROTOCOL_ERROR","Physical receipt metadata is invalid.",502);
            const owner=result.data.receipt?.owner;
            if(owner&&(owner.logicalRequestId!==logical.requestId||owner.logicalAttemptId!==attempt.attemptId||owner.accountId!==attempt.accountId||owner.identityEpoch!==attempt.identityEpoch))throw new NativeRouteError("STALE_AUTHORITY","Physical receipt belongs to a different logical attempt or account.",409);
            physical.push({...result.data,logicalAttemptId:attempt.attemptId,accountId:attempt.accountId,identityEpoch:attempt.identityEpoch,correlation:owner?"verified":result.data.found?"uncorrelated":"missing"});
          }
          }
          json(response,200,{logical,physical,replayAllowed:false,persistedResultAvailable:false});return;
        }finally{accountControlActive=false;}
      }
      if (url.pathname === "/__native/resume") {
        let data: unknown;
        try { data = JSON.parse((await readBody(request)).toString("utf8")); } catch { throw new NativeRouteError("INVALID_RESUME", "Expected a conversation URL or clear request."); }
        if (counters.active) throw new NativeRouteError("BUSY", "A native generation became active; nothing was armed.", 409);
        if (object(data) && data.clear === true) { resumeRequest = undefined; json(response, 200, { armed: false }); return; }
        if (!object(data) || typeof data.url !== "string" || !/^https:\/\/gemini\.google\.com\/app\/[a-zA-Z0-9_-]{1,128}$/.test(data.url)) throw new NativeRouteError("INVALID_RESUME", "Use an exact https://gemini.google.com/app/CONVERSATION_ID URL without query or fragment.");
        if (!lastTaskScope && data.nextTurn !== true) throw new NativeRouteError("TASK_SCOPE_REQUIRED", "No current native task is known after restart. Use --next-turn to explicitly bind the next IDE request.", 409);
        resumeRequest = { url: data.url, scope: data.nextTurn === true ? undefined : lastTaskScope, accountId: options.accountRegistry?.getActive()?.accountId ?? "default", identityEpoch: options.accountRegistry?.getActive()?.identityEpoch ?? 0, expiresAt: Date.now() + 300000 };
        json(response, 200, { armed: true, binding: resumeRequest.scope ? "current_native_task" : "next_native_task", expiresInSeconds: 300, promptSent: false, instruction: "Keep exactly one stopped tab open at that URL in the isolated browser, then send a NEW follow-up in the intended IDE chat. No failed request will be replayed." }); return;
      }
      if (url.pathname === "/__native/account") {
        let data: unknown;
        try { data = JSON.parse((await readBody(request)).toString("utf8")); } catch { throw new NativeRouteError("INVALID_ARGUMENT", "Expected an account control request."); }
        const parsed = AccountControlRequestSchema.safeParse(data);
        if (!parsed.success) throw new NativeRouteError("INVALID_ARGUMENT", "Invalid account control request.");
        if (!options.accountRegistry) throw new NativeRouteError("UNSUPPORTED_OPERATION", "No account registry configured.", 503);
        // Reading a slow HTTP body yields: repeat the guard for EVERY mutation.
        if (counters.active || router?.activeCount || accountControlActive) throw new NativeRouteError("BUSY", "A generation or account operation became active; nothing changed.", 409);
        const command = parsed.data;
        if (command.action === "verify") {
          if (!options.backend.verifyAccount) throw new NativeRouteError("UNSUPPORTED_OPERATION", "No account identity verifier installed.", 503);
          accountControlActive = true;
          try {
            const verified = await options.backend.verifyAccount(command.accountId, AbortSignal.timeout(25000));
            const account = options.accountRegistry.get(command.accountId)!;
            router?.identityVerified(account.accountId);
            verifiedAccounts.set(account.accountId, { epoch: account.identityEpoch, observedAt: new Date().toISOString() });
            accountFailures.delete(account.accountId);
            json(response, 200, verified); return;
          } catch(error){observeAccountFailure(command.accountId,error);throw error;}finally { accountControlActive = false; }
        }
        if (command.action === "use") options.accountRegistry.setActive(command.accountId, command.expectedRevision);
        else if (command.action === "disable") options.accountRegistry.disable(command.accountId, command.expectedRevision);
        else if (command.action === "enable") options.accountRegistry.enable(command.accountId, command.expectedRevision);
        json(response, 200, { activeAccount: options.accountRegistry.getActive(), ...options.accountRegistry.snapshot() }); return;
      }
      if (url.pathname === "/__native/browser") {
        if (!options.backend.openBrowser) throw new NativeRouteError("UNSUPPORTED_OPERATION", "No live browser opener is installed.", 503);
        let targetAccountId: string | undefined;
        try {
          const raw = await readBody(request);
          if (raw.length > 0) {
            const parsed = JSON.parse(raw.toString("utf8"));
            if (object(parsed) && typeof parsed.accountId === "string") targetAccountId = parsed.accountId;
          }
        } catch {}
        if (counters.active || router?.activeCount || accountControlActive) throw new NativeRouteError("BUSY", "A generation became active; browser selection was not changed.", 409);
        accountControlActive = true;
        try { json(response, 200, await options.backend.openBrowser(targetAccountId)); return; }
        finally { accountControlActive = false; }
      }
      json(response, 200, { stopping: true }); setImmediate(() => { void close(); }); return;
    }
    if (accountControlActive) throw new NativeRouteError("BUSY", "An account operation is active; retry when it finishes.", 409);
    if (stopping) throw new NativeRouteError("SERVICE_UNAVAILABLE", "Native proxy is stopping.", 503);
    if (request.method !== "POST" || !url.pathname.startsWith("/v1internal:") || (url.search && url.search !== "?alt=sse")) throw new NativeRouteError("UNSUPPORTED_ROUTE", "This native route is not supported.", 404);
    if (!/^Bearer \S{1,16384}$/.test(request.headers.authorization ?? "")) throw new NativeRouteError("UNAUTHORIZED", "The IDE must complete its normal Google sign-in.", 401);
    const body = await readBody(request);
    const caller = sha256(request.headers.authorization!);
    if (url.pathname === "/v1internal:streamGenerateContent" || url.pathname === "/v1internal:generateContent") {
      counters.nativeRequests++;
      let envelope: unknown;
      try { envelope = JSON.parse(body.toString("utf8")); } catch { throw new NativeRouteError("INVALID_REQUEST", "Invalid native JSON request."); }
      if (!object(envelope) || ![envelope.model, envelope.modelId, envelope.model_id].some(value => identity.matches(value))) {
        lastTurn = { phase: "model_selection", status: "rejected", code: "NATIVE_MODEL_NOT_SELECTED", receivedModelSelectors: modelSelectors(envelope), expectedModel: identity.symbol ?? WEB_MODEL };
        throw new NativeRouteError("NATIVE_MODEL_NOT_SELECTED", "Select Gemini Web (Local). This proxy never silently sends generation to a Google API model.", 409);
      }
      const compiled = compileNativeTurn(envelope, caller, { batchToolCalls: options.batchToolCalls });
      const taskScope = compiled.taskKey ? sha256(compiled.taskKey + canonical(conversationScopePolicy)) : undefined;
      const prepareContext=(accountId:string,identityEpoch:number,explicitResume=false,resumeUrl?:string)=>{
        let knowledge=resolveKnowledge(taskScope,accountId,identityEpoch);
        let plan=conversations.prepare(taskScope,knowledge?.wire?{...compiled.context,knowledge:knowledge.wire}:compiled.context,explicitResume,resumeUrl,accountId,identityEpoch);
        try{return {knowledge,plan,prompt:compiled.promptFor(plan)};}
        catch(error){
          if(plan)conversations.discardUnsent(plan);
          if(!(error instanceof NativeRouteError)||error.code!=="CONTEXT_TOO_LARGE"||!knowledge?.wire)throw error;
          knowledge={used:false,issues:[...new Set([...knowledge.issues,"SOURCE_BUDGET_EXCEEDED"])],assertCurrent:()=>{}};
          plan=conversations.prepare(taskScope,compiled.context,explicitResume,resumeUrl,accountId,identityEpoch);
          try{return {knowledge,plan,prompt:compiled.promptFor(plan)};}catch(error){if(plan)conversations.discardUnsent(plan);throw error;}
        }
      };
      pruneTurns();
      let turn = turns.get(compiled.requestId);
      if(turn?.settled&&turn.knowledge?.used){
        try{turn.knowledge.assertCurrent();}catch{retiredRequests.add(compiled.requestId);turns.delete(compiled.requestId);throw new NativeRouteError("OUTCOME_UNKNOWN","Source data or binding changed after this response; its cached result was withdrawn, without another Send.",409);}
      }
      if (!turn) {
        if (retiredRequests.has(compiled.requestId)) throw new NativeRouteError("OUTCOME_UNKNOWN", "This request's cached result expired. Its Send identity is retained; inspect Gemini history instead of resending.", 409);
        const resumeMatchesTask = !!resumeRequest && (!resumeRequest.scope || resumeRequest.scope === taskScope);
        if (resumeRequest && resumeRequest.expiresAt <= Date.now()) {
          if (resumeMatchesTask) throw new NativeRouteError("RESUME_EXPIRED", "Conversation continuation expired. Re-arm or clear it explicitly; no new Web chat was created.", 409);
          // An expired continuation for a different IDE chat must not fence a new chat.
          resumeRequest = undefined;
        }
        if (turns.size >= 128) throw new NativeRouteError("QUEUE_FULL", "All native request slots are in use.", 503);
        if (retiredRequests.size + turns.size >= MAX_REQUEST_IDENTITIES) throw new NativeRouteError("REQUEST_LEDGER_FULL", "Native request identity capacity reached; no replay fences were removed.", 503);
        const controller = new AbortController();
        let submissionStarted = false;
        // A scoped resume is only for its exact IDE chat. Other new chats start fresh and
        // leave the explicit resume armed for its owner instead of returning an ID mismatch.
        const explicitResumeUrl = resumeMatchesTask ? resumeRequest?.url : undefined;
        if (explicitResumeUrl && !taskScope) throw new NativeRouteError("TASK_SCOPE_REQUIRED", "Existing conversation continuation requires a native task ID.", 409);
        const selectedAccount=options.accountRegistry?.getActive();
        if(options.accountRegistry&&!selectedAccount)throw new NativeRouteError("ACCOUNT_NOT_FOUND","No enabled account is selected.",412);
        if(explicitResumeUrl&&(resumeRequest!.accountId!==(selectedAccount?.accountId??"default")||resumeRequest!.identityEpoch!==(selectedAccount?.identityEpoch??0)))throw new NativeRouteError("RESUME_ACCOUNT_MISMATCH","Resume was armed for a different account or identity. Select its original account or clear it.",409);
        const allocation=(()=>{
          let routeLease:NativeAccountLease|undefined;
          let plan:ReturnType<NativeConversationState["prepare"]>;
          let reservation:NativeRequestReservation|undefined;
          try{
            routeLease=router?.acquire(compiled.requestId,taskScope,explicitResumeUrl?resumeRequest!.accountId:undefined);
            const activeAccount=routeLease?.account??selectedAccount,activeAccountId=activeAccount?.accountId??"default",identityEpoch=activeAccount?.identityEpoch??0;
            const turnBackend=options.backend.bindAccount&&activeAccount?options.backend.bindAccount(activeAccountId,activeAccount):options.backend;
            const prepared=prepareContext(activeAccountId,identityEpoch,!!explicitResumeUrl,explicitResumeUrl),knowledge=prepared.knowledge,prompt=prepared.prompt;plan=prepared.plan;
            const policy=routeLease?.failoverPolicy;
            const failoverDeadline=policy?performance.now()+policy.deadlineMs:undefined;
            reservation=requestLedger.reserve(compiled.requestId,activeAccountId,identityEpoch,taskScope,policy?{maxAttempts:policy.maxAttempts,deadlineAt:new Date(Date.now()+policy.deadlineMs).toISOString()}:undefined);
            if(routeLease)router!.commit(routeLease);
            return {routeLease,activeAccount,activeAccountId,identityEpoch,turnBackend,plan,prompt,reservation,failoverDeadline,knowledge};
          }catch(error){try{if(plan)conversations.discardUnsent(plan);if(reservation)requestLedger.discardNotSent(reservation,{delivery:"not_sent",code:"NATIVE_ADMISSION_FAILED",phase:"checkpoint",observedAt:new Date().toISOString()});}finally{if(routeLease)router!.release(routeLease);}throw error;}
        })();
        let {routeLease,activeAccount,activeAccountId,identityEpoch,turnBackend,plan,prompt,reservation,knowledge}=allocation;
        const failoverDeadline=allocation.failoverDeadline;
        let resumeUrl=explicitResumeUrl??plan?.resumeUrl;
        const turnModelSelection=routeLease?.modelSelection??modelSelection;
        if (explicitResumeUrl) resumeRequest = undefined;
        lastTaskScope = taskScope;
        const startedAt = performance.now();
        let lastActivity = startedAt, firstTextMs: number | undefined, progressRevision = 0;
        const detail: JsonObject = { routingMode:routeLease?.mode??"manual", requestId: compiled.requestId, accountId: activeAccountId, identityEpoch, attemptId: reservation.attemptId, accountDisplayName: activeAccount?.displayName, promptChars: prompt.length, fullPromptChars: compiled.prompt.length, reused: !!plan?.baseRevision || !!resumeUrl,
          contextMode: plan?.mode ?? "full", contextReason: !plan ? "no_task_identity" : plan.resumeUrl ? "persistent_rebind_after_restart" : !plan.baseRevision ? "new_scope_or_restart" : "existing_revision",
          patchOperations: plan?.patches?.length ?? 0, savedPromptChars: Math.max(0, compiled.prompt.length - prompt.length), toolDescriptionCharsSaved: compiled.toolDescriptionCharsSaved, existingConversationRebind: !!resumeUrl, rebindSource: resumeUrl ? "persistent_metadata" : plan?.baseRevision ? "live_revision" : "fresh", phase: "preparing" };
        lastTurn = detail;
        const current: PendingTurn = { controller, waiters: 0, settled: false, ready: Promise.resolve(), promise: Promise.resolve({}), text: "", diagnostic:detail,knowledge, listeners: new Set() };
        if(knowledge)detail.knowledge={used:knowledge.used,issues:knowledge.issues};
        let browserReady!:()=>void,browserReadinessFailed!:(error:unknown)=>void;
        current.ready=new Promise<void>((resolve,reject)=>{browserReady=resolve;browserReadinessFailed=reject;});
        void current.ready.catch(()=>{});
        turns.set(compiled.requestId, current);
        counters.browserRequests++; counters.active++;
        const timer = setTimeout(() => controller.abort(new NativeRouteError("TIMEOUT", "Native generation reached its hard duration limit; it will not be replayed.", 504)), maximum);
        let idleTimer: ReturnType<typeof setTimeout>;
        const scheduleIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => controller.abort(new NativeRouteError("TIMEOUT", "Gemini Web made no observable progress within its idle budget; it will not be replayed.", 504)), idleBudget); };
        scheduleIdle();
        let onAbort!: () => void;
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => {
            const error = controller.signal.reason instanceof NativeRouteError ? controller.signal.reason : new NativeRouteError("CANCELLED", "Native client cancelled or disconnected; no automatic resend.", 499);
            if (!error.delivery) error.delivery = submissionStarted ? "unknown" : "not_sent";
            if (!error.phase) error.phase = submissionStarted ? "submission" : "checkpoint";
            if (error.delivery === "not_sent" && plan?.baseRevision && !error.recovery) error.recovery = { delivery: "not_sent", baseRevision: plan.baseRevision };
            reject(error);
          };
          controller.signal.addEventListener("abort", onAbort, { once: true });
        });
        const checkpointFailure = (cause: unknown,attemptPlan=plan) => {
          const error = cause instanceof NativeRouteError ? cause : new NativeRouteError("BROWSER_PREPARATION_FAILED", "Browser readiness failed before Send.", 503);
          error.phase = "checkpoint";
          error.delivery = "not_sent";
          if (attemptPlan?.baseRevision) error.recovery = { delivery: "not_sent", baseRevision: attemptPlan.baseRevision };
          return error;
        };
        let conversationUrl: string | undefined;
        const attempts:JsonObject[]=[];detail.attempts=attempts;
        const generation = Promise.resolve().then(async () => {
          for(;;){
          const attempt={routeLease,activeAccountId,identityEpoch,turnBackend,plan,prompt,reservation,resumeUrl,knowledge};
          const attemptDetail:JsonObject={attemptId:reservation.attemptId,accountId:activeAccountId,identityEpoch,phase:"preparing"};attempts.push(attemptDetail);
          const activeAttempt=()=>!current.settled&&!controller.signal.aborted&&reservation.attemptId===attempt.reservation.attemptId;
          const requireActiveAttempt=()=>{if(!activeAttempt())throw new NativeRouteError("STALE_AUTHORITY","A retired native attempt cannot issue another browser operation.",409);};
          let possibleSend=false,observedModel=turnModelSelection;
          try{
          await Promise.resolve().then(()=>attempt.turnBackend.prepare?.(controller.signal)).catch(error=>{throw checkpointFailure(error,attempt.plan);});
          requireActiveAttempt();browserReady();
          for (const key of attempt.plan?.retiredKeys ?? []) { controller.signal.throwIfAborted(); await options.backend.releaseConversation?.(key, !!attempt.resumeUrl); }
          controller.signal.throwIfAborted(); detail.phase = "waiting";
          attemptDetail.phase="generating";
          const browserRequestId="native_"+sha256(compiled.requestId+"\n"+attempt.reservation.attemptId);
          const reply=await attempt.turnBackend.generate(browserRequestId, attempt.prompt, controller.signal, {
            parallelAccountRouting:attempt.routeLease!==undefined&&attempt.routeLease.mode!=="manual",
            receiptOwner:{logicalRequestId:attempt.reservation.requestId,logicalAttemptId:attempt.reservation.attemptId,accountId:attempt.activeAccountId,identityEpoch:attempt.identityEpoch},
            onPhysicalSubmission:id=>{requireActiveAttempt();attempt.knowledge?.assertCurrent();requestLedger.recordPhysical(attempt.reservation,id);},
            conversation: attempt.plan ? { key: attempt.plan.key, revision: attempt.plan.revision, baseRevision: attempt.plan.baseRevision, resumeUrl:attempt.resumeUrl } : undefined,
            snapshotAttachment: options.snapshotAttachment, responseNonce: compiled.nonce,
            modelSelection:turnModelSelection, maxDurationMs: maximum, stallTimeoutMs: idleBudget,
            contextModelSelection:(attempt.plan?.mode ?? "full") === "full" ? options.contextModelSelection : undefined,
            onSubmissionStarted: () => { requireActiveAttempt();if (!submissionStarted) requestLedger.submitted(attempt.reservation); submissionStarted = true; detail.phase = "submitting"; },
            onTransportPlan: messageCount => { if(activeAttempt())detail.transportMessages = messageCount; },
            onTransportTrace: trace => {
              if (!activeAttempt()) return;
              if(trace.stage==="prepared")observedModel=trace.modelSelection;
              if(trace.stage==="prepared"&&trace.kind==="attachment")detail.phase="processing_file";
              if(trace.submission?.sendClickAttempted||trace.submission?.acceptanceObserved||trace.stage==="completed")possibleSend=true;
              const traces = (detail.transportTrace ??= []) as unknown[];
              if (traces.length < 44) traces.push({...trace,logicalAttemptId:attempt.reservation.attemptId,accountId:attempt.activeAccountId});
            },
            onCancellationResult: result => {
              if(reservation.attemptId!==attempt.reservation.attemptId)return;
              detail.browserStopConfirmed = result.confirmed;
              if (result.reason) detail.browserStopReason = result.reason;
              current.resolveCancellationResult?.(result.confirmed);
              current.resolveCancellationResult = undefined;
            },
            onConversationCheckpoint: url => { if(activeAttempt())conversationUrl = url; },
            onProgress: progress => {
              if (!activeAttempt() || progress.revision <= progressRevision) return;
              if(progress.text)possibleSend=true;
              progressRevision = progress.revision; lastActivity = performance.now(); scheduleIdle(); detail.phase = progress.stage ?? "generating";
              const raw = progress.codeBlocks?.length === 1 ? progress.codeBlocks[0] : progress.codeBlocks?.length ? undefined : progress.text;
              const partial = compiled.canStreamText && raw !== undefined ? nativePartialText(raw, compiled.nonce) : undefined;
              if (partial === undefined) return;
              if (!partial.startsWith(current.text)) { controller.abort(new NativeRouteError("STREAM_REWRITTEN", "Web output changed after text was streamed; no native tool was executed.", 502)); return; }
              if (partial.length > 131072) { controller.abort(new NativeRouteError("RESULT_TOO_LARGE", "Native output exceeds its limit.", 502)); return; }
              if (partial.length > current.text.length) { firstTextMs ??= performance.now() - startedAt; current.text = partial; for (const listener of current.listeners) listener(); }
            },
          });
          attemptDetail.phase="completed";return reply;
          }catch(cause){
            let error=cause;
            if(error instanceof NativeRouteError&&error.delivery==="not_sent"&&(possibleSend||current.text.length))error.delivery="unknown";
            const proof=nativeNotSentProof(error);attemptDetail.phase=proof?"not_sent":"failed";attemptDetail.code=error instanceof NativeRouteError?error.code:"NATIVE_GENERATION_FAILED";
            if(attempt.routeLease)router!.observeNotSent(attempt.routeLease,error,observedModel);
            if(!activeAttempt()||!proof||!permitsAccountFailover(proof)||!attempt.routeLease?.failoverPolicy?.enabled||attempt.reservation.version!==2)throw error;
            if(failoverDeadline===undefined||performance.now()>=failoverDeadline){detail.failoverStopped="deadline";throw error;}
            requestLedger.notSent(attempt.reservation,proof);
            const next=router!.next(attempt.routeLease);
            if(!next){detail.failoverStopped=attempt.routeLease.attemptedAccountIds.length>=attempt.routeLease.failoverPolicy.maxAttempts?"attempt_budget":"no_eligible_account";throw error;}
            routeLease=next;
            try{
              if(attempt.plan)conversations.discardUnsent(attempt.plan);
              const nextAccount=next.account,nextBackend=options.backend.bindAccount?options.backend.bindAccount(nextAccount.accountId,nextAccount):options.backend;
              const prepared=prepareContext(nextAccount.accountId,nextAccount.identityEpoch),nextKnowledge=prepared.knowledge,nextPlan=prepared.plan;
              try{
                const nextPrompt=prepared.prompt,nextReservation=requestLedger.nextAttempt(attempt.reservation,nextAccount.accountId,nextAccount.identityEpoch);
                activeAccount=nextAccount;activeAccountId=nextAccount.accountId;identityEpoch=nextAccount.identityEpoch;turnBackend=nextBackend;plan=nextPlan;prompt=nextPrompt;reservation=nextReservation;resumeUrl=nextPlan?.resumeUrl;knowledge=nextKnowledge;current.knowledge=knowledge;
                router!.commit(next);
              }catch(error){if(nextPlan)conversations.discardUnsent(nextPlan);throw error;}
              submissionStarted=false;progressRevision=0;conversationUrl=undefined;counters.browserRequests++;
              if(knowledge)detail.knowledge={used:knowledge.used,issues:knowledge.issues};
              Object.assign(detail,{accountId:activeAccountId,identityEpoch,attemptId:reservation.attemptId,accountDisplayName:activeAccount.displayName,promptChars:prompt.length,contextMode:plan?.mode??"full",reused:!!plan?.baseRevision||!!resumeUrl,phase:"preparing",failoverCount:next.attemptedAccountIds.length-1});
            }catch(error){detail.failoverStopped="next_account_preparation_failed";throw checkpointFailure(error);}
          }
          }
        });
        let backendSettled=false;
        void generation.finally(()=>{backendSettled=true;if(current.settled&&routeLease)router!.release(routeLease);}).catch(()=>{});
        current.promise = Promise.race([generation, aborted])
          .then(text => {
            controller.signal.throwIfAborted(); turnBackend.assertAuthority?.();knowledge?.assertCurrent(); const result = compiled.parseReply(text);
            const candidate = (result.response as { candidates: Array<{ content: { parts: Array<{ text?: string }> } }> }).candidates[0];
            if (current.text && !candidate.content.parts[0].text?.startsWith(current.text)) throw new NativeRouteError("STREAM_REWRITTEN", "Final Web output differs from its streamed prefix.", 502);
            requestLedger.complete(reservation); if (plan) conversations.complete(plan, conversationUrl); detail.phase = "completed"; accountFailures.delete(activeAccountId);counters.completed++; return result;
          })
          .catch(error => {
            browserReadinessFailed(error);
            const definitelyNotSent = error instanceof NativeRouteError && error.delivery === "not_sent";
            const retainedBase = definitelyNotSent && !!plan?.baseRevision && error.recovery?.delivery === "not_sent" && error.recovery.baseRevision === plan.baseRevision;
            current.retryableNotSent = definitelyNotSent;
            if (definitelyNotSent) {
              try { current.retryableNotSent=requestLedger.discardNotSent(reservation,nativeNotSentProof(error)); }
              catch { current.retryableNotSent = false; detail.logicalLedgerWarning = "not_sent_fence_retained"; }
            }
            else if(reservation.version===2){try{requestLedger.unknown(reservation);}catch{detail.logicalLedgerWarning="uncertain_attempt_fence_retained";}}
            if (plan) {
              if (definitelyNotSent) {
                try { conversations.discardUnsent(plan); } catch { detail.conversationCacheWarning = "pre_send_checkpoint_cleanup_failed"; }
              } else {
                try { conversations.markOutcomeUnknown(plan); } catch { detail.conversationCacheWarning = "uncertain_turn_quarantined_by_reservation"; }
                const failedPlan=plan,failedBackend=turnBackend;
                void generation.finally(() => failedBackend.releaseConversation?.(failedPlan.key, true)).catch(() => {});
              }
            }
            detail.phase = "failed"; detail.code = error instanceof NativeRouteError ? error.code : "NATIVE_GENERATION_FAILED";
            observeAccountFailure(activeAccountId,error);
            detail.delivery = error instanceof NativeRouteError ? error.delivery ?? "unknown" : "unknown";
            if (error instanceof NativeRouteError && error.modelSelection) detail.modelSelection = error.modelSelection;
            if (error instanceof NativeRouteError && error.diagnostic) detail.diagnostic = error.diagnostic;
            detail.baseRetained = retainedBase;
            if (error instanceof NativeRouteError && error.phase) detail.failurePhase = error.phase;
            counters.failed++; throw error;
          })
          .finally(() => {
            clearTimeout(timer); clearTimeout(idleTimer); controller.signal.removeEventListener("abort", onAbort); current.settled = true; current.settledAt = Date.now(); counters.active--;
            if(backendSettled&&routeLease)router!.release(routeLease);
            detail.elapsedMs = Math.round(performance.now() - startedAt); detail.firstTextMs = firstTextMs === undefined ? null : Math.round(firstTextMs); detail.silentMs = Math.round(performance.now() - lastActivity);
            if (current.retryableNotSent && current.waiters === 0 && turns.get(compiled.requestId) === current) turns.delete(compiled.requestId);
            pruneTurns();
          });
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
        else if (!current.waiters && current.settled && current.retryableNotSent && turns.get(compiled.requestId) === current) turns.delete(compiled.requestId);
        pruneTurns();
      };
      response.once("close", release);
      const streaming = url.pathname.includes("streamGenerateContent");
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let sentChars = 0;
      const sendProgress = () => {
        if (!response.destroyed && !response.writableEnded && current.text.length > sentChars) {
          response.write("data: " + JSON.stringify(nativeTextFrame(current.text.slice(sentChars), compiled.requestId)) + "\n\n"); sentChars = current.text.length;
        }
      };
      try {
        await current.ready;
        if (response.destroyed) return;
        if (streaming) {
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
          response.write(": Gemini Web browser ready; waiting for model output\n\n");
          current.listeners.add(sendProgress); sendProgress();
          heartbeat = setInterval(() => { if (!response.destroyed) response.write(": waiting\n\n"); }, 10000);
        }
        const result = await current.promise;
        if (response.destroyed) return;
        if (streaming) {
          sendProgress();
          const terminal = structuredClone(result);
          const part = (terminal.response as { candidates: Array<{ content: { parts: Array<{ text?: string }> } }> }).candidates[0].content.parts[0];
          if (part.text !== undefined) part.text = part.text.slice(sentChars);
          response.end("data: " + JSON.stringify(terminal) + "\n\n");
        }
        else json(response, 200, result);
      } catch (error) {
        if (streaming && response.headersSent && !response.destroyed) {
          const code = error instanceof NativeRouteError ? error.code : "NATIVE_GENERATION_FAILED";
          // Use one ordinary terminal candidate for native compatibility. STOP is
          // the wire boundary only; diagnostics and receipts keep the failed state.
          const phase = error instanceof NativeRouteError ? error.phase : undefined;
          const reason = code==="RESOURCE_LIMIT"?"Worker hoặc metadata hội thoại đã đạt giới hạn; kiểm tra trạng thái cleanup."
            : phase === "model_selection" ? "Lỗi khi chọn/xác minh model trên Web."
            : phase === "checkpoint" ? (code === "CONVERSATION_NOT_OPEN" ? "Tab hội thoại không mở; kiểm tra trình duyệt." : code === "ACCOUNT_IDENTITY_CHANGED" ? "Tài khoản Gemini đã thay đổi; chọn đúng tài khoản." : "Không xác minh được phiên Web.")
            : phase === "submission" ? "Lỗi ở bước gửi; kết quả tiếp nhận có thể chưa rõ."
            : "Lỗi khi nhận câu trả lời từ Web.";
          const terminal = { response: { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "\n[Gemini Web error: " + code + "] " + reason + " Lượt này đã kết thúc; không tự gửi lại." }] }, finishReason: "STOP" }] }, traceId: compiled.requestId };
          response.end("data: " + JSON.stringify(terminal) + "\n\n");
        } else throw error;
      } finally { current.listeners.delete(sendProgress); clearInterval(heartbeat); response.off("close", release); release(); }
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
        const catalog = JSON.parse(result.body.toString("utf8"));
        upstreamCatalog = catalogModelReferences(catalog);
        json(response, 200, identity.merge(catalog)); return;
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
      const closed = await Promise.allSettled([async () => options.backend.close(), async () => chatImports?.close()].map(close => close()));
      const failure = closed.find((result): result is PromiseRejectedResult => result.status === "rejected"); if (failure) throw failure.reason;
    })();
    return closePromise;
  }
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? NATIVE_PROXY_PORT, "127.0.0.1", resolve); });
  const address = server.address() as { port: number };
  return { port: address.port, close, counters, identity, server };
}
