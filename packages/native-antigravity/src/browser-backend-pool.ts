import type { NativeBrowserBackend, NativeGenerationOptions } from "./browser-backend.js";
import { McpNativeBrowserBackend } from "./browser-backend.js";
import type { AccountRegistry } from "./account-registry.js";
import { observedAccountFingerprint } from "./browser-readiness.js";
import { canonical, NativeRouteError, type JsonObject } from "./native-protocol.js";
import type { AccountRecord } from "@antigravity-gemini-web/contracts";
import { parseMcpNodeSemiSpace } from "@antigravity-gemini-web/contracts";

const workerConfig = (account: AccountRecord) => canonical({ profile: account.profilePath, state: account.statePath, port: account.debugPort, fingerprint: account.identityFingerprint, epoch: account.identityEpoch, transport:account.browserTransport ?? "cdp" });
const MAX_CACHED_WORKERS=32,MAX_CONVERSATION_OWNERS=256,MAX_PENDING_RELEASES_PER_ACCOUNT=256;

export class NativeBrowserBackendPool implements NativeBrowserBackend {
  private backends = new Map<string, { config: string; backend: NativeBrowserBackend }>();
  private conversationOwners=new Map<string,string>();
  private pendingReleases=new Map<string,Map<string,boolean>>();
  private draining=new Set<string>();
  private closing=false;private closed=false;private shutdown?:Promise<void>;
  private readonly nodeSemiSpaceMiB = parseMcpNodeSemiSpace(process.env.AG_MCP_NODE_SEMI_SPACE_MB);
  constructor(public readonly registry: AccountRegistry, private readonly cliPath: string, private readonly backendFactory?: (account: AccountRecord) => NativeBrowserBackend) {}

  getBackend(accountId?: string): { account: AccountRecord; backend: NativeBrowserBackend } {
    if(this.closing)throw new NativeRouteError("SERVICE_UNAVAILABLE","The account pool is shutting down; no worker was started.",503);
    const account = accountId ? this.registry.get(accountId) : this.registry.getActive();
    if (!account) throw new NativeRouteError("ACCOUNT_NOT_FOUND", "No selected account was found.", 404);
    if (!account.enabled) throw new NativeRouteError("ACCOUNT_DISABLED", "Selected account is disabled.", 409);
    if(!this.backendFactory && account.browserTransport!=="extension")throw new NativeRouteError("UNSUPPORTED_OPERATION","Legacy bridge Chrome is retired. Add and pair an extension account in the launcher; the old profile is preserved for deletion or manual recovery.",412);
    const config = workerConfig(account);
    let entry = this.backends.get(account.accountId);
    if (entry && entry.config !== config) throw new NativeRouteError("ACCOUNT_RUNTIME_STALE", "Account identity or worker configuration changed. Restart the native runtime before sending.", 412);
    if (!entry) {
      if(this.backends.size>=MAX_CACHED_WORKERS)throw new NativeRouteError("RESOURCE_LIMIT","Cached account workers reached their bound; no new worker was created.",503);
      const backend = this.backendFactory ? this.backendFactory(account) : new McpNativeBrowserBackend(this.cliPath, {
        AG_MCP_BROWSER_PROFILE: account.profilePath, AG_MCP_STATE_DIR: account.statePath, AG_MCP_DEBUG_PORT: String(account.debugPort), AG_MCP_NODE_SEMI_SPACE_MB: this.nodeSemiSpaceMiB === null ? "off" : String(this.nodeSemiSpaceMiB),
        AG_MCP_BROWSER_TRANSPORT: account.browserTransport ?? "cdp",
      }, account.identityFingerprint ?? "");
      entry = { config, backend }; this.backends.set(account.accountId, entry);
    }
    return { account, backend: entry.backend };
  }

