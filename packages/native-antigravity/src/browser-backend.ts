import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NativeRouteError, object, sha256, type JsonObject } from "./native-protocol.js";
import { nativeBrowserTransport, nativeSnapshotTransport, MAX_WEB_MESSAGE_CHARS, transportReplyCategory } from "./browser-transport.js";
import { ensureNativeBrowserReady } from "./browser-readiness.js";
import { ModelSelectionDiagnosticSchema, BrowserSubmissionDiagnosticSchema, NativeTransportTraceSchema, WebModelSelectionSchema, type NativeTransportTrace, type NativeReceiptOwner,type AccountRecord } from "@antigravity-gemini-web/contracts";
import { parseMcpNodeSemiSpace, mcpNodeMemoryArgs, McpNodeMemoryStatusSchema, type McpNodeSemiSpace } from "@antigravity-gemini-web/contracts";
import { ChatImportSurfaceObservationSchema, type ChatImportSurfaceObservation } from "@antigravity-gemini-web/contracts";

export interface NativeBrowserProgress { revision: number; text: string; codeBlocks?: string[]; stage?: string }
export interface NativeCancellationObservation { confirmed: boolean; reason?: string }
export interface NativeGenerationOptions {
  parallelAccountRouting?:boolean;
  receiptOwner?: NativeReceiptOwner;
  onPhysicalSubmission?: (requestId:string)=>void;
  /** Experimental opt-in, never inferred from model output. */
  snapshotAttachment?: boolean;
  responseNonce?: string;
  conversation?: { key: string; revision: string; baseRevision?: string; resumeUrl?: string };
  modelSelection?: { model: string; effort?: string };
  contextModelSelection?: { model: string; effort?: string };
  stallTimeoutMs?: number;
  maxDurationMs?: number;
  onProgress?: (progress: NativeBrowserProgress) => void;
  onConversationCheckpoint?: (conversationUrl: string) => void;
  /** Fires immediately before the browser broker call that can submit a prompt. */
  onSubmissionStarted?: () => void;
  onTransportPlan?: (messageCount: number) => void;
  onTransportTrace?: (trace: NativeTransportTrace) => void;
  /** Reports whether Gemini Web confirmed that its active generation stopped. */
  onCancellationResult?: (result: NativeCancellationObservation) => void;
}
export interface NativeBrowserBackend {
  generate(requestId: string, prompt: string, signal: AbortSignal, options?: NativeGenerationOptions): Promise<string>;
  close(): Promise<void>;
  openBrowser?(accountId?: string): Promise<JsonObject>;
  inspectIdentity?(signal: AbortSignal): Promise<JsonObject>;
  inspectImportSurface?(signal: AbortSignal): Promise<ChatImportSurfaceObservation>;
  inspectReceipt?(requestId:string,signal:AbortSignal):Promise<JsonObject>;
  bindAccount?(accountId: string,expectedAccount?:AccountRecord): NativeBrowserBackend;
  verifyAccount?(accountId: string, signal: AbortSignal): Promise<JsonObject>;
  assertAuthority?(): void;
  prepare?(signal: AbortSignal): Promise<void>;
  releaseConversation?(key: string, preserve?: boolean): Promise<void>;
  resourceStatus?(): JsonObject;
}
/**
 * A normal Gemini answer may contain code examples. Only prefer a code block
 * when it is visibly the nonce-bound bridge envelope; otherwise preserve the
 * complete rendered answer for the native protocol to handle as final text.
 */
