import type { BrowserState, AccountState, UiError } from "@antigravity-gemini-web/contracts";
import { GeminiBrowserDriver, type BrowserDriverOptions } from "./gemini-browser-driver.js";
import { CdpClient, type CdpTarget } from "./cdp-client.js";
import { isAllowedSurfaceUrl } from "./gemini-selectors.js";

export * from "./cdp-client.js";
export * from "./gemini-selectors.js";
export * from "./gemini-browser-driver.js";
export * from "./fixture-server.js";

export interface BrowserStatus {
  browserState: BrowserState;
  accountState: AccountState;
  displayLabel?: string;
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
}

export interface PromptTurnResponse {
  turnId: string;
  status: "completed" | "cancelled" | "failed";
  text: string;
  codeBlocks?: string[];
  modelDetected?: string;
  completedAt: string;
  error?: UiError;
}

export interface TurnCancelResult {
  turnId: string;
  cancelled: boolean;
  reason?: string;
}

export interface GeminiBrowserAdapter {
  checkStatus(): Promise<BrowserStatus>;
  openBrowser(): Promise<BrowserOpenResult>;
  submitPrompt(turnId: string, text: string, options?: { timeoutMs?: number }): Promise<PromptSubmissionReceipt>;
  pollResponse(turnId: string, options?: { deadlineMs?: number }): Promise<PromptTurnResponse>;
  cancelPrompt(turnId: string): Promise<TurnCancelResult>;
  cleanup(): Promise<void>;
  sendPrompt(text: string): Promise<string>;
  openFreshConversation?(): Promise<{ close(): Promise<void> }>;
}

interface TurnRecord {
  turnId: string;
  text: string;
  state: "reserved" | "in_progress" | "completed" | "failed" | "cancel_requested" | "cancelled";
  submittedAt: string;
  initialCount: number;
  completedAt?: string;
  response?: PromptTurnResponse;
  error?: UiError;
  epoch: number;
  accepted: boolean;
  generationUnsettled: boolean;
  cancelRequested: boolean;
  submission?: Promise<PromptSubmissionReceipt>;
  polling?: Promise<PromptTurnResponse>;
  cancellation?: Promise<TurnCancelResult>;
}

export class LiveGeminiBrowserAdapter implements GeminiBrowserAdapter {
  public readonly driver: GeminiBrowserDriver;
  private activeTurns = new Map<string, TurnRecord>();
  private epoch = 0;
  private cleanupRequired = false;
  private cleaning?: Promise<void>;

  constructor(options: BrowserDriverOptions = {}) {
    this.driver = new GeminiBrowserDriver(options);
  }