  /** Capture the worker once. A later registry selection cannot redirect this turn. */
  bindAccount(accountId: string,expectedAccount?:AccountRecord): NativeBrowserBackend {
    const { account, backend } = this.getBackend(accountId), config = workerConfig(account);
    if(expectedAccount&&(expectedAccount.accountId!==accountId||workerConfig(expectedAccount)!==config))throw new NativeRouteError("STALE_ACCOUNT_SELECTION","The selected account configuration changed before its worker was bound; no browser action started.",412);
    const check = (delivery: "not_sent" | "unknown" = "not_sent") => {
      if(this.closing){const error=new NativeRouteError("SERVICE_UNAVAILABLE","The captured account pool is shutting down.",503);error.delivery=delivery;error.phase=delivery==="not_sent"?"checkpoint":"response";throw error;}
      const current = this.registry.get(account.accountId);
      if (!current?.enabled || workerConfig(current) !== config) {
        const error = new NativeRouteError("ACCOUNT_IDENTITY_CHANGED", "The pinned account was disabled or changed before submission.", 412);
        error.phase = delivery === "not_sent" ? "checkpoint" : "response"; error.delivery = delivery; throw error;
      }
    };
    return {
      prepare: async signal => { check(); await backend.prepare?.(signal); await this.drain(account.accountId);check(); },
      assertAuthority: () => check("unknown"),
      inspectImportSurface:async signal=>{check();signal.throwIfAborted();if(!backend.inspectImportSurface)throw new NativeRouteError("UNSUPPORTED_OPERATION","Import surface inspection is unavailable.",503);const result=await backend.inspectImportSurface(signal);check();signal.throwIfAborted();return result;},
      inspectReceipt:async(id,signal)=>{check();if(!backend.inspectReceipt)throw new NativeRouteError("UNSUPPORTED_OPERATION","Physical receipt inspection is unavailable.",503);const result=await backend.inspectReceipt(id,signal);check();return result;},
      generate: async (id, prompt, signal, options) => {
        check();const key=options?.conversation?.key;
        if(key){const owner=this.conversationOwners.get(key);if(owner&&owner!==account.accountId)throw new NativeRouteError("CONVERSATION_CHANGED","A browser conversation belongs to another account.",409);if(!owner&&this.conversationOwners.size>=MAX_CONVERSATION_OWNERS){const error=new NativeRouteError("RESOURCE_LIMIT","Retained conversation ownership reached its bound before this generation; inspect cleanup status.",503);error.delivery="not_sent";error.phase="checkpoint";throw error;}this.conversationOwners.set(key,account.accountId);}
        try{const reply=await backend.generate(id,prompt,signal,options);check("unknown");return reply;}finally{await this.drain(account.accountId);}
      },
      releaseConversation: async(key, preserve=false) => {
        const owner=this.conversationOwners.get(key);
        if(owner&&owner!==account.accountId)throw new NativeRouteError("CONVERSATION_CHANGED","Cleanup belongs to a different account; no worker was called.",409);
        await this.releaseOn(account.accountId,key,preserve,backend);
      },
      close: async () => {}, // The pool owns the connection lifecycle.
    };
  }
  async verifyAccount(accountId: string, signal: AbortSignal): Promise<JsonObject> {
    const { account, backend } = this.getBackend(accountId);
    if (!backend.inspectIdentity) throw new NativeRouteError("UNSUPPORTED_OPERATION", "This backend cannot inspect account identity.", 503);
    const status = await backend.inspectIdentity(signal);
    if(this.closing)throw new NativeRouteError("SERVICE_UNAVAILABLE","The account pool shut down during identity verification; enrollment was not changed.",503);
    const fingerprint = observedAccountFingerprint(status.accountIdentity);
    if (!fingerprint) throw new NativeRouteError("ACCOUNT_IDENTITY_UNVERIFIED", "The account email could not be verified from the browser. Check the account avatar and sign-in state.", 412);
    const latest = this.registry.get(accountId);
    if (!latest?.enabled || workerConfig(latest) !== workerConfig(account)) throw new NativeRouteError("STALE_ACCOUNT_SELECTION", "Account changed while verification was running.", 409);
    if (account.identityFingerprint && account.identityFingerprint !== fingerprint) throw new NativeRouteError("ACCOUNT_IDENTITY_CHANGED", "The browser is signed into a different account. Use a separate profile for that account.", 412);
    if (!account.identityFingerprint) {
      await backend.close();if(this.closing)throw new NativeRouteError("SERVICE_UNAVAILABLE","The account pool shut down before identity enrollment; registry metadata was not changed.",503);this.backends.delete(accountId);
      this.registry.enrollIdentity(accountId, fingerprint, account.identityEpoch);
    }
    return { accountId, identityVerified: true, identityEpoch: this.registry.get(accountId)!.identityEpoch, observedAt: new Date().toISOString(), promptSent: false };
  }
  async generate(id: string, prompt: string, signal: AbortSignal, options?: NativeGenerationOptions) {
    const { account } = this.getBackend(); return this.bindAccount(account.accountId,account).generate(id, prompt, signal, options);
  }
  async prepare(signal: AbortSignal) { const { account } = this.getBackend(); await this.bindAccount(account.accountId,account).prepare?.(signal); }
  async openBrowser(accountId?: string): Promise<JsonObject> {
    const { backend } = this.getBackend(accountId);
    if (!backend.openBrowser) throw new NativeRouteError("UNSUPPORTED_OPERATION", "No live browser opener installed.", 503);
    const result=await backend.openBrowser();if(this.closing)throw new NativeRouteError("SERVICE_UNAVAILABLE","The account pool shut down while the browser opener was running.",503);return result;
  }
  private async releaseOn(accountId:string,key:string,preserve:boolean,expectedBackend?:NativeBrowserBackend){
    if(this.closing)throw new NativeRouteError("SERVICE_UNAVAILABLE","The account pool is shutting down; no cleanup worker was reopened.",503);
    const entry=this.backends.get(accountId);
    if(expectedBackend&&entry?.backend!==expectedBackend)throw new NativeRouteError("ACCOUNT_RUNTIME_STALE","The captured cleanup worker was replaced; no other worker was called.",412);
    if(!entry)return;
    const effectivePreserve=preserve||this.pendingReleases.get(accountId)?.get(key)===true;
    try{await entry.backend.releaseConversation?.(key,effectivePreserve);this.pendingReleases.get(accountId)?.delete(key);if(this.conversationOwners.get(key)===accountId)this.conversationOwners.delete(key);}
    catch(error){
      if(!(error instanceof NativeRouteError)||error.code!=="BUSY")throw error;
      if(this.closing)throw new NativeRouteError("SERVICE_UNAVAILABLE","The account pool shut down during cleanup; no deferred worker was recreated.",503);
      const pending=this.pendingReleases.get(accountId)??new Map<string,boolean>();
      if(pending.size>=MAX_PENDING_RELEASES_PER_ACCOUNT&&!pending.has(key))throw new NativeRouteError("CLEANUP_QUEUE_FULL","Deferred account cleanup reached its bound; no cleanup was dropped.",503);
      pending.set(key,pending.get(key)===true||effectivePreserve);this.pendingReleases.set(accountId,pending);
    }
  }
  private async drain(accountId:string){
    if(this.draining.has(accountId))return;
    this.draining.add(accountId);
    try{for(const [key,preserve] of [...(this.pendingReleases.get(accountId)??[])]){await this.releaseOn(accountId,key,preserve);if(this.pendingReleases.get(accountId)?.has(key))break;}}
    finally{this.draining.delete(accountId);if(!this.pendingReleases.get(accountId)?.size)this.pendingReleases.delete(accountId);}
  }
  async releaseConversation(key: string, preserve = false) {const owner=this.conversationOwners.get(key);for(const accountId of owner?[owner]:this.backends.keys())await this.releaseOn(accountId,key,preserve);}
  async releaseAccountConversation(accountId:string,key:string,preserve=false){
    if(this.closing)throw new NativeRouteError("SERVICE_UNAVAILABLE","The account pool is shutting down.",503);
    const entry=this.backends.get(accountId);if(!entry)return;
    const owner=this.conversationOwners.get(key);if(owner&&owner!==accountId)throw new NativeRouteError("CONVERSATION_CHANGED","Cleanup belongs to a different account; no worker was called.",409);
    if(this.draining.has(accountId))throw new NativeRouteError("BUSY","Account cleanup is already running.",409);
    await entry.backend.releaseConversation?.(key,preserve);
    if(owner===accountId)this.conversationOwners.delete(key);
    this.pendingReleases.get(accountId)?.delete(key);if(!this.pendingReleases.get(accountId)?.size)this.pendingReleases.delete(accountId);
  }
  resourceStatus(){return {lifecycle:this.closed?"closed":this.closing?"closing":"active",cachedWorkers:this.backends.size,conversationOwners:this.conversationOwners.size,pendingConversationReleases:[...this.pendingReleases.values()].reduce((sum,entries)=>sum+entries.size,0),drainingAccounts:this.draining.size,requestedNodeSemiSpaceMiB:this.nodeSemiSpaceMiB,limits:{cachedWorkers:MAX_CACHED_WORKERS,conversationOwners:MAX_CONVERSATION_OWNERS,deferredReleasesPerAccount:MAX_PENDING_RELEASES_PER_ACCOUNT}};}
  async removeAccount(accountId:string){
    if(this.closing)throw new NativeRouteError("SERVICE_UNAVAILABLE","The account pool is shutting down.",503);
    if([...this.conversationOwners.values()].includes(accountId)||this.pendingReleases.get(accountId)?.size||this.draining.has(accountId))throw new NativeRouteError("ACCOUNT_IN_USE","This account still owns a retained chat or pending cleanup.",409);
    const entry=this.backends.get(accountId);if(!entry)return;
    await entry.backend.close();
    if(this.backends.get(accountId)===entry)this.backends.delete(accountId);
  }
  async close() {
    if(!this.shutdown){this.closing=true;this.shutdown=(async()=>{try{const results=await Promise.allSettled([...this.backends.values()].map(async({backend})=>backend.close()));const failure=results.find((result):result is PromiseRejectedResult=>result.status==="rejected");if(failure)throw failure.reason;}finally{this.backends.clear();this.conversationOwners.clear();this.pendingReleases.clear();this.draining.clear();this.closed=true;}})();}
    return this.shutdown;
  }
}
