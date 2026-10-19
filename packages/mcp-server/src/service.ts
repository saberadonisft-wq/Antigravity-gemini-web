import { BridgeError } from "./bridge-error.js";
export { BridgeError } from "./bridge-error.js";
import { PhysicalReceiptStore, RequestId, type PhysicalReceipt as Receipt } from "./receipt-store.js";
export { RequestId } from "./receipt-store.js";
import { createHash, randomUUID } from "node:crypto";
import { validateNativeSnapshot, assertBrowserAccountIdentity } from "@antigravity-gemini-web/gemini-browser";
import { ModelRestoreJournal, WebModelSelection, type ModelRestoreRecord } from "./model-restore.js";
import { NativeReceiptOwnerSchema, ChatImportSurfaceObservationSchema, type NativeReceiptOwner, type NativeSnapshotAttachment } from "@antigravity-gemini-web/contracts";
import type { GeminiBrowserAdapter, PromptTurnResponse, BrowserProgress, BrowserConversationLease, BrowserModelSelection } from "@antigravity-gemini-web/gemini-browser";
import { z } from "zod";
import { ModelSelectionDiagnosticSchema, BrowserSubmissionDiagnosticSchema, type BrowserSubmissionDiagnostic } from "@antigravity-gemini-web/contracts";
import type { McpNodeSemiSpace } from "@antigravity-gemini-web/contracts";
import { describeNodeMemoryPolicy } from "./node-memory.js";

