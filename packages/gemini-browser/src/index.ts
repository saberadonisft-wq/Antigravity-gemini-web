import type { NativeSnapshotAttachment } from "@antigravity-gemini-web/contracts";
import { validateNativeSnapshot,SnapshotFileCleanupError,type NativeSnapshotFileLease } from "./snapshot-upload.js";
export { validateNativeSnapshot } from "./snapshot-upload.js";
import type { BrowserState, AccountState, UiError, BrowserSubmissionDiagnostic } from "@antigravity-gemini-web/contracts";
import { GeminiBrowserDriver, assertBrowserAccountIdentity, type BrowserDriverOptions } from "./gemini-browser-driver.js";
import { CdpClient, type CdpTarget } from "./cdp-client.js";
import { isAllowedSurfaceUrl } from "./gemini-selectors.js";
import { createHash } from "node:crypto";
import { inspectExistingImportSurface } from "./import-surface.js";
import type { ChatImportSurfaceObservation } from "@antigravity-gemini-web/contracts";
import type { BrowserConversationLease, BrowserModelSelection, BrowserPollOptions } from "./progress.js";
export * from "./progress.js";
export * from "./model-controls.js";

export * from "./cdp-client.js";
export * from "./gemini-selectors.js";
export * from "./gemini-browser-driver.js";
export * from "./fixture-server.js";

export interface BrowserStatus {
  browserState: BrowserState;
  accountState: AccountState;
  displayLabel?: string;
  accountIdentity?: string;
  checkedAt: string;
  actionReason?: string;
  error?: UiError;
}

export interface BrowserOpenResult {
  opened: boolean;
  actionReason?: string;
}

export interface PromptSubmissionReceipt {
  turnId: string;
  submittedAt: string;
  status: "accepted" | "rejected";
  deadlineMs?: number;
  submissionDiagnostic?: BrowserSubmissionDiagnostic;
}

export interface PromptTurnResponse {
  turnId: string;
  status: "completed" | "cancelled" | "failed";
  text: string;
  codeBlocks?: string[];
  modelDetected?: string;
  completedAt: string;
  error?: UiError;
  submissionDiagnostic?: BrowserSubmissionDiagnostic;
}

export interface TurnCancelResult {
  turnId: string;
  cancelled: boolean;
  reason?: string;
}

export interface BrowserPromptOptions {
  timeoutMs?: number; modelSelection?: BrowserModelSelection; expectedAccountFingerprint?: string;
  snapshotAttachment?: NativeSnapshotAttachment;
}

export interface GeminiBrowserAdapter {
  checkStatus(): Promise<BrowserStatus>;
  openBrowser(): Promise<BrowserOpenResult>;
  submitPrompt(turnId: string, text: string, options?: BrowserPromptOptions): Promise<PromptSubmissionReceipt>;
  pollResponse(turnId: string, options?: BrowserPollOptions): Promise<PromptTurnResponse>;
  cancelPrompt(turnId: string): Promise<TurnCancelResult>;
  cleanup(): Promise<void>;
  sendPrompt(text: string): Promise<string>;
  openFreshConversation?(): Promise<BrowserConversationLease>;
  openExistingConversation?(url: string): Promise<BrowserConversationLease>;
  selectModel?(selection: BrowserModelSelection): Promise<BrowserModelSelection>;
  captureModelSelection?(): Promise<BrowserModelSelection>;
  inspectImportSurface?(expectedFingerprint: string): Promise<ChatImportSurfaceObservation>;
  supportsRetainedConversations?: boolean;
  supportsProgressStreaming?: boolean;
  supportsAccountIdentityVerification?: boolean;
  supportsNativeSnapshotAttachment?: boolean;
  supportsNativeSnapshotFileRetention?:boolean;
  supportsConversationUrlCheckpoint?: boolean;
}

interface TurnRecord {
  snapshotFile?:NativeSnapshotFileLease;
  submissionDiagnostic: BrowserSubmissionDiagnostic;
  turnId: string;
  text: string;
  submissionHash: string;
  state: "reserved" | "in_progress" | "completed" | "failed" | "cancel_requested" | "cancelled";
  submittedAt: string;
  initialCount: number;
  initialResponseKey?: string;
  completedAt?: string;
  response?: PromptTurnResponse;
  error?: UiError;
  epoch: number;
  accepted: boolean;
  generationUnsettled: boolean;
  pollController?: AbortController;
  cancelRequested: boolean;
  submission?: Promise<PromptSubmissionReceipt>;
  polling?: Promise<PromptTurnResponse>;
  cancellation?: Promise<TurnCancelResult>;
  targetWs?: string;
}