export function selectNativeBrowserReply(text: string, codeBlocks: unknown): string {
  const blocks = Array.isArray(codeBlocks) ? codeBlocks.filter((value): value is string => typeof value === "string") : [];
  const isNativeEnvelope = (value: string) => /"nonce"\s*:/.test(value) && /"type"\s*:\s*"(?:final|tool_call|tool_calls)"/.test(value);
  const envelopes = blocks.filter(isNativeEnvelope);
  if (envelopes.length > 1) throw new NativeRouteError("AMBIGUOUS_MODEL_REPLY", "Native response contains multiple protocol code blocks.", 502);
  if (envelopes.length === 1) return envelopes[0];
  if (!text.trim() && blocks.length === 1) return blocks[0];
  return text;
}
/** Reuse the existing singleton browser owner, not a second Chrome/profile controller. */
export class McpNativeBrowserBackend implements NativeBrowserBackend {
  private client = new Client({ name: "gemini-native-provider", version: "0.1.0" });
  private connection?: Promise<void>;
  private retained = new Set<string>();
  private readonly nodeSemiSpaceMiB: McpNodeSemiSpace;
  constructor(private readonly cliPath: string, private readonly envOverrides?: Record<string, string>, private readonly expectedIdentityFingerprint?: string) {
    this.nodeSemiSpaceMiB = parseMcpNodeSemiSpace(envOverrides?.AG_MCP_NODE_SEMI_SPACE_MB ?? process.env.AG_MCP_NODE_SEMI_SPACE_MB);
  }
  private connect(): Promise<void> {
    if (this.connection) return this.connection;
    const client = this.client;
    const pending = client.connect(new StdioClientTransport({
      command: process.execPath, args: [...mcpNodeMemoryArgs(this.nodeSemiSpaceMiB), this.cliPath], stderr: "pipe",
      env: { ...process.env, AG_MCP_TARGET_CLIENT: "any", ...(this.envOverrides ?? {}), AG_MCP_NODE_SEMI_SPACE_MB: this.nodeSemiSpaceMiB === null ? "off" : String(this.nodeSemiSpaceMiB) },
    }), { timeout: 10000 }).then(() => undefined);
    this.connection = pending;
    void pending.catch(() => {
      if (this.connection === pending) {
        this.connection = undefined;
        void client.close().catch(() => {});
        this.client = new Client({ name: "gemini-native-provider", version: "0.1.0" });
      }
    });
    return pending;
  }
  private async call(name: string, args: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
    const result = await this.client.callTool({ name, arguments: args }, undefined, { signal, timeout: 25000 });
    const content = result.content as Array<{ type: string; text?: string }>;
    let value: unknown;
    try { value = JSON.parse(content.find(part => part.type === "text")?.text ?? ""); } catch {}
    if (!object(value)) throw new NativeRouteError("BROWSER_PROTOCOL_ERROR", "Browser broker returned an invalid result.", 502);
    if (result.isError) throw new NativeRouteError(typeof value.code === "string" ? value.code : "BROWSER_UNAVAILABLE", "Browser broker rejected the native request. Inspect browser status; do not resend uncertain requests.", 503);
    if (name === "gemini_status" && this.nodeSemiSpaceMiB !== null) {
      const memory = McpNodeMemoryStatusSchema.safeParse(value.nodeMemory);
      if (!memory.success || memory.data.status !== "applied" || memory.data.requestedSemiSpaceMiB !== this.nodeSemiSpaceMiB || memory.data.explicitCliSemiSpaceMiB !== this.nodeSemiSpaceMiB) throw new NativeRouteError("BROWSER_RUNTIME_UPDATE_REQUIRED", "The shared browser owner has not verified the requested Node startup policy. No browser action was started.", 503);
    }
    return value;
  }
  async openBrowser(_accountId?: string) {
    await this.connect();
    if (this.nodeSemiSpaceMiB !== null) await this.call("gemini_status", {});
    return this.call("gemini_open_browser", {});
  }
  async prepare(signal: AbortSignal) {
    await this.connect(); signal.throwIfAborted();
    await ensureNativeBrowserReady((name, args, bounded) => this.call(name, args, bounded), signal, 20000, this.expectedIdentityFingerprint);
  }
  async inspectIdentity(signal: AbortSignal) {
    await this.connect(); signal.throwIfAborted();
    return ensureNativeBrowserReady((name, args, bounded) => this.call(name, args, bounded), signal);
  }
  async inspectImportSurface(signal: AbortSignal) {
    await this.connect(); signal.throwIfAborted();
    if (!this.expectedIdentityFingerprint) throw new NativeRouteError("ACCOUNT_IDENTITY_UNVERIFIED", "A registered account is required for import inspection.", 412);
    const status = await this.call("gemini_status", {}, signal);
    if (status.chatImportSurfaceInspectionSupported !== true) throw new NativeRouteError("ACCOUNT_RUNTIME_STALE", "Update the browser worker before inspecting imports.", 412);
    return ChatImportSurfaceObservationSchema.parse(await this.call("gemini_inspect_import", { expected_account_fingerprint: this.expectedIdentityFingerprint }, signal));
  }
  async inspectReceipt(requestId:string,signal:AbortSignal) {
    await this.connect();signal.throwIfAborted();
    return this.call("gemini_receipt",{request_id:requestId},signal);
  }
  async releaseConversation(key: string, preserve = false) {
    await this.connect();
    await this.call("gemini_release_conversation", { key, preserve_tab: preserve }); this.retained.delete(key);
  }
  async generate(requestId: string, prompt: string, signal: AbortSignal, options?: NativeGenerationOptions): Promise<string> {
    const useSnapshot = options?.snapshotAttachment === true && prompt.length > MAX_WEB_MESSAGE_CHARS;
    const contextModel = options?.contextModelSelection;
    const messages = useSnapshot ? nativeSnapshotTransport(prompt, options?.responseNonce ?? "", options?.conversation?.revision ?? sha256(prompt), options?.conversation?.baseRevision, !!contextModel) : nativeBrowserTransport(prompt, options?.conversation?.revision ?? sha256(prompt), options?.conversation?.baseRevision, !!contextModel);
    let status: JsonObject;
    try {
      await this.connect();
      signal.throwIfAborted();
      status = await ensureNativeBrowserReady((name, args, bounded) => this.call(name, args, bounded), signal, 20000, this.expectedIdentityFingerprint);
      if (contextModel && (!this.expectedIdentityFingerprint || status.temporaryModelSelectionSupported !== true)) throw new NativeRouteError("BROWSER_RUNTIME_UPDATE_REQUIRED", "Context staging requires verified temporary model capture and restoration support.", 503);
      if(options?.receiptOwner&&status.physicalReceiptInspectionSupported!==true)throw new NativeRouteError("BROWSER_RUNTIME_UPDATE_REQUIRED","Refresh browser MCP for durable physical receipt correlation.",503);
      if(options?.parallelAccountRouting&&status.parallelAccountIsolationSupported!==true)throw new NativeRouteError("BROWSER_RUNTIME_UPDATE_REQUIRED","Refresh browser MCP for isolated account cleanup and readiness.",503);
      if (useSnapshot && (!this.expectedIdentityFingerprint || status.nativeSnapshotAttachmentSupported !== true)) throw new NativeRouteError("BROWSER_RUNTIME_UPDATE_REQUIRED", "Snapshot transport requires a verified account and updated browser MCP.", 503);
      if(useSnapshot&&status.nativeSnapshotFileRetentionSupported!==true)throw new NativeRouteError("BROWSER_RUNTIME_UPDATE_REQUIRED","Refresh browser MCP to keep snapshot files available through the complete browser turn.",503);
      if (this.expectedIdentityFingerprint !== undefined && status.accountIdentityVerificationSupported !== true) throw new NativeRouteError("BROWSER_RUNTIME_UPDATE_REQUIRED", "Refresh browser MCP for account identity verification at Send.", 503);
      if (options?.conversation?.resumeUrl && status.existingConversationSupported !== true) throw new NativeRouteError("BROWSER_RUNTIME_UPDATE_REQUIRED", "Refresh browser MCP before continuing an existing conversation. No new tab or prompt was created.", 503);
      if (typeof status.maxPromptChars !== "number" || status.maxPromptChars < Math.max(...messages.map(message => message.prompt.length)) || status.freshConversationSupported !== true) throw new NativeRouteError("BROWSER_RUNTIME_UPDATE_REQUIRED", "Refresh the browser MCP runtime to load native provider transport and fresh conversation support.", 503);
      if ((options || messages.length > 1) && (status.retainedConversationSupported !== true || status.progressStreamingSupported !== true || status.conversationUrlCheckpointSupported !== true)) throw new NativeRouteError("BROWSER_RUNTIME_UPDATE_REQUIRED", "Refresh the browser MCP runtime for retained conversations, checkpoints and progress.", 503);
      if (options?.modelSelection && status.modelSelectionSupported !== true) throw new NativeRouteError("BROWSER_RUNTIME_UPDATE_REQUIRED", "Refresh the browser MCP runtime for verified model selection.", 503);
      signal.throwIfAborted();
    } catch (cause) {
      const error = cause instanceof NativeRouteError ? cause : new NativeRouteError(signal.aborted ? "CANCELLED" : "BROWSER_UNAVAILABLE", signal.aborted ? "Native browser request cancelled before submission." : "Browser readiness failed before submission.", signal.aborted ? 499 : 503);
      error.phase = "checkpoint";
      error.delivery = "not_sent";
      if (options?.conversation?.baseRevision) error.recovery = { delivery: "not_sent", baseRevision: options.conversation.baseRevision };
      throw error;
    }
    const conversation = options?.conversation ?? (messages.length > 1 ? { key: "transport_" + sha256(requestId), revision: sha256(prompt) } : undefined);
    const ephemeral = !!conversation && !options?.conversation;
    options?.onTransportPlan?.(messages.length);
    // Cancellation targets the current fragment/commit, never a retired part.
    let activeRequestId: string | undefined;
    let cancellation: Promise<unknown> | undefined;
    const cancel = () => {
      if (!activeRequestId) { options?.onCancellationResult?.({ confirmed: true }); return; }
      cancellation ??= this.call("gemini_cancel", { request_id: activeRequestId }).then(result => {
        options?.onCancellationResult?.({ confirmed: result.cancelled === true, ...(typeof result.reason === "string" ? { reason: result.reason } : {}) });
        return result;
      }).catch(() => {
        options?.onCancellationResult?.({ confirmed: false });
        return undefined;
      });
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      if (conversation) this.retained.add(conversation.key);
      let progressRevision = 0, acceptedFragments = 0;
      let primaryModel = options?.modelSelection;
      for (let index = 0; index < messages.length; index++) {
        signal.throwIfAborted();
        const message = messages[index], transportStarted = performance.now();
        const temporaryModel = !!contextModel && !!message.acknowledgement;
        const messageModel = temporaryModel ? contextModel : primaryModel;
        const traceBase = { messageIndex: index + 1, messageCount: messages.length, kind: message.snapshotAttachment ? "attachment" : messages.length === 1 ? "text" : message.acknowledgement ? "fragment" : "commit", promptChars: message.prompt.length, promptBytes: Buffer.byteLength(message.prompt, "utf8"), promptSha256: sha256(message.prompt), ...(message.snapshotAttachment ? { attachment: { chars: message.snapshotAttachment.content.length, utf8Bytes: Buffer.byteLength(message.snapshotAttachment.content, "utf8"), sha256: message.snapshotAttachment.sha256 } } : {}) };
        const trace = (stage: "prepared" | "completed" | "failed", detail: Record<string, unknown> = {}) => {
          const parsed = NativeTransportTraceSchema.safeParse({ ...traceBase, ...(messageModel ? { modelSelection: messageModel } : {}), stage, elapsedMs: Math.round(performance.now() - transportStarted), ...detail });
          if (parsed.success) options?.onTransportTrace?.(parsed.data);
        };
        trace("prepared");
        try {
        activeRequestId = messages.length === 1 ? requestId : "native_" + sha256(requestId + ":fragment:" + index);
        try { options?.onPhysicalSubmission?.(activeRequestId); options?.onSubmissionStarted?.(); }
        catch(cause) {
          const error=cause instanceof NativeRouteError?cause:new NativeRouteError("REQUEST_LEDGER_UNAVAILABLE","Physical request mapping could not be persisted; no new prompt was sent.",503);
          error.phase="checkpoint";error.delivery=acceptedFragments?"unknown":"not_sent";throw error;
        }
        await this.call("gemini_submit", { request_id: activeRequestId, prompt: message.prompt, snapshot_attachment: message.snapshotAttachment, native_owner:options?.receiptOwner,
          ...(conversation ? { conversation: { key: conversation.key, revision: message.revision, base_revision: message.baseRevision, resume_url: index === 0 ? options?.conversation?.resumeUrl : undefined } } : { fresh_conversation: true }),
          expected_account_fingerprint: this.expectedIdentityFingerprint, model_selection: messageModel, ...(temporaryModel ? { temporary_model_selection: true, return_model_selection: primaryModel } : {}), stall_timeout_ms: options?.stallTimeoutMs, max_duration_ms: options?.maxDurationMs,
        }, signal);
        let revision = 0;
        while (!signal.aborted) {
          const response = await this.call("gemini_result", { request_id: activeRequestId, wait_ms: 1000, after_revision: revision }, signal);
          if (object(response.progress) && typeof response.progress.revision === "number" && response.progress.revision > revision && typeof response.progress.text === "string") {
            revision = response.progress.revision;
            options?.onProgress?.({ revision: ++progressRevision, text: message.acknowledgement ? "" : response.progress.text, codeBlocks: !message.acknowledgement && Array.isArray(response.progress.codeBlocks) && response.progress.codeBlocks.every(x => typeof x === "string") ? response.progress.codeBlocks as string[] : undefined, stage: message.acknowledgement ? "context_delivery" : typeof response.progress.stage === "string" ? response.progress.stage : undefined });
          }
          if (response.status === "completed" && typeof response.text === "string") {
            if (messageModel && (!object(response.verifiedModel) || response.verifiedModel.model !== messageModel.model || response.verifiedModel.effort !== messageModel.effort)) throw new NativeRouteError("MODEL_UNAVAILABLE", "Browser response was not bound to the requested Web model/effort.", 502);
            if (temporaryModel) {
              const restored = WebModelSelectionSchema.safeParse(response.restoredModel);
              if (!restored.success || primaryModel && (primaryModel.model !== restored.data.model || primaryModel.effort !== restored.data.effort)) throw new NativeRouteError("MODEL_RESTORE_PENDING", "The primary model was not positively restored after context staging.", 502);
              primaryModel = restored.data;
            }
            activeRequestId = undefined;
            const submission = BrowserSubmissionDiagnosticSchema.safeParse(response.submissionDiagnostic);
            const observed = message.acknowledgement && Array.isArray(response.codeBlocks) && response.codeBlocks.length === 1 && typeof response.codeBlocks[0] === "string" ? response.codeBlocks[0] : response.text;
            trace("completed", { responseChars: observed.length, responseSha256: sha256(observed), responseCategory: transportReplyCategory(observed, message.acknowledgement), ...(message.acknowledgement ? { ackMatches: observed.trim() === message.acknowledgement } : {}), ...(temporaryModel ? { restoredModel: primaryModel } : {}), ...(submission.success ? { submission: submission.data } : {}) });
            if (message.acknowledgement) {
              const reply = Array.isArray(response.codeBlocks) && response.codeBlocks.length === 1 && typeof response.codeBlocks[0] === "string" ? response.codeBlocks[0] : response.text;
              if (reply.trim() !== message.acknowledgement) {
                const error = new NativeRouteError("CONTEXT_FRAGMENT_ACK_FAILED", "Gemini did not acknowledge the exact context fragment. No intermediate tool request was forwarded.", 502);
                error.phase = "response"; error.delivery = "unknown"; throw error;
              }
              acceptedFragments++;
              options?.onProgress?.({ revision: ++progressRevision, text: "", stage: "context_delivery" });
              break;
            }
            if (options?.conversation && typeof response.conversationUrl === "string" && /^https:\/\/gemini\.google\.com\/app\/[a-zA-Z0-9_-]{1,128}$/.test(response.conversationUrl)) options.onConversationCheckpoint?.(response.conversationUrl);
            return selectNativeBrowserReply(response.text, response.codeBlocks);
          }
          if (response.status !== "pending") {
            const diagnostic = BrowserSubmissionDiagnosticSchema.safeParse(response.submissionDiagnostic);
            trace("failed", { ...(diagnostic.success ? { submission: diagnostic.data } : {}) });
            const selection = ModelSelectionDiagnosticSchema.safeParse(object(response.error) ? response.error.modelSelection : undefined);
            // Classify the browser failure with specific error codes when the broker provides them.
            // Fall back to generic codes only when no structured cause is available.
            const brokerCode = object(response.error) && typeof response.error.code === "string" ? response.error.code : undefined;
            const classifiedCode = brokerCode
              ?? (response.status === "cancelled" ? "CANCELLED" : "BROWSER_TURN_FAILED");
            const error = new NativeRouteError(classifiedCode, "Gemini Web did not complete the native request. No model fallback or automatic resend.", response.status === "cancelled" ? 499 : 502, selection.success ? selection.data : undefined);
            // Attach structural diagnostic when the broker supplies one, without prompt/credential content.
            if (object(response.error) && typeof response.error.detail === "string" && response.error.detail.length <= 512) {
              error.diagnostic = { brokerDetail: response.error.detail };
            }
            if (["checkpoint", "model_selection", "submission", "response"].includes(String(response.phase))) error.phase = response.phase as NativeRouteError["phase"];
            if (acceptedFragments) error.delivery = "unknown";
            else if (["not_sent", "accepted", "unknown"].includes(String(response.delivery))) error.delivery = response.delivery as NativeRouteError["delivery"];
            if (!acceptedFragments && object(response.recovery) && response.recovery.delivery === "not_sent" && typeof response.recovery.baseRevision === "string" && response.recovery.baseRevision === options?.conversation?.baseRevision) error.recovery = { delivery: "not_sent", baseRevision: response.recovery.baseRevision };
            throw error;
          }
        }
        } catch (error) {
          trace("failed", { code: error instanceof NativeRouteError ? error.code : signal.aborted ? "CANCELLED" : "BROWSER_PROTOCOL_ERROR" });
          throw error;
        }
      }
      signal.throwIfAborted();
      throw new NativeRouteError("CANCELLED", "Native request cancelled.", 499);
    } finally {
      signal.removeEventListener("abort", cancel); if (cancellation) await cancellation;
      if (ephemeral && conversation) await this.releaseConversation(conversation.key, true).catch(() => {});
    }
  }
  async close() {
    if (this.connection) for (const key of this.retained) await this.releaseConversation(key, true).catch(() => {});
    await this.client.close();
  }
}