// Single Web messages must fit the verified 32k editor cap, including framing.
export const MAX_BROWSER_PROMPT_CHARS = 28000;
const MAX_CACHED_RESULTS = 32;
const RESULT_TTL_MS = 10 * 60 * 1000;
export interface BrowserSubmitOptions {
  nativeOwner?: NativeReceiptOwner;
  snapshotAttachment?: NativeSnapshotAttachment;
  freshConversation?: boolean;
  conversation?: { key: string; revision: string; baseRevision?: string; resumeUrl?: string };
  modelSelection?: BrowserModelSelection;
  temporaryModelSelection?: boolean;
  returnModelSelection?: BrowserModelSelection;
  expectedAccountFingerprint?: string;
  stallTimeoutMs?: number;
  maxDurationMs?: number;
}
type Turn = Receipt & { submissionDiagnostic?: BrowserSubmissionDiagnostic; turnId: string; done: Promise<void>; response?: PromptTurnResponse; settled: boolean; started: boolean; cancelRequested: boolean; interrupt?: (response: PromptTurnResponse) => void; progress?: BrowserProgress; lastProgressAt: number; changed: Set<() => void>; verifiedModel?: BrowserModelSelection; reused?: boolean; conversationKey?: string; browserPhase?: "checkpoint" | "model_selection" | "submission" | "response"; recovery?: { delivery: "not_sent"; baseRevision: string } };
type Retained = { lease?: BrowserConversationLease; revision?: string };
// A single process owns mutations on the shared browser. No prompt, result or credential is persisted.
export class GeminiMcpService {
  private turns = new Map<string, Turn>();
  private receipts: PhysicalReceiptStore;
  private modelRestore: ModelRestoreJournal;
  private restoredModels = new WeakMap<Turn, BrowserModelSelection>();
  private busy?: string;
  private stopped = false;
  private faulted = false;
  private closing?: Promise<void>;
  private cancelPending?: Promise<unknown>;
  private openingBrowser = false;
  private inspectingImport = false;
  private epoch = randomUUID();
  private conversations = new Map<string, Retained>();
  private settledAt = new WeakMap<Turn, number>();
  private pruneResults() {
    for (const [id, turn] of this.turns) {
      if (turn.settled && !turn.changed.size && (this.turns.size > MAX_CACHED_RESULTS || Date.now() - this.settledAt.get(turn)! >= RESULT_TTL_MS)) this.turns.delete(id);
    }
  }
  constructor(public readonly browser: GeminiBrowserAdapter, ledgerFile: string, private readonly nodeSemiSpaceMiB: McpNodeSemiSpace = null) {
    this.receipts = new PhysicalReceiptStore(ledgerFile);
    this.modelRestore = new ModelRestoreJournal(ledgerFile + ".model-restore.json");
  }
  private available() {
    if (this.stopped || this.faulted) throw new BridgeError("SERVICE_UNAVAILABLE", "Bridge is closed or persistence failed; no new browser actions are allowed.");
  }
  private persistPhase(receipt: Receipt, phase: "accepted" | "terminal") {
    try { this.receipts.transition(receipt, phase); }
    catch(error) { this.faulted = true; throw error; }
  }
  async status() {
    this.available();
    this.pruneResults();
    const status = await this.browser.checkStatus();
    return {
      browserState: status.browserState, accountState: status.accountState,
      nodeMemory: describeNodeMemoryPolicy(this.nodeSemiSpaceMiB),
      browserActionRequired:status.error?.code === "BROWSER_USER_ACTION_REQUIRED" && status.error.detail === "google_traffic_verification" ? "google_traffic_verification" : undefined,
      accountIdentity: status.accountIdentity,
      activeRequestId: this.busy ?? null, transport: "stdio", route: "mcp_browser_tool",
      browserOperationActive:this.openingBrowser || this.inspectingImport || !!this.cancelPending || !!this.modelRestore.pending(),parallelAccountIsolationSupported:true,
      chatImportSurfaceInspectionSupported:typeof this.browser.inspectImportSurface === "function",
      modelRestorePending:!!this.modelRestore.pending(),temporaryModelSelectionSupported:typeof this.browser.captureModelSelection === "function" && typeof this.browser.selectModel === "function",
      nativeInference: "unverified", reverseHostTools: "not_connected", checkedAt: status.checkedAt,
      maxPromptChars: MAX_BROWSER_PROMPT_CHARS, freshConversationSupported: typeof this.browser.openFreshConversation === "function",
      retainedConversationSupported: this.browser.supportsRetainedConversations === true,
      progressStreamingSupported: this.browser.supportsProgressStreaming === true,
      accountIdentityVerificationSupported: this.browser.supportsAccountIdentityVerification === true,
      nativeSnapshotAttachmentSupported: this.browser.supportsNativeSnapshotAttachment === true,
      nativeSnapshotFileRetentionSupported:this.browser.supportsNativeSnapshotFileRetention===true,
      physicalReceiptInspectionSupported:true,
      modelSelectionSupported: typeof this.browser.selectModel === "function",
      failedConversationPreservationSupported: true,
      existingConversationSupported: typeof this.browser.openExistingConversation === "function",
      conversationUrlCheckpointSupported: this.browser.supportsConversationUrlCheckpoint === true,
      retainedConversations: this.conversations.size,
      cachedResults: this.turns.size, requestIdentities: this.receipts.count(), maxRequestIdentities: null, receiptStore: "sqlite_wal_v2",
    };
  }
  async inspectImportSurface(expectedFingerprint: string) {
    this.available(); z.string().regex(/^[a-f0-9]{64}$/).parse(expectedFingerprint);
    if (this.busy || this.cancelPending || this.openingBrowser || this.inspectingImport || this.modelRestore.pending()) throw new BridgeError("BUSY", "Import inspection requires an idle browser.");
    if (!this.browser.inspectImportSurface) throw new BridgeError("UNSUPPORTED_OPERATION", "This browser cannot inspect an existing import surface.");
    this.inspectingImport = true;
    try { const result = await this.browser.inspectImportSurface(expectedFingerprint); this.available(); return ChatImportSurfaceObservationSchema.parse(result); }
    finally { this.inspectingImport = false; }
  }
  async openBrowser() {
    this.available();
    if (this.busy || this.cancelPending || this.openingBrowser || this.inspectingImport) throw new BridgeError("BUSY", "Another browser operation is active.");
    this.openingBrowser = true;
    try {
      const result = await this.browser.openBrowser();
      this.available();
      if (!result.opened) throw new BridgeError("BROWSER_UNAVAILABLE", "Could not open the isolated browser. Check Chrome path and profile ownership.");
      const pending = this.modelRestore.pending();
      if (pending) {
        if (!this.browser.openFreshConversation || !this.browser.selectModel) throw new BridgeError("MODEL_RESTORE_PENDING", "The saved primary model requires an updated browser runtime.");
        assertBrowserAccountIdentity((await this.browser.checkStatus()).accountIdentity, pending.fingerprint);
        this.available();
        const lease = await this.browser.openFreshConversation();
        try {
          this.available();
          const restored = await this.browser.selectModel(pending.primary);
          this.available();
          if (restored.model !== pending.primary.model || restored.effort !== pending.primary.effort) throw new BridgeError("MODEL_RESTORE_PENDING", "The saved primary model could not be verified.");
          await lease.close();
          this.modelRestore.finish(pending);
        } catch (error) { await lease.close().catch(() => { this.faulted = true; }); throw error; }
      }
      return { opened: true, ...await this.status(), browserOperationActive:!!this.cancelPending || !!this.modelRestore.pending() };
    } finally { this.openingBrowser = false; }
  }
  async submit(requestId: string, prompt: string, options?: BrowserSubmitOptions) {
    this.available();
    if (options?.temporaryModelSelection && (!options.modelSelection || !this.browser.captureModelSelection || !this.browser.selectModel || !options.conversation || !/^[a-f0-9]{64}$/.test(options.expectedAccountFingerprint ?? ""))) throw new BridgeError("UNSUPPORTED_OPERATION", "Temporary context models require capture/restore support, a pinned account and a retained conversation.");
    if (options?.returnModelSelection && (!options.temporaryModelSelection || !WebModelSelection.safeParse(options.returnModelSelection).success)) throw new BridgeError("INVALID_MODEL_SELECTION", "Return model selection is only valid for a temporary context model.");
    RequestId.parse(requestId);
    z.string().min(1).max(MAX_BROWSER_PROMPT_CHARS).parse(prompt);
    if(options?.nativeOwner)options={...options,nativeOwner:NativeReceiptOwnerSchema.parse(options.nativeOwner)};
    if (options?.snapshotAttachment) {
      options = { ...options, snapshotAttachment: validateNativeSnapshot(options.snapshotAttachment) };
      if (!this.browser.supportsNativeSnapshotAttachment || !this.browser.supportsNativeSnapshotFileRetention || !(options.freshConversation || options.conversation) || !/^[a-f0-9]{64}$/.test(options.expectedAccountFingerprint ?? "")) throw new BridgeError("UNSUPPORTED_OPERATION", "Snapshot transport requires a verified account, an isolated conversation and retained file lifetime support.");
    }
    const advanced = options?.nativeOwner || options?.snapshotAttachment || options?.expectedAccountFingerprint || options?.conversation || options?.modelSelection || options?.stallTimeoutMs || options?.maxDurationMs;
    const hash = createHash("sha256").update(advanced ? JSON.stringify({ prompt, options }) : options?.freshConversation ? "fresh-conversation\n" + prompt : prompt).digest("hex");
    const existing = this.receipts.get(requestId);
    this.pruneResults();
    if (existing) {
      if (existing.hash !== hash) throw new BridgeError("CONFIG_CONFLICT", "Request ID is already bound to different content.");
      if (!this.turns.has(requestId)) throw new BridgeError("OUTCOME_UNKNOWN", "Cached result expired or belongs to an earlier process. Inspect Gemini history; it will not be replayed.");
      return this.result(requestId, 0);
    }
    if (this.busy || this.cancelPending || this.openingBrowser || this.inspectingImport) throw new BridgeError("BUSY", "Another request owns the browser. Fetch its result or cancel it first.");
    if (this.modelRestore.pending()) throw new BridgeError("MODEL_RESTORE_PENDING", "Restore the saved primary model by opening the browser before submitting another prompt.");
    const binding = options?.conversation;
    for (const budget of [options?.stallTimeoutMs, options?.maxDurationMs]) if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 1 || budget > 1800000)) throw new BridgeError("INVALID_DEADLINE", "Browser progress budget is invalid.");
    let retained: Retained | undefined;
    if (binding) {
      RequestId.parse(binding.key); z.string().regex(/^[a-f0-9]{64}$/).parse(binding.revision);
      if (binding.baseRevision) z.string().regex(/^[a-f0-9]{64}$/).parse(binding.baseRevision);
      if (binding.resumeUrl) {
        if (!/^https:\/\/gemini\.google\.com\/app\/[a-zA-Z0-9_-]{1,128}$/.test(binding.resumeUrl) || binding.baseRevision) throw new BridgeError("INVALID_RESUME", "An existing conversation requires an exact Gemini URL and a full context rebind, not a delta.");
        if (!this.browser.openExistingConversation) throw new BridgeError("UNSUPPORTED_OPERATION", "Existing conversation attachment requires the updated browser runtime.");
      }
      if (options?.freshConversation || !this.browser.supportsRetainedConversations) throw new BridgeError("UNSUPPORTED_OPERATION", "Retained conversations require the updated browser driver.");
      retained = this.conversations.get(binding.key);
      if (binding.baseRevision ? retained?.revision !== binding.baseRevision : retained !== undefined) throw new BridgeError("CONVERSATION_CHANGED", "The exact retained context revision is unavailable; no delta was sent.");
      if (!retained) {
        if (this.conversations.size >= 5) throw new BridgeError("QUEUE_FULL", "Retained browser conversation capacity reached.");
        retained = {};
      }
    }
    // Reserve synchronously and durably before any await or DOM action.
    let receipt: Receipt;
    try { receipt = this.receipts.reserve(requestId, hash, options?.nativeOwner); }
    catch(error) { if (error instanceof BridgeError && error.code === "LEDGER_UNAVAILABLE") this.faulted = true; throw error; }
    if (binding && retained) this.conversations.set(binding.key, retained);
    this.busy = requestId;
    const turn: Turn = { ...receipt, turnId: `mcp-${this.epoch}-${requestId}`, conversationKey: binding?.key, done: Promise.resolve(), settled: false, started: false, cancelRequested: false, lastProgressAt: performance.now(), changed: new Set() };
    this.turns.set(requestId, turn);
    turn.done = Promise.resolve().then(async () => {
      let fresh: BrowserConversationLease | undefined;
      let isolatedClosed = false;
      let baseRetained = false;
      let temporaryModel: ModelRestoreRecord | undefined;
      const restoreTemporaryModel = async () => {
        if (!temporaryModel) return;
        assertBrowserAccountIdentity((await this.browser.checkStatus()).accountIdentity, temporaryModel.fingerprint);
        const restored = await this.browser.selectModel!(temporaryModel.primary);
        if (restored.model !== temporaryModel.primary.model || restored.effort !== temporaryModel.primary.effort) throw new BridgeError("MODEL_RESTORE_PENDING", "The primary model was not restored exactly.");
        this.modelRestore.finish(temporaryModel);
        this.restoredModels.set(turn, restored);
        temporaryModel = undefined;
      };
      const interrupted = new Promise<PromptTurnResponse>(resolve => { turn.interrupt = resolve; });
      try {
        this.available();
        turn.browserPhase = "checkpoint";
        if (retained) {
          if (binding?.baseRevision) {
            if (!retained.lease?.resume) throw new BridgeError("CONVERSATION_CHANGED", "Retained browser target is unavailable.");
            await retained.lease.resume(); turn.reused = true;
          } else {
            retained.lease = binding?.resumeUrl ? await this.browser.openExistingConversation!(binding.resumeUrl) : await this.browser.openFreshConversation!();
            if (!retained.lease.suspend || !retained.lease.resume) throw new BridgeError("UNSUPPORTED_OPERATION", "The browser lease cannot retain its exact target.");
            turn.reused = !!binding?.resumeUrl;
          }
        } else if (options?.freshConversation) {
          if (!this.browser.openFreshConversation) throw new BridgeError("UNSUPPORTED_OPERATION", "Browser adapter cannot isolate a native conversation.");
          fresh = await this.browser.openFreshConversation();
        }
        if (turn.cancelRequested) throw new BridgeError("CANCELLED", "Cancelled before browser submission.");
        if (options?.modelSelection) {
          turn.browserPhase = "model_selection";
          if (!this.browser.selectModel) throw new BridgeError("UNSUPPORTED_OPERATION", "Web model selection is unavailable.");
          if (options.temporaryModelSelection) {
            assertBrowserAccountIdentity((await this.browser.checkStatus()).accountIdentity, options.expectedAccountFingerprint!);
            const primary = WebModelSelection.parse(options.returnModelSelection ?? await this.browser.captureModelSelection!());
            if (options.returnModelSelection) {
              const verified = await this.browser.selectModel(primary);
              if (verified.model !== primary.model || verified.effort !== primary.effort) throw new BridgeError("MODEL_UNAVAILABLE", "The primary Web model/effort could not be verified before context staging.");
            }
            temporaryModel = this.modelRestore.begin(primary, options.expectedAccountFingerprint!);
          }
          turn.verifiedModel = await this.browser.selectModel(options.modelSelection);
          if (turn.verifiedModel.model !== options.modelSelection.model || turn.verifiedModel.effort !== options.modelSelection.effort) throw new BridgeError("MODEL_UNAVAILABLE", "The Web driver did not verify the exact requested model/effort.");
        }
        if (turn.cancelRequested) throw new BridgeError("CANCELLED", "Cancelled before browser submission.");
        turn.started = true;
        turn.browserPhase = "submission";
        const maximum = options?.maxDurationMs ?? 120000;
        const submission = await this.browser.submitPrompt(turn.turnId, prompt, { timeoutMs: maximum, snapshotAttachment: options?.snapshotAttachment, expectedAccountFingerprint: options?.expectedAccountFingerprint, ...(options?.modelSelection ? { modelSelection: options.modelSelection } : {}) });
        const diagnostic = BrowserSubmissionDiagnosticSchema.safeParse(submission.submissionDiagnostic);
        if (diagnostic.success) turn.submissionDiagnostic = diagnostic.data;
        this.persistPhase(receipt, "accepted");
        turn.browserPhase = "response";
        const response = await Promise.race([interrupted, this.browser.pollResponse(turn.turnId, { deadlineMs: maximum, stallTimeoutMs: options?.stallTimeoutMs ?? maximum, onProgress: progress => {
          if (turn.settled || turn.response) return;
          if (progress.text.length > 131072 || (progress.codeBlocks ?? []).reduce((sum, code) => sum + code.length, 0) > 131072) throw new BridgeError("RESULT_TOO_LARGE", "Browser progress exceeds its output limit.");
          turn.lastProgressAt = performance.now(); turn.progress = { ...structuredClone(progress), revision: (turn.progress?.revision ?? 0) + 1 };
          for (const changed of turn.changed) changed();
        } })]);
        await restoreTemporaryModel();
        if (retained && response.status === "completed") { await retained.lease!.suspend!(); retained.revision = binding!.revision; }
        if (!turn.response) turn.response = response;
      } catch (error) {
        const diagnostic = BrowserSubmissionDiagnosticSchema.safeParse(error && typeof error === "object" && "submissionDiagnostic" in error ? error.submissionDiagnostic : undefined);
        if (diagnostic.success) turn.submissionDiagnostic = diagnostic.data;
        if (turn.browserPhase === "submission" && error && typeof error === "object" && "delivery" in error && error.delivery === "not_sent") turn.started = false;
        const selection = ModelSelectionDiagnosticSchema.safeParse(error && typeof error === "object" && "modelSelection" in error ? error.modelSelection : undefined);
        if (!turn.response) turn.response = {
          turnId: turn.turnId, status: error instanceof BridgeError && error.code === "CANCELLED" ? "cancelled" : "failed", text: "", completedAt: new Date().toISOString(),
          error: { code: error instanceof BridgeError ? error.code : error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "BROWSER_TURN_FAILED", message: "Browser request did not complete. Do not resend automatically; inspect the browser.", retryable: false, ...(selection.success ? { modelSelection: selection.data } : {}) },
        };
      } finally {
        if (temporaryModel) {
          try { await restoreTemporaryModel(); }
          catch { if (turn.response?.status === "completed") turn.response = { turnId: turn.turnId, status: "failed", text: "", completedAt: new Date().toISOString(), error: { code: "MODEL_RESTORE_PENDING", message: "Primary model restoration is pending; no new prompt is allowed.", retryable: false } }; }
        }
        if (retained && turn.response?.status !== "completed") {
          // Only a verified, unchanged checkpoint permits keeping the old base.
          // Once submitPrompt was entered, even missing DOM ack is uncertain.
          if (!options?.snapshotAttachment && !turn.started && binding?.baseRevision && retained.lease?.resume && retained.lease.suspend && !this.faulted) {
            try {
              await retained.lease.resume(); await retained.lease.suspend();
              baseRetained = true; turn.recovery = { delivery: "not_sent", baseRevision: binding.baseRevision };
            } catch { /* No checkpoint proof: retire the lease instead. */ }
          }
          if (!baseRetained) {
            try { if (retained.lease) { await this.retireLease(retained.lease, true); isolatedClosed = true; } } catch { this.faulted = true; }
            this.conversations.delete(binding!.key);
          }
        }
        if (fresh) try { await fresh.close(); isolatedClosed = true; } catch { this.faulted = true; }
        if (this.faulted && turn.response?.status === "completed") turn.response = { turnId: turn.turnId, status: "failed", text: "", completedAt: new Date().toISOString(), error: { code: "SERVICE_UNAVAILABLE", message: "Browser cleanup could not be confirmed.", retryable: false } };
        try { this.persistPhase(receipt, "terminal"); }
        catch { if (turn.response?.status === "completed") turn.response = { turnId: turn.turnId, status: "failed", text: "", completedAt: new Date().toISOString(), error: { code: "LEDGER_UNAVAILABLE", message: "Terminal receipt could not be saved; do not replay.", retryable: false } }; }
        turn.settled = true;
        this.settledAt.set(turn, Date.now());
        for (const changed of turn.changed) changed(); turn.changed.clear();
        // Failed or uncertain generations keep ownership until bridge cleanup.
        if (!this.faulted && (!turn.started || isolatedClosed || turn.response?.status === "completed" || turn.response?.status === "cancelled")) this.busy = undefined;
        this.pruneResults();
      }
    });
    return { requestId, status: "pending" as const, acceptedBy: "mcp_bridge", browserAcceptance: "pending" };
  }
  async result(requestId: string, waitMs = 0, afterRevision?: number) {
    this.pruneResults();
    const turn = this.turns.get(requestId);
    if (!turn) throw new BridgeError(this.receipts.get(requestId) ? "OUTCOME_UNKNOWN" : "REQUEST_NOT_FOUND", "No in-memory result exists for this request; it will not be replayed.");
    if (waitMs > 0 && !turn.settled && (afterRevision === undefined || (turn.progress?.revision ?? 0) <= afterRevision)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let changed: (() => void) | undefined;
      try { await Promise.race([turn.done, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(20000, waitMs)); }), ...(afterRevision === undefined ? [] : [new Promise<void>(resolve => { changed = resolve; turn.changed.add(resolve); })])]); }
      finally { clearTimeout(timer); if (changed) turn.changed.delete(changed); }
    }
    if (!turn.response || !turn.settled) return { requestId, status: "pending" as const, progress: turn.progress ? { ...structuredClone(turn.progress), silentMs: performance.now() - turn.lastProgressAt } : undefined };
    const response = turn.response;
    const selection = ModelSelectionDiagnosticSchema.safeParse(response.error?.modelSelection);
    if (response.text.length > 131072) throw new BridgeError("RESULT_TOO_LARGE", "Result exceeds 128 KiB characters. Read it in the browser; no truncated answer is returned.");
    return { requestId, status: response.status, text: response.text, modelDetected: response.modelDetected, phase: turn.browserPhase,
      submissionDiagnostic: turn.submissionDiagnostic,
      delivery: !turn.started ? "not_sent" : turn.browserPhase === "response" ? "accepted" : "unknown", recovery: turn.recovery,
      conversationUrl: this.conversations.get(turn.conversationKey ?? "")?.lease?.conversationUrl,
      codeBlocks: response.codeBlocks, verifiedModel: turn.verifiedModel, restoredModel: this.restoredModels.get(turn), conversationReused: turn.reused,
      completedAt: response.completedAt, error: response.error ? { code: response.error.code, message: "Browser operation failed; inspect the browser before retrying.", ...(selection.success ? { modelSelection: selection.data } : {}) } : undefined };
  }
  async inspectReceipt(requestId:string) {
    this.available();RequestId.parse(requestId);
    this.pruneResults();
    const receipt=this.receipts.get(requestId);
    return {requestId,found:!!receipt,receipt,replayAllowed:false,resultAvailable:this.turns.get(requestId)?.settled===true};
  }
  private async retireLease(lease: BrowserConversationLease, preserve: boolean) {
    if (preserve && lease.preserve) {
      try { await lease.preserve(); return true; } catch { /* Unconfirmed Stop must still close the owned target. */ }
    }
    await lease.close(); return false;
  }
  async releaseConversation(key: string, preserve = false) {
    this.available(); RequestId.parse(key);
    const conversation = this.conversations.get(key);
    if (!conversation) return { released: false };
    if (this.busy || this.cancelPending || this.openingBrowser || this.inspectingImport) throw new BridgeError("BUSY", "Conversation release requires an idle browser.");
    const pending = Promise.resolve().then(async () => { const preserved = conversation.lease ? await this.retireLease(conversation.lease, preserve) : false; this.conversations.delete(key); return { released: true, preserved }; });
    this.cancelPending = pending;
    try { return await pending; } finally { if (this.cancelPending === pending) this.cancelPending = undefined; }
  }
  async cancel(requestId: string) {
    this.available();
    const turn = this.turns.get(requestId);
    if (!turn) throw new BridgeError("REQUEST_NOT_FOUND", "Request does not belong to this bridge process.");
    if (turn.response) return { requestId, cancelled: false, status: turn.response.status };
    turn.cancelRequested = true;
    if (!turn.started) return { requestId, cancelled: true, status: "cancelled_before_submission" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = Promise.race([this.browser.cancelPrompt(turn.turnId), new Promise<{ cancelled: false }>(resolve => { timer = setTimeout(() => resolve({ cancelled: false }), 8000); })]);
    this.cancelPending = pending;
    try {
      const response = await pending;
      turn.interrupt?.({ turnId: turn.turnId, status: response.cancelled ? "cancelled" : "failed", text: "", completedAt: new Date().toISOString(), ...(response.cancelled ? {} : { error: { code: "OUTCOME_UNKNOWN", message: "Stop was not confirmed; the owned target will be retired.", retryable: false } }) });
      return { requestId, cancelled: response.cancelled };
    } catch {
      turn.interrupt?.({ turnId: turn.turnId, status: "failed", text: "", completedAt: new Date().toISOString(), error: { code: "OUTCOME_UNKNOWN", message: "Browser Stop failed; the owned target will be retired.", retryable: false } });
      return { requestId, cancelled: false };
    } finally { clearTimeout(timer); if (this.cancelPending === pending) this.cancelPending = undefined; }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    for (const turn of this.turns.values()) if (!turn.settled) {
      turn.cancelRequested = true;
      turn.interrupt?.({ turnId: turn.turnId, status: "failed", text: "", completedAt: new Date().toISOString(), error: { code: "SERVICE_UNAVAILABLE", message: "Browser bridge is closing; no replay.", retryable: false } });
    }
    this.closing = (async () => {
      try {
        for (const value of this.conversations.values()) {
          if (value.revision && value.lease?.preserve) {
            try { await value.lease.preserve(); continue; } catch { /* Unsettled targets must be retired below. */ }
          }
          await value.lease?.close().catch(() => {});
        }
      } finally { this.conversations.clear(); try { await this.browser.cleanup(); } finally { this.receipts.close(); } }
    })();
    return this.closing;
  }
}