export class LiveGeminiBrowserAdapter implements GeminiBrowserAdapter {
  public readonly driver: GeminiBrowserDriver;
  private activeTurns = new Map<string, TurnRecord>();
  private retiredTurns = new Map<string, string>();
  private epoch = 0;
  private cleanupRequired = false;
  private cleaning?: Promise<void>;
  private ownedTabClosers = new Set<() => Promise<void>>();
  private preserveOwnedBrowserProcessOnCleanup = false;
  private leasedTargets = new Set<string>();
  readonly supportsRetainedConversations = true;
  readonly supportsProgressStreaming = true;
  readonly supportsAccountIdentityVerification = true;
  readonly supportsNativeSnapshotAttachment = true;
  readonly supportsNativeSnapshotFileRetention = true;
  private leasedTargetWs = new Set<string>();
  readonly supportsConversationUrlCheckpoint = true;

  constructor(options: BrowserDriverOptions = {}) {
    this.driver = new GeminiBrowserDriver(options);
  }

  /** A native provider round owns a fresh tab; the previous tab/draft is never navigated or copied. */
  async selectModel(selection: BrowserModelSelection) { return this.driver.selectModel(selection); }
  async captureModelSelection() { return this.driver.captureModelSelection(); }

  async inspectImportSurface(expectedFingerprint: string) {
    const epoch = this.epoch;
    const check = () => {
      if (epoch !== this.epoch || this.cleanupRequired) throw Error("Browser lifecycle changed during import inspection.");
      if ([...this.activeTurns.values()].some(turn => turn.generationUnsettled || ["reserved", "in_progress", "cancel_requested"].includes(turn.state))) throw Error("Browser generation is active.");
    };
    return inspectExistingImportSurface(this.driver, expectedFingerprint, check);
  }