  /** A native provider round owns a fresh tab; the previous tab/draft is never navigated or copied. */
  async openFreshConversation(): Promise<{ close(): Promise<void> }> {
    const status = await this.checkStatus();
    const original = this.driver.cdp;
    if (status.browserState !== "ready" || status.accountState !== "signed_in" || !original) throw new Error("Browser is not ready for an isolated native conversation.");
    if ([...this.activeTurns.values()].some(turn => turn.generationUnsettled || turn.state === "reserved" || turn.state === "in_progress" || turn.state === "cancel_requested")) throw new Error("Another browser turn is active.");
    const epoch = this.epoch;
    const created = await original.send<{ targetId: string }>("Target.createTarget", { url: this.driver.fixtureMode ? this.driver.targetUrl : "https://gemini.google.com/app" }, 5000);
    if (!created.targetId) throw new Error("Fresh browser target was not acknowledged.");
    let closed = false;
    const close = async () => {
      if (closed) return; closed = true;
      if (epoch !== this.epoch || this.cleanupRequired) return;
      await this.driver.attachToExistingWs(original.wsUrl);
      await this.driver.cdp!.send("Target.closeTarget", { targetId: created.targetId }, 3000);
    };
    try {
      const deadline = performance.now() + 15000;
      let attached = false;
      while (performance.now() < deadline) {
        if (epoch !== this.epoch || this.cleanupRequired) throw new Error("Browser lifecycle changed.");
        if (!attached) {
          const target = await CdpClient.findTarget(this.driver.debugPort, candidate => candidate.id === created.targetId);
          if (target?.webSocketDebuggerUrl) { await this.driver.attachToExistingWs(target.webSocketDebuggerUrl); attached = true; }
        }
        if (attached) {
          const dom = await this.driver.inspectDom(2000).catch(() => undefined);
          if (dom?.isAllowedSurface && dom.accountState === "signed_in" && dom.hasComposer && !dom.isGenerating && dom.responseCount === 0) return { close };
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error("Fresh native conversation did not become ready.");
    } catch (error) { await close().catch(() => { this.cleanupRequired = true; }); throw error; }
  }

  private assertCurrent(record: TurnRecord): void {
    if (record.epoch !== this.epoch || this.activeTurns.get(record.turnId) !== record || this.cleanupRequired) {
      throw { code: "SERVICE_UNAVAILABLE", message: "Browser operation was invalidated by cleanup.", retryable: false } satisfies UiError;
    }
  }

  private settle(record: TurnRecord, response: PromptTurnResponse): PromptTurnResponse {
    if (!record.response) {
      record.response = structuredClone(response);
      record.state = response.status;
      record.completedAt = response.completedAt;
      record.error = response.error;
    }
    // Callers cannot mutate the authoritative terminal cache.
    return structuredClone(record.response);
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

  async submitPrompt(turnId: string, text: string, options?: { timeoutMs?: number }): Promise<PromptSubmissionReceipt> {
    if (this.cleanupRequired) {
      throw { code: "SERVICE_UNAVAILABLE", message: "Browser cleanup must finish before submitting another prompt.", retryable: true } satisfies UiError;
    }
    const existing = this.activeTurns.get(turnId);
    if (existing) {
      if (existing.text === text) {
        return existing.submission!;
      }
      const conflictError: UiError = {
        code: "CONFIG_CONFLICT",
        message: `Turn ID '${turnId}' already exists with different prompt content.`,
        retryable: false,
      };
      throw conflictError;
    }

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
      turnId, text, state: "reserved", submittedAt: new Date().toISOString(), initialCount: 0,
      epoch: this.epoch, accepted: false, generationUnsettled: false, cancelRequested: false,
    };
    this.activeTurns.set(turnId, record);
    record.submission = Promise.resolve().then(() => this.performSubmission(record, options));
    return record.submission;
  }

  private async performSubmission(record: TurnRecord, options?: { timeoutMs?: number }): Promise<PromptSubmissionReceipt> {
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

      const dom = await this.driver.inspectDom();
      this.stopBeforeSend(record);
      if (dom.isGenerating) {
        throw { code: "BUSY", message: "Browser still has an unsettled generation.", retryable: true } satisfies UiError;
      }
      record.initialCount = dom.responseCount;
      const inputOk = await this.driver.inputPrompt(record.text);
      this.stopBeforeSend(record);
      if (!inputOk) {
        throw { code: "INPUT_FAILED", message: "Failed to input prompt into composer element", retryable: true } satisfies UiError;
      }
      // A lost acknowledgement after this point must never trigger an automatic resend.
      record.generationUnsettled = true;
      const sendOk = await this.driver.clickSend();
      this.assertCurrent(record);
      if (!sendOk) {
        record.generationUnsettled = false;
        throw { code: "SEND_FAILED", message: "Failed to trigger send button in Gemini composer", retryable: true } satisfies UiError;
      }
      record.accepted = true;
      record.state = record.cancelRequested ? "cancel_requested" : "in_progress";
      return {
        turnId: record.turnId,
        submittedAt: record.submittedAt,
        status: "accepted",
        deadlineMs: options?.timeoutMs ?? 30000,
      };
    } catch (cause: unknown) {
      const known = cause && typeof cause === "object" && "code" in cause && "message" in cause ? cause as UiError : undefined;
      const error: UiError = known ?? {
        code: record.generationUnsettled ? "OUTCOME_UNKNOWN" : "SERVICE_UNAVAILABLE",
        message: record.generationUnsettled ? "Send acknowledgement was lost; cleanup is required before another submission." : "Browser submission failed before acceptance.",
        retryable: !record.generationUnsettled,
      };
      this.settle(record, { turnId: record.turnId, status: "failed", text: "", completedAt: new Date().toISOString(), error });
      throw error;
    }
  }

  async pollResponse(turnId: string, options?: { deadlineMs?: number }): Promise<PromptTurnResponse> {
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

  private async performPoll(record: TurnRecord, options?: { deadlineMs?: number }): Promise<PromptTurnResponse> {
    try {
      await record.submission;
      if (record.response) return structuredClone(record.response);
      this.assertCurrent(record);
      const turnId = record.turnId;
      const timeout = options?.deadlineMs ?? 30000;
      const pollRes = await this.driver.pollForResponse(record.initialCount, timeout);
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
      await this.driver.close();
      this.activeTurns.clear();
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