  async openFreshConversation(): Promise<BrowserConversationLease> { return this.openConversation(); }
  async openExistingConversation(url: string): Promise<BrowserConversationLease> {
    if (!this.driver.fixtureMode && !/^https:\/\/gemini\.google\.com\/app\/[a-zA-Z0-9_-]{1,128}$/.test(url)) throw Error("Use the exact Gemini conversation URL, without query or fragment.");
    if (!isAllowedSurfaceUrl(url, { fixtureMode: this.driver.fixtureMode, allowedOrigins: this.driver.allowedOrigins })) throw Error("Conversation origin is not allowed.");
    return this.openConversation(url);
  }
  private async openConversation(existingUrl?: string): Promise<BrowserConversationLease> {
    const status = await this.checkStatus();
    const original = this.driver.cdp;
    if (status.browserState !== "ready" || status.accountState !== "signed_in" || !original) throw new Error("Browser is not ready for an isolated native conversation.");
    if ([...this.activeTurns.values()].some(turn => turn.generationUnsettled || turn.state === "reserved" || turn.state === "in_progress" || turn.state === "cancel_requested")) throw new Error("Another browser turn is active.");
    const epoch = this.epoch;
    let created: { targetId: string };
    if (existingUrl) {
      const targets = await original.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>("Target.getTargets", {}, 5000);
      const matches = targets.targetInfos.filter(target => target.type === "page" && target.url === existingUrl);
      if (matches.length !== 1) {
        const error = new Error("Open exactly one tab with the selected conversation URL in the isolated browser.");
        (error as any).code = "CONVERSATION_NOT_OPEN";
        throw error;
      }
      created = { targetId: matches[0].targetId };
      if (this.leasedTargets.has(created.targetId)) {
        const error = new Error("This conversation already belongs to an active lease.");
        (error as any).code = "BUSY";
        throw error;
      }
    } else created = await original.send<{ targetId: string }>("Target.createTarget", { url: this.driver.fixtureMode ? this.driver.targetUrl : "https://gemini.google.com/app" }, 5000);
    if (!created.targetId) throw new Error("Fresh browser target was not acknowledged.");
    this.leasedTargets.add(created.targetId);
    let closed = false, signature: string | undefined, targetWs: string | undefined, conversationUrl = existingUrl;
    let closingOwned: Promise<void> | undefined;
    const snapshot = async () => {
      const dom = await this.driver.inspectDom(2500);
      if (!dom.isAllowedSurface || dom.accountState !== "signed_in" || dom.isGenerating || dom.composerChars) throw Error("Retained browser surface is busy or changed.");
      if (this.driver.fixtureMode) {
        if (!isAllowedSurfaceUrl(dom.url, { fixtureMode: true, allowedOrigins: this.driver.allowedOrigins })) throw Error("Retained fixture URL is outside its allowlist.");
        conversationUrl = undefined;
      } else {
        if (!/^https:\/\/gemini\.google\.com\/app\/[a-zA-Z0-9_-]{1,128}$/.test(dom.url)) throw Error("Retained browser URL is not a canonical Gemini conversation.");
        conversationUrl = dom.url;
      }
      return createHash("sha256").update(JSON.stringify([dom.url, dom.responseCount, dom.lastResponseText, dom.lastResponseCodeBlocks, dom.modelDetected])).digest("hex");
    };
    const assertLease = () => { if (closed || epoch !== this.epoch || this.cleanupRequired) throw Error("Browser conversation lease was invalidated."); };
    const restoreOriginalIfPresent = async () => {
      // Restoring the user's starting page is a courtesy, not part of the owned
      // answer's authority. The user may close it at any time. A failed attach
      // keeps the current connection intact and must never select another tab.
      const target = await CdpClient.findTarget(this.driver.debugPort, candidate => candidate.webSocketDebuggerUrl === original.wsUrl);
      if (target?.webSocketDebuggerUrl) await this.driver.attachToExistingWs(target.webSocketDebuggerUrl).catch(() => {});
    };
    const performOwnedClose = async () => {
      if (closed) return;
      if (existingUrl && [...this.activeTurns.values()].some(turn => turn.targetWs === targetWs && turn.generationUnsettled)) throw Error("Stop was not confirmed on the adopted tab; close it manually before reconnecting.");
      // An explicitly adopted existing tab is never destroyed by bridge cleanup.
      if (!existingUrl) await CdpClient.closeOwnedTarget(this.driver.debugPort, created.targetId);
      else if (this.driver.cdp && this.driver.cdp.wsUrl === targetWs) await this.driver.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false }, 2000).catch(() => {});
      closed = true; this.ownedTabClosers.delete(closeOwned); this.leasedTargets.delete(created.targetId);
      if (targetWs) this.leasedTargetWs.delete(targetWs);
      const connection = this.driver.cdp;
      if (connection && connection.wsUrl === targetWs) { connection.close(); this.driver.cdp = null; }
      await restoreOriginalIfPresent();
      for (const record of this.activeTurns.values()) if (targetWs && record.targetWs === targetWs) {
        if (!existingUrl) record.generationUnsettled = false;
        if(!record.generationUnsettled)await this.releaseSnapshotFile(record);
        if (!record.response) this.settle(record, { turnId: record.turnId, status: "failed", text: "", completedAt: new Date().toISOString(), error: { code: "SERVICE_UNAVAILABLE", message: "Owned conversation was retired.", retryable: false } });
      }
    };
    const closeOwned = () => closingOwned ??= performOwnedClose().catch(error => { closingOwned = undefined; throw error; });
    this.ownedTabClosers.add(closeOwned);
    const close = async () => { if (closed) return; assertLease(); await closeOwned(); };
    const suspend = async () => { assertLease(); signature = await snapshot(); await this.driver.cdp!.send("Emulation.setFocusEmulationEnabled", { enabled: false }, 2000); await restoreOriginalIfPresent(); };
    const preserve = async () => {
      assertLease();
      if ([...this.activeTurns.values()].some(turn => turn.targetWs === targetWs && (turn.generationUnsettled || turn.state === "reserved" || turn.state === "in_progress" || turn.state === "cancel_requested"))) throw Error("Cannot preserve an unsettled generation.");
      const target = await CdpClient.findTarget(this.driver.debugPort, candidate => candidate.id === created.targetId);
      if (!targetWs || target?.webSocketDebuggerUrl !== targetWs) throw Error("Owned target unavailable.");
      await this.driver.attachToExistingWs(targetWs);
      const dom = await this.driver.inspectDom(2500);
      if (!dom.isAllowedSurface || dom.isGenerating) throw Error("Cannot preserve a generating target.");
      await this.driver.cdp!.send("Emulation.setFocusEmulationEnabled", { enabled: false }, 2000);
      await restoreOriginalIfPresent();
      closed = true; signature = undefined; this.ownedTabClosers.delete(closeOwned); this.leasedTargets.delete(created.targetId);
      if (targetWs) this.leasedTargetWs.delete(targetWs);
      if (this.driver.isOwnedProcess) this.preserveOwnedBrowserProcessOnCleanup = true;
    };
    const resume = async () => {
      assertLease();
      if (!signature) throw Error("Retained conversation was never checkpointed.");
      const target = await CdpClient.findTarget(this.driver.debugPort, candidate => candidate.id === created.targetId);
      if (!target?.webSocketDebuggerUrl || target.webSocketDebuggerUrl !== targetWs) throw Error("The exact retained target no longer exists.");
      await this.driver.attachToExistingWs(target.webSocketDebuggerUrl);
      await this.driver.cdp!.send("Emulation.setFocusEmulationEnabled", { enabled: true }, 2000);
      if (await snapshot() !== signature) throw Error("Retained conversation was changed outside its owner.");
    };
    try {
      const deadline = performance.now() + 15000;
      let attached = false;
      while (performance.now() < deadline) {
        if (epoch !== this.epoch || this.cleanupRequired) throw new Error("Browser lifecycle changed.");
        if (!attached) {
          const target = await CdpClient.findTarget(this.driver.debugPort, candidate => candidate.id === created.targetId);
          if (target?.webSocketDebuggerUrl) {
            targetWs = target.webSocketDebuggerUrl; this.leasedTargetWs.add(targetWs); await this.driver.attachToExistingWs(target.webSocketDebuggerUrl);
            // Only this bridge-created tab gets focus emulation. The user can
            // stay in the IDE without popover blur closing model controls.
            await this.driver.cdp!.send("Emulation.setFocusEmulationEnabled", { enabled: true }, 2000); attached = true;
          }
        }
        if (attached) {
          const dom = await this.driver.inspectDom(2000).catch(() => undefined);
          if (existingUrl && dom && dom.url !== existingUrl) {
            const error = new Error("Existing conversation URL changed or redirected. It may not be accessible on this account.");
            (error as any).code = "CONVERSATION_CHANGED";
            throw error;
          }
          if (existingUrl && (dom?.isGenerating || dom?.composerChars)) {
            const error = new Error("Existing conversation is generating or has an unsent draft. Nothing was sent.");
            (error as any).code = "BUSY";
            throw error;
          }
          if (dom?.isAllowedSurface && dom.accountState === "signed_in" && dom.hasComposer && !dom.isGenerating && (existingUrl || dom.responseCount === 0)) return { close, suspend, resume, preserve, get conversationUrl() { return conversationUrl; } };
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error("Fresh native conversation did not become ready.");
    } catch (error) { await close().catch(() => { this.cleanupRequired = true; }); throw error; }
  }

  private assertCurrent(record: TurnRecord): void {
    if (record.epoch !== this.epoch || this.activeTurns.get(record.turnId) !== record || this.cleanupRequired || record.targetWs && record.targetWs !== this.driver.cdp?.wsUrl) {
      throw { code: "SERVICE_UNAVAILABLE", message: "Browser operation was invalidated by cleanup.", retryable: false } satisfies UiError;
    }
  }

  private settle(record: TurnRecord, response: PromptTurnResponse): PromptTurnResponse {
    if (!record.response) {
      record.pollController?.abort();
      record.response = { ...structuredClone(response), submissionDiagnostic: { ...record.submissionDiagnostic } };
      record.state = response.status;
      record.completedAt = response.completedAt;
      record.error = response.error;
    }
    // Callers cannot mutate the authoritative terminal cache.
    return structuredClone(record.response);
  }
  private async releaseSnapshotFile(record:TurnRecord){
    if(!record.snapshotFile||record.generationUnsettled)return;
    const lease=record.snapshotFile;
    try{await lease.dispose();if(record.snapshotFile===lease)record.snapshotFile=undefined;}
    catch{this.cleanupRequired=true;throw {code:"SNAPSHOT_CLEANUP_FAILED",message:"Private snapshot cleanup is incomplete; browser cleanup is required.",retryable:false};}
  }

  private terminalResponse(record: TurnRecord): PromptTurnResponse | undefined {
    return record.response ? structuredClone(record.response) : undefined;
  }

  private stopBeforeSend(record: TurnRecord): void {
    this.assertCurrent(record);
    if (record.cancelRequested) {
      this.settle(record, { turnId: record.turnId, status: "cancelled", text: "", completedAt: new Date().toISOString() });
      throw { code: "CANCELLED", message: "Prompt cancelled before Send.", retryable: false } satisfies UiError;
    }
  }

  async checkStatus(): Promise<BrowserStatus> {
    const checkedAt = new Date().toISOString();

    if (!this.driver.isConnected) {
      // Only attach if an existing Chrome CDP target matching allowed surface is running; never spawn!
      try {
        const target = await CdpClient.findTarget(this.driver.debugPort, (t: CdpTarget) => {
          if (t.type !== "page") return false;
          return isAllowedSurfaceUrl(t.url, { fixtureMode: this.driver.fixtureMode, allowedOrigins: this.driver.allowedOrigins });
        });

        if (target?.webSocketDebuggerUrl) {
          await this.driver.attachToExistingWs(target.webSocketDebuggerUrl);
        } else {
          return {
            browserState: "closed",
            accountState: "unknown",
            actionReason: "Live browser driver is not connected. Requires active Chrome CDP session on allowed surface.",
            checkedAt,
          };
        }
      } catch {
        return {
          browserState: "closed",
          accountState: "unknown",
          actionReason: "Live browser driver is not connected. Requires active Chrome CDP session on allowed surface.",
          checkedAt,
        };
      }
    }

    try {
      let dom = await this.driver.inspectDom();

      // If document is still on about:blank right after launch, wait briefly for navigation to commit
      if (!dom.isAllowedSurface && dom.url === "about:blank") {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
          try {
            const interim = await this.driver.inspectDom();
            if (interim.url !== "about:blank") {
              dom = interim;
              break;
            }
          } catch {}
        }
      }

      // If allowed surface was just loaded, allow a brief grace period for DOM elements to mount
      if (dom.isAllowedSurface && dom.accountState === "unknown" && !dom.hasComposer) {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
          try {
            const interim = await this.driver.inspectDom();
            if (interim.accountState !== "unknown" || interim.hasComposer) {
              dom = interim;
              break;
            }
          } catch {}
        }
      }

      if (/^https:\/\/www\.google\.com\/sorry\/(?:index)?(?:[?#]|$)/.test(dom.url)) {
        return { browserState: "needs_user_action", accountState: "needs_user_action", checkedAt,
          error: { code: "BROWSER_USER_ACTION_REQUIRED", message: "Complete Google's traffic verification in the open browser, then return to Gemini. No prompt was submitted.", retryable: false, suggestedAction: "open_browser", detail: "google_traffic_verification" } };
      }
      if (!dom.isAllowedSurface) {
        return {
          browserState: "closed",
          accountState: "unknown",
          actionReason: "Connected target is not a valid Gemini Web surface.",
          checkedAt,
        };
      }

      let browserState: BrowserState = "ready";
      if (dom.accountState === "signed_in") {
        browserState = dom.hasComposer ? "ready" : "needs_user_action";
      } else if (dom.accountState === "needs_user_action") {
        browserState = "needs_user_action";
      } else {
        browserState = "closed";
      }

      return {
        browserState,
        accountState: dom.accountState,
        displayLabel: dom.modelDetected,
        accountIdentity: dom.accountIdentity,
        actionReason: dom.accountState === "signed_in" ? "Active Gemini Web session connected" : "User authentication required",
        checkedAt,
      };
    } catch (err: any) {
      return {
        browserState: "failed",
        accountState: "unknown",
        actionReason: `Failed to inspect browser DOM: ${err.message}`,
        checkedAt,
        error: {
          code: "DOM_INSPECTION_FAILED",
          message: err.message,
          retryable: true,
        },
      };
    }
  }

  async openBrowser(): Promise<BrowserOpenResult> {
    try {
      const launched = await this.driver.launchOrAttach(15000);
      if (!launched) {
        return {
          opened: false,
          actionReason: "Failed to connect to Chrome CDP within timeout.",
        };
      }
      return {
        opened: true,
        actionReason: "Chrome launched and CDP connected successfully.",
      };
    } catch (err: any) {
      return {
        opened: false,
        actionReason: `Chrome launch failed: ${err.message}`,
      };
    }
  }

  async submitPrompt(turnId: string, text: string, options?: BrowserPromptOptions): Promise<PromptSubmissionReceipt> {
    if (this.cleanupRequired) {
      throw { code: "SERVICE_UNAVAILABLE", message: "Browser cleanup must finish before submitting another prompt.", retryable: true } satisfies UiError;
    }
    if (options?.snapshotAttachment) {
      options = { ...options, snapshotAttachment: validateNativeSnapshot(options.snapshotAttachment) };
      if (!/^[a-f0-9]{64}$/.test(options.expectedAccountFingerprint ?? "")) throw { code: "ACCOUNT_IDENTITY_UNVERIFIED", message: "Snapshot upload requires a pinned account identity.", delivery: "not_sent", retryable: false };
    }
    const submissionHash = createHash("sha256").update(JSON.stringify([text, options?.snapshotAttachment?.sha256, options?.expectedAccountFingerprint, options?.modelSelection])).digest("hex");
    const existing = this.activeTurns.get(turnId);
    if (existing) {
      if (existing.submissionHash === submissionHash) {
        return existing.submission!;
      }
      const conflictError: UiError = {
        code: "CONFIG_CONFLICT",
        message: `Turn ID '${turnId}' already exists with different prompt content.`,
        retryable: false,
      };
      throw conflictError;
    }
    const retired = this.retiredTurns.get(turnId);
    if (retired) throw { code: retired === submissionHash ? "OUTCOME_UNKNOWN" : "CONFIG_CONFLICT", message: "This turn's result expired; its Send identity is retained.", retryable: false } satisfies UiError;
    for (const [id, completed] of this.activeTurns) {
      if (this.activeTurns.size < 32) break;
      if (completed.response && !completed.generationUnsettled) {
        this.retiredTurns.set(id, completed.submissionHash);
        this.activeTurns.delete(id);
      }
    }
    if (this.retiredTurns.size + this.activeTurns.size >= 65536) throw { code: "QUEUE_FULL", message: "Browser Send identity capacity reached; no replay fences were removed.", retryable: false } satisfies UiError;

    // Check if another turn is actively running
    for (const [otherId, record] of this.activeTurns) {
      if (record.generationUnsettled || record.state === "reserved" || record.state === "in_progress" || record.state === "cancel_requested") {
        const busyError: UiError = {
          code: "BUSY",
          message: `Browser is currently processing turn '${otherId}'. Sequential conversation required.`,
          retryable: true,
        };
        throw busyError;
      }
    }
    // Reserve synchronously, before status/DOM awaits or any reentrant callout.
    const record: TurnRecord = {
      submissionDiagnostic: { inputChars: text.length, readbackVerified: false, sendClickAttempted: false, acceptanceObserved: false },
      turnId, text, submissionHash, state: "reserved", submittedAt: new Date().toISOString(), initialCount: 0,
      epoch: this.epoch, accepted: false, generationUnsettled: false, cancelRequested: false,
    };
    this.activeTurns.set(turnId, record);
    record.submission = Promise.resolve().then(() => this.performSubmission(record, options));
    return record.submission;
  }

  private async performSubmission(record: TurnRecord, options?: BrowserPromptOptions): Promise<PromptSubmissionReceipt> {
    try {
      this.stopBeforeSend(record);
      const status = await this.checkStatus();
      this.stopBeforeSend(record);
      if (status.browserState !== "ready" || status.accountState !== "signed_in") {
        const error: UiError = {
          code: "LOGIN_REQUIRED",
          message: "Cannot submit prompt to Gemini Web: browser session is not signed in or surface is not ready.",
          retryable: false,
          suggestedAction: "open_browser",
          correlationId: `err-submit-${Date.now()}`,
        };
        throw error;
      }

      assertBrowserAccountIdentity(status.accountIdentity, options?.expectedAccountFingerprint);
      const dom = await this.driver.inspectDom();
      this.stopBeforeSend(record);
      assertBrowserAccountIdentity(dom.accountIdentity, options?.expectedAccountFingerprint);
      if (dom.isGenerating) {
        throw { code: "BUSY", message: "Browser still has an unsettled generation.", retryable: true } satisfies UiError;
      }
      record.targetWs = this.driver.cdp?.wsUrl;
      if (options?.snapshotAttachment) {
        if (!record.targetWs || !this.leasedTargetWs.has(record.targetWs)) throw { code: "SNAPSHOT_REQUIRES_LEASE", message: "Snapshot upload requires an exact bridge-managed conversation lease.", delivery: "not_sent", retryable: false };
        record.snapshotFile=await this.driver.uploadSnapshot(options.snapshotAttachment, () => this.stopBeforeSend(record), options.expectedAccountFingerprint);
        this.stopBeforeSend(record);
      } else if (this.driver.cdp && await this.driver.hasPendingAttachments()) {
        throw { code: "UNEXPECTED_ATTACHMENT", message: "The composer contains an unsent attachment.", delivery: "not_sent", retryable: false };
      }
      record.initialCount = dom.responseCount;
      record.initialResponseKey = dom.lastResponseKey;
      const inputOk = await this.driver.inputPrompt(record.text, () => this.stopBeforeSend(record));
      this.stopBeforeSend(record);
      if (!inputOk) {
        throw { code: "INPUT_FAILED", message: "Failed to input prompt into composer element", retryable: true } satisfies UiError;
      }
      record.submissionDiagnostic.readbackVerified = true;
      if (options?.modelSelection) { await this.driver.selectModel(options.modelSelection, true); this.stopBeforeSend(record); }
      record.targetWs = this.driver.cdp?.wsUrl;
      // A lost acknowledgement after this point must never trigger an automatic resend.
      const sendOk = await this.driver.clickSend(() => this.stopBeforeSend(record), options?.expectedAccountFingerprint, () => {
        record.generationUnsettled = true; record.submissionDiagnostic.sendClickAttempted = true;
      }, options?.snapshotAttachment?.fileName);
      this.assertCurrent(record);
      if (!sendOk) {
        record.generationUnsettled = false;
        throw { code: "SEND_FAILED", message: "Failed to trigger send button in Gemini composer", retryable: true } satisfies UiError;
      }
      record.submissionDiagnostic.acceptanceObserved = true;
      record.accepted = true;
      record.state = record.cancelRequested ? "cancel_requested" : "in_progress";
      return {
        turnId: record.turnId,
        submittedAt: record.submittedAt,
        status: "accepted",
        submissionDiagnostic: { ...record.submissionDiagnostic },
        deadlineMs: options?.timeoutMs ?? 30000,
      };
    } catch (cause: unknown) {
      if(cause instanceof SnapshotFileCleanupError)record.snapshotFile=cause.lease;
      if (cause && typeof cause === "object" && "delivery" in cause && cause.delivery === "not_sent") record.generationUnsettled = false;
      let cleanupFailed=false;
      try{await this.releaseSnapshotFile(record);}catch{cleanupFailed=true;}
      const known = cleanupFailed||cause instanceof SnapshotFileCleanupError?{code:"SNAPSHOT_CLEANUP_FAILED",message:"Private snapshot cleanup is incomplete; browser cleanup is required.",retryable:false}:cause && typeof cause === "object" && "code" in cause && "message" in cause ? cause as UiError : undefined;
      const error: UiError = known ?? {
        code: record.generationUnsettled ? "OUTCOME_UNKNOWN" : "SERVICE_UNAVAILABLE",
        message: record.generationUnsettled ? "Send acknowledgement was lost; cleanup is required before another submission." : "Browser submission failed before acceptance.",
        retryable: !record.generationUnsettled,
      };
      const diagnosed = Object.assign(error, { delivery: record.generationUnsettled ? "unknown" : "not_sent", submissionDiagnostic: { ...record.submissionDiagnostic } });
      this.settle(record, { turnId: record.turnId, status: "failed", text: "", completedAt: new Date().toISOString(), error: diagnosed, submissionDiagnostic: { ...record.submissionDiagnostic } });
      throw diagnosed;
    }
  }

  async pollResponse(turnId: string, options?: BrowserPollOptions): Promise<PromptTurnResponse> {
    const record = this.activeTurns.get(turnId);
    if (!record) {
      const error: UiError = {
        code: "TURN_NOT_FOUND",
        message: `No active prompt submission found for turn '${turnId}'.`,
        retryable: false,
      };
      throw error;
    }

    // If turn has already reached terminal outcome, return immutable response
    if (record.response) {
      return structuredClone(record.response);
    }
    if (record.state === "cancelled") {
      return {
        turnId,
        status: "cancelled",
        text: "",
        completedAt: record.completedAt ?? new Date().toISOString(),
      };
    }
    if (record.state === "failed") {
      return {
        turnId,
        status: "failed",
        text: "",
        completedAt: record.completedAt ?? new Date().toISOString(),
        error: record.error ?? { code: "FAILED", message: "Turn failed", retryable: false },
      };
    }

    if (!record.polling) {
      record.polling = Promise.resolve().then(() => this.performPoll(record, options));
    }
    return structuredClone(await record.polling);
  }

  private async performPoll(record: TurnRecord, options?: BrowserPollOptions): Promise<PromptTurnResponse> {
    try {
      await record.submission;
      if (record.response) return structuredClone(record.response);
      this.assertCurrent(record);
      const turnId = record.turnId;
      const timeout = options?.deadlineMs ?? 30000;
      record.pollController = new AbortController();
      const pollRes = await this.driver.pollForResponse(record.initialCount, timeout, { ...options, signal: record.pollController.signal, onProgress: progress => { this.assertCurrent(record); if (!record.response) options?.onProgress?.(progress); } }, record.initialResponseKey);
      const completedAt = new Date().toISOString();
      if (record.cancellation) await record.cancellation;
      if (record.response) return structuredClone(record.response);
      this.assertCurrent(record);

      // If generation did not complete within timeout (even if partial text was produced)
      if (!pollRes.completed) {
        const error: UiError = {
          code: "TIMEOUT",
          message: `Timed out waiting for response completion after ${timeout}ms`,
          retryable: false,
        };
        return this.settle(record, {
          turnId,
          status: "failed",
          text: pollRes.text,
          completedAt,
          error,
        });
      }

      const dom = await this.driver.inspectDom().catch(() => null);
      if (record.cancellation) await record.cancellation;
      if (record.response) return structuredClone(record.response);
      this.assertCurrent(record);
      record.generationUnsettled = false;
      await this.releaseSnapshotFile(record);
      return this.settle(record, {
        turnId,
        status: "completed",
        text: pollRes.text,
        modelDetected: dom?.modelDetected,
        codeBlocks: pollRes.codeBlocks,
        completedAt,
      });
    } catch {
      return this.settle(record, { turnId: record.turnId, status: "failed", text: "", completedAt: new Date().toISOString(),
        error: { code: "SERVICE_UNAVAILABLE", message: "Browser polling was interrupted; accepted prompts are not resent.", retryable: false } });
    }
  }

  async cancelPrompt(turnId: string): Promise<TurnCancelResult> {
    const record = this.activeTurns.get(turnId);
    if (!record) {
      return {
        turnId,
        cancelled: false,
        reason: `Turn '${turnId}' not found in active submissions.`,
      };
    }

    // Reject cancel if turn is already in terminal state
    if (record.state === "completed" || record.state === "failed" || record.state === "cancelled") {
      return {
        turnId,
        cancelled: false,
        reason: `Turn '${turnId}' is already in terminal state '${record.state}'.`,
      };
    }

    if (record.cancellation) return record.cancellation;
    record.cancelRequested = true;
    record.state = "cancel_requested";
    record.cancellation = Promise.resolve().then(() => this.performCancellation(record));
    const pending = record.cancellation;
    pending.then(() => { record.cancellation = undefined; }, () => { record.cancellation = undefined; });
    return pending;
  }

  private async performCancellation(record: TurnRecord): Promise<TurnCancelResult> {
    const turnId = record.turnId;
    try { await record.submission; } catch {}
    if (record.response) {
      return { turnId, cancelled: record.response.status === "cancelled", reason: "Submission settled before cancellation." };
    }
    const failedStop = (reason: string): TurnCancelResult => {
      record.cancelRequested = false;
      if (!record.response) record.state = "in_progress";
      return { turnId, cancelled: false, reason };
    };
    try { this.assertCurrent(record); } catch { return failedStop("Browser operation was invalidated."); }
    const stopDeadline = performance.now() + 2000;
    let stopClicked = false;
    try {
      stopClicked = await this.driver.clickStop(Math.max(1, stopDeadline - performance.now()));
    } catch {
      return failedStop("Stop click failed; generation has not been confirmed halted.");
    }

    if (!stopClicked) {
      return failedStop("Stop button not found or click returned false.");
    }

    // Verify on DOM that generation has actually halted
    let confirmedHalted = false;
    while (performance.now() < stopDeadline) {
      const dom = await this.driver.inspectDom(Math.max(1, stopDeadline - performance.now())).catch(() => null);
      if (dom?.isAllowedSurface && !dom.isGenerating) {
        confirmedHalted = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    if (!confirmedHalted) {
      return failedStop("Stop button clicked but generation did not confirm halted on DOM.");
    }
    const terminal = this.terminalResponse(record);
    if (terminal) return { turnId, cancelled: terminal.status === "cancelled", reason: "Turn already settled." };
    try { this.assertCurrent(record); } catch { return failedStop("Browser operation was invalidated."); }
    const completedAt = new Date().toISOString();
    record.generationUnsettled = false;
    try{await this.releaseSnapshotFile(record);}catch{return failedStop("Snapshot file cleanup did not complete.");}
    this.settle(record, {
      turnId,
      status: "cancelled",
      text: "",
      completedAt,
    });

    return {
      turnId,
      cancelled: true,
      reason: "Stop button clicked and generation halted on DOM.",
    };
  }

  async cleanup(): Promise<void> {
    if (this.cleaning) return this.cleaning;
    this.cleanupRequired = true;
    this.epoch++;
    for (const record of this.activeTurns.values()) {
      this.settle(record, { turnId: record.turnId, status: "failed", text: "", completedAt: new Date().toISOString(),
        error: { code: "SERVICE_UNAVAILABLE", message: "Browser session was closed.", retryable: false } });
    }
    const pending = Promise.resolve().then(async () => {
      try { for (const close of [...this.ownedTabClosers]) await close(); }
      finally {
        const owned=this.driver.isOwnedProcess;
        if (this.preserveOwnedBrowserProcessOnCleanup && owned) await this.driver.detachPreservingOwnedProcess();
        else {await this.driver.close();if(owned)for(const record of this.activeTurns.values()){record.generationUnsettled=false;await this.releaseSnapshotFile(record);}}
      }
      this.activeTurns.clear();
      this.retiredTurns.clear();
      this.cleanupRequired = false;
    });
    this.cleaning = pending;
    pending.then(() => { this.cleaning = undefined; }, () => { this.cleaning = undefined; });
    return pending;
  }

  async sendPrompt(text: string): Promise<string> {
    const turnId = `turn-${Date.now()}`;
    await this.submitPrompt(turnId, text);
    const res = await this.pollResponse(turnId);
    if (res.status !== "completed") {
      throw new Error(`Prompt turn failed with status '${res.status}': ${res.error?.message ?? "unknown"}`);
    }
    return res.text;
  }
}
