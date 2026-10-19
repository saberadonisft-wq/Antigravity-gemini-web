import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { accountIdentityEmail } from "@antigravity-gemini-web/contracts";
import type { NativeSnapshotAttachment } from "@antigravity-gemini-web/contracts";
import { attachmentInspectionScript, uploadNativeSnapshot,type NativeSnapshotFileLease } from "./snapshot-upload.js";
import { verifyBrowserProfile } from "./profile-identity.js";
import { CdpClient, type CdpTarget } from "./cdp-client.js";
import { ProgressDeadline, type BrowserPollOptions, type BrowserModelSelection } from "./progress.js";
import { selectBrowserModel, inspectBrowserModels } from "./model-controls.js";
import {
  getDomInspectionSnippet,
  isAllowedSurfaceUrl,
  GEMINI_SELECTORS,
  type DomInspectionResult,
} from "./gemini-selectors.js";

export interface BrowserDriverOptions {
  chromePath?: string;
  userDataDir?: string;
  debugPort?: number;
  headless?: boolean;
  targetUrl?: string;
  fixtureMode?: boolean;
  allowedOrigins?: string[];
  requireProfileIdentity?: boolean;
}

export function assertBrowserAccountIdentity(identity: unknown, expectedFingerprint?: string): string | undefined {
  if (expectedFingerprint === undefined) return undefined;
  const email = accountIdentityEmail(identity);
  if (!email || !expectedFingerprint) throw { code: "ACCOUNT_IDENTITY_UNVERIFIED", message: "A stable signed-in account identity is required before Send.", delivery: "not_sent", retryable: false };
  if (createHash("sha256").update(email).digest("hex") !== expectedFingerprint) throw { code: "ACCOUNT_IDENTITY_CHANGED", message: "The signed-in account changed before Send.", delivery: "not_sent", retryable: false };
  return email;
}

export class GeminiBrowserDriver {
  private childProcess: ChildProcess | null = null;
  public cdp: CdpClient | null = null;
  public readonly debugPort: number;
  public readonly userDataDir: string;
  public readonly chromePath: string;
  public readonly headless: boolean;
  public readonly targetUrl: string;
  public readonly fixtureMode: boolean;
  public readonly allowedOrigins: string[];
  public readonly requireProfileIdentity: boolean;

  public isOwnedProcess = false;
  public isAttachedTarget = false;
  private opening?: Promise<boolean>;
  private createdInitialTarget?: string;
  private closing?: Promise<void>;
  private lifecycleEpoch = 0;

  constructor(options: BrowserDriverOptions = {}) {
    this.debugPort = options.debugPort ?? 9222;
    this.userDataDir = options.userDataDir ?? "C:\\Users\\vhc\\.gemini\\gemini_web_probe_profile";
    this.chromePath = options.chromePath ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    this.headless = options.headless ?? false;
    this.targetUrl = options.targetUrl ?? "https://gemini.google.com/app";
    this.fixtureMode = options.fixtureMode ?? false;
    this.allowedOrigins = options.allowedOrigins ?? [];
    this.requireProfileIdentity = options.requireProfileIdentity ?? false;
  }

  get isConnected(): boolean {
    return this.cdp !== null && this.cdp.isConnected;
  }

  get isProcessAlive(): boolean {
    return this.childProcess !== null && this.childProcess.exitCode === null;
  }

  private isTargetAllowed(t: CdpTarget): boolean {
    if (t.type !== "page") return false;
    return isAllowedSurfaceUrl(t.url, { fixtureMode: this.fixtureMode, allowedOrigins: this.allowedOrigins });
  }

  launchOrAttach(timeoutMs = 15000): Promise<boolean> {
    if (this.closing) return Promise.resolve(false);
    if (this.isConnected) return Promise.resolve(true);
    if (this.opening) return this.opening;
    const epoch = this.lifecycleEpoch;
    const pending = Promise.resolve().then(() => this.performLaunch(timeoutMs, epoch));
    this.opening = pending;
    pending.then(() => { this.opening = undefined; }, () => { this.opening = undefined; });
    return pending;
  }

  private async performLaunch(timeoutMs: number, epoch: number): Promise<boolean> {
    if (epoch !== this.lifecycleEpoch || this.closing) return false;
    if (!isAllowedSurfaceUrl(this.targetUrl, { fixtureMode: this.fixtureMode, allowedOrigins: this.allowedOrigins })) return false;
    // 1. Check if an allowed Chrome CDP page target is already open
    let target = await CdpClient.findTarget(this.debugPort, (t) => this.isTargetAllowed(t));
    if (epoch !== this.lifecycleEpoch || this.closing) return false;

    // An existing debug browser may be on /usage rather than /app. Create one
    // owned page there; never spawn a short-lived launcher and claim its browser.
    if (!target) {
      const existing = await CdpClient.findTarget(this.debugPort, t => t.type === "page");
      if (existing?.webSocketDebuggerUrl) {
        const control = new CdpClient(existing.webSocketDebuggerUrl);
        let created: string | undefined, committed = false;
        try {
          await control.connect(Math.min(3000, timeoutMs));
          if (this.requireProfileIdentity && !await verifyBrowserProfile(control, this.userDataDir, this.debugPort, this.chromePath)) throw Error("Debug port belongs to another or unverified browser profile.");
          if (epoch !== this.lifecycleEpoch || this.closing) return false;
          created = (await control.send<{ targetId: string }>("Target.createTarget", { url: this.targetUrl }, 3000)).targetId;
          if (!created) throw Error("New page was not acknowledged.");
          const deadline = performance.now() + timeoutMs;
          while (performance.now() < deadline && epoch === this.lifecycleEpoch && !this.closing) {
            target = await CdpClient.findTarget(this.debugPort, t => t.id === created && this.isTargetAllowed(t));
            if (target?.webSocketDebuggerUrl) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          if (!target?.webSocketDebuggerUrl || epoch !== this.lifecycleEpoch || this.closing) return false;
          this.cdp = new CdpClient(target.webSocketDebuggerUrl); await this.cdp.connect();
          if (epoch !== this.lifecycleEpoch || this.closing) return false;
          this.createdInitialTarget = created; this.isAttachedTarget = true; this.isOwnedProcess = false; committed = true;
          return true;
        } finally {
          if (created && !committed) await control.send("Target.closeTarget", { targetId: created }, 2000).catch(() => {});
          control.close();
        }
      }
    }

    if (target?.webSocketDebuggerUrl) {
      this.isAttachedTarget = !this.isOwnedProcess;
    } else {
      // 2. If not running, spawn Chrome as an owned process
      const args = [
        `--remote-debugging-port=${this.debugPort}`,
        `--user-data-dir=${this.userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        ...(this.requireProfileIdentity ? ["--enable-automation"] : []),
      ];
      if (this.headless) {
        args.push("--headless=new");
      }
      args.push(this.targetUrl);

      let spawnError: Error | null = null;
      try {
        if (!this.isProcessAlive) {
          this.childProcess = spawn(this.chromePath, args, {
            detached: false,
            stdio: "ignore",
          });
          this.isOwnedProcess = true;
          this.isAttachedTarget = false;

          this.childProcess.on("error", (err) => {
            spawnError = err;
            this.childProcess = null;
            this.isOwnedProcess = false;
          });
        }
      } catch (err: any) {
        this.isOwnedProcess = false;
        return false;
      }

      // Poll until CDP becomes available and target page matches allowed origin
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (epoch !== this.lifecycleEpoch || this.closing) return false;
        if (spawnError) {
          return false;
        }
        target = await CdpClient.findTarget(this.debugPort, (t) => this.isTargetAllowed(t));
        if (target?.webSocketDebuggerUrl) {
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    if (!target?.webSocketDebuggerUrl) {
      return false;
    }
    if (epoch !== this.lifecycleEpoch || this.closing) return false;

    // 3. Connect CDP client
    this.cdp?.close();
    this.cdp = new CdpClient(target.webSocketDebuggerUrl);
    await this.cdp.connect();
    if (this.requireProfileIdentity && !await verifyBrowserProfile(this.cdp, this.userDataDir, this.debugPort, this.chromePath)) {
      this.cdp.close(); this.cdp = null;
      throw Error("Debug port belongs to another or unverified browser profile.");
    }
    return true;
  }

  async attachToExistingWs(wsUrl: string): Promise<void> {
    if (this.closing) throw new Error("Browser cleanup is in progress");
    if (this.cdp?.wsUrl === wsUrl && this.cdp.isConnected) return;
    const previous = this.cdp, epoch = this.lifecycleEpoch;
    const next = new CdpClient(wsUrl);
    try {
      await next.connect();
      if (this.closing || epoch !== this.lifecycleEpoch || this.cdp !== previous) throw new Error("Browser attachment was invalidated.");
      this.cdp = next;
      this.isAttachedTarget = !this.isOwnedProcess;
      previous?.close();
    } catch (error) { next.close(); throw error; }
  }

  async inspectDom(timeoutMs = 10000): Promise<DomInspectionResult> {
    if (!this.cdp) {
      throw new Error("Browser driver is not connected to a CDP target");
    }
    const snippet = getDomInspectionSnippet({
      fixtureMode: this.fixtureMode,
      allowedOrigins: this.allowedOrigins,
    });
    const result = await this.cdp.evaluate<DomInspectionResult>(snippet, true, timeoutMs);
    if (!result) {
      throw new Error("DOM inspection returned empty result");
    }
    return result;
  }

  /** Wait on the editor transition before mutating it; an enabled Send alone is insufficient. */
  async waitForComposerReady(requireSend = false, check: () => void = () => {}, timeoutMs = 5000): Promise<boolean> {
    if (!this.cdp) return false;
    const deadline = performance.now() + timeoutMs;
    let signature = "", stableSince = 0;
    while (performance.now() < deadline) {
      check();
      const state = await this.cdp.evaluate<{ allowed: boolean; ready: boolean; signature: string }>(`(() => {
        const dom = ${getDomInspectionSnippet({ fixtureMode: this.fixtureMode, allowedOrigins: this.allowedOrigins })};
        const editor = document.querySelector("${GEMINI_SELECTORS.COMPOSER_INPUT}");
        const visible = el => el && el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== 'hidden';
        const buttons = [...document.querySelectorAll("${GEMINI_SELECTORS.SEND_BUTTON}")].filter(el => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
        const allowed = dom.isAllowedSurface && dom.accountState === 'signed_in';
        const ready = allowed && !dom.isGenerating && visible(editor) && !editor.disabled && !editor.readOnly && !editor.closest('[aria-busy="true"], [inert]') && getComputedStyle(editor).pointerEvents !== 'none' && ${requireSend ? "buttons.length === 1" : "true"};
        return { allowed, ready: Boolean(ready), signature: JSON.stringify([dom.lastResponseKey, dom.lastUserQueryKey, editor?.outerHTML, buttons.map(el => el.outerHTML)]) };
      })()`, true, Math.max(1, Math.min(1500, deadline - performance.now())));
      check();
      if (!state?.allowed) return false;
      if (!state.ready || signature !== state.signature) { signature = state.ready ? state.signature : ""; stableSince = performance.now(); }
      else if (performance.now() - stableSince >= 200) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }

  async inputPrompt(text: string, check: () => void = () => {}): Promise<boolean> {
    if (!this.cdp) {
      throw new Error("Browser driver is not connected");
    }

    if (!await this.waitForComposerReady(false, check)) return false;
    check();
    const script = `
      (() => {
        const inspection = ${getDomInspectionSnippet({ fixtureMode: this.fixtureMode, allowedOrigins: this.allowedOrigins })};
        if (!inspection.isAllowedSurface || inspection.accountState !== 'signed_in' || inspection.isGenerating) return false;
        let composer = document.querySelector("${GEMINI_SELECTORS.COMPOSER_INPUT}");
        if (!composer) {
          const container = document.querySelector("${GEMINI_SELECTORS.COMPOSER}");
          if (container) {
            composer = container.querySelector("div[contenteditable='true'], .ql-editor, textarea, p") || container;
          }
        }
        if (!composer) return false;

        composer.focus();
        if (composer.tagName.toLowerCase() === 'textarea') composer.select();
        else {
          const range = document.createRange(); range.selectNodeContents(composer);
          const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        }
        return true;
      })()
    `;

    const ok = await this.cdp.evaluate<boolean>(script);
    if (!ok) return false;
    // Use Chromium's editor input path so the rich editor's model and its DOM
    // receive the same text. Assigning textContent bypasses editor state.
    await this.cdp.send("Input.insertText", { text });
    const readback = `(() => {
      const composer = document.querySelector("${GEMINI_SELECTORS.COMPOSER_INPUT}");
      if (!composer) return false;
      const paragraphs = Array.from(composer.children);
      const actual = composer.tagName.toLowerCase() === 'textarea' ? composer.value
        : composer.classList.contains('ql-editor') && paragraphs.length && paragraphs.every(p => p.tagName === 'P')
          ? paragraphs.map(p => p.textContent === '' ? '' : p.innerText).join('\\n') : composer.innerText;
      const expected = ${JSON.stringify(text)};
      return actual === expected || actual === expected + '\\n';
    })()`;
    const deadline = performance.now() + 3000;
    let matches = 0;
    while (performance.now() < deadline) {
      check();
      if (await this.cdp.evaluate<boolean>(readback)) { if (++matches >= 2) return this.waitForComposerReady(text.length > 0, check); }
      else matches = 0;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }

  async hasPendingAttachments(): Promise<boolean> {
    if (!this.cdp) throw Error("Browser driver is not connected");
    const state = await this.cdp.evaluate<{count:number}>(attachmentInspectionScript());
    if (!state) throw Error("Attachment inspection was unavailable.");
    return state.count > 0;
  }

  async uploadSnapshot(snapshot: NativeSnapshotAttachment, check: () => void, expectedFingerprint?: string): Promise<NativeSnapshotFileLease> {
    const cdp = this.cdp;
    if (!cdp) throw Error("Browser driver is not connected");
    return uploadNativeSnapshot(cdp, snapshot, async () => {
      check();
      if (this.cdp !== cdp) throw Error("Upload target changed.");
      const dom = await this.inspectDom(2000);
      if (!dom.isAllowedSurface || dom.accountState !== "signed_in" || dom.isGenerating) throw { code: "SOURCE_NOT_READY", message: "The upload surface changed.", delivery: "not_sent", retryable: false };
      assertBrowserAccountIdentity(dom.accountIdentity, expectedFingerprint);
      check();
    });
  }

  async clickSend(check: () => void = () => {}, expectedFingerprint?: string, onClick?: () => void, snapshotFileName?: string): Promise<boolean> {
    if (!this.cdp) {
      throw new Error("Browser driver is not connected");
    }

    check();
    const before = await this.inspectDom(2000);
    const expectedEmail = assertBrowserAccountIdentity(before.accountIdentity, expectedFingerprint);
    const script = `
      (() => {
        const inspection = ${getDomInspectionSnippet({ fixtureMode: this.fixtureMode, allowedOrigins: this.allowedOrigins })};
        if (!inspection.isAllowedSurface || inspection.accountState !== 'signed_in' || inspection.isGenerating) return false;
        const attachment = ${attachmentInspectionScript(snapshotFileName)};
        if (${!!snapshotFileName} ? !(attachment.count === 1 && attachment.matches === 1 && attachment.ready && !attachment.error) : attachment.count > 0) return { snapshotError: true };
        if (${expectedFingerprint !== undefined}) {
          const email = (${accountIdentityEmail.toString()})(inspection.accountIdentity);
          if (!email) return { identityError: "ACCOUNT_IDENTITY_UNVERIFIED" };
          if (email !== ${JSON.stringify(expectedEmail ?? null)}) return { identityError: "ACCOUNT_IDENTITY_CHANGED" };
        }
        const buttons = [...document.querySelectorAll("${GEMINI_SELECTORS.SEND_BUTTON}")].filter(btn => !btn.disabled && btn.getAttribute('aria-disabled') !== 'true' && btn.getBoundingClientRect().height > 0 && getComputedStyle(btn).visibility !== 'hidden');
        if (buttons.length !== 1) return false;
        buttons[0].scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const rect = buttons[0].getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()
    `;

    const point = await this.cdp.evaluate<{ x: number; y: number } | { identityError: string } | { snapshotError: boolean } | false>(script);
    if (!point) return false;
    if ("identityError" in point) throw { code: point.identityError, message: "Account identity changed before click Send.", delivery: "not_sent", retryable: false };
    if ("snapshotError" in point) throw { code: "UNEXPECTED_ATTACHMENT", message: "The composer attachment changed before Send.", delivery: "not_sent", retryable: false };
    check();
    onClick?.();
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    const deadline = performance.now() + 15000;
    let lastComposerChars = before.composerChars;
    while (performance.now() < deadline) {
      const dom = await this.inspectDom(Math.max(1, Math.min(1500, deadline - performance.now())));
      lastComposerChars = dom.composerChars;
      if (!dom.isAllowedSurface || dom.accountState !== 'signed_in') break;
      if (!dom.composerChars && (dom.isGenerating || dom.responseCount > before.responseCount ||
        dom.lastResponseKey && dom.lastResponseKey !== before.lastResponseKey ||
        dom.lastUserQueryKey && dom.lastUserQueryKey !== before.lastUserQueryKey)) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw { code: lastComposerChars ? "SEND_NOT_CONSUMED" : "OUTCOME_UNKNOWN", message: "Send was clicked but browser acceptance was not observed; it will not be clicked again.", retryable: false };
  }

  async clickStop(timeoutMs = 2000): Promise<boolean> {
    if (!this.cdp) {
      throw new Error("Browser driver is not connected");
    }

    const script = `
      (() => {
        const inspection = ${getDomInspectionSnippet({ fixtureMode: this.fixtureMode, allowedOrigins: this.allowedOrigins })};
        if (!inspection.isAllowedSurface || !inspection.isGenerating) return false;
        const btn = Array.from(document.querySelectorAll("${GEMINI_SELECTORS.STOP_BUTTON}")).find(btn => !btn.disabled && btn.getAttribute('aria-disabled') !== 'true' && btn.getBoundingClientRect().height > 0 && getComputedStyle(btn).visibility !== 'hidden');
        if (!btn) return false;
        btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const rect = btn.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()
    `;

    const deadline = performance.now() + timeoutMs;
    const point = await this.cdp.evaluate<{ x: number; y: number } | false>(script, true, timeoutMs);
    if (!point) return false;
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 }, Math.max(1, deadline - performance.now()));
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 }, Math.max(1, deadline - performance.now()));
    return true;
  }

  async selectModel(selection: BrowserModelSelection, verifyOnly = false) {
    if (!this.cdp) throw Error("Browser is not connected.");
    return selectBrowserModel(this.cdp, selection, { fixtureMode: this.fixtureMode, allowedOrigins: this.allowedOrigins }, verifyOnly);
  }

  async captureModelSelection() {
    if (!this.cdp) throw Error("Browser is not connected.");
    return (await inspectBrowserModels(this.cdp, { fixtureMode: this.fixtureMode, allowedOrigins: this.allowedOrigins })).selected;
  }

  async pollForResponse(initialCount: number, timeoutMs = 30000, options?: BrowserPollOptions, initialResponseKey?: string): Promise<{ text: string; completed: boolean; cancelled: boolean; hasCodeBlock: boolean; codeBlocks?: string[] }> {
    const started = performance.now();
    const clock = new ProgressDeadline(started, timeoutMs, options?.stallTimeoutMs ?? timeoutMs);
    let lastText = "";
    let hasCode = false;
    let observation = "", revision = 0;
    let completionSignature = "", completionSince = 0;

    while (!clock.expired(performance.now())) {
      options?.signal?.throwIfAborted();
      const dom = await this.inspectDom(Math.max(1, Math.min(10000, clock.remaining(performance.now()))));
      const hasNewResponse = dom.responseCount > initialCount || !!initialResponseKey && !!dom.lastResponseKey && dom.lastResponseKey !== initialResponseKey;
      const text = hasNewResponse ? dom.lastResponseText : "";
      const codeBlocks = hasNewResponse ? dom.lastResponseCodeBlocks : [];
      const signature = JSON.stringify([text, codeBlocks, dom.isGenerating, dom.progressLabel, dom.hasResponseCompletion]);
      if (signature !== observation) {
        observation = signature; clock.activity(performance.now());
        options?.onProgress?.({ revision: ++revision, elapsedMs: performance.now() - started, silentMs: clock.silentMs(performance.now()), stage: text ? "responding" : dom.isGenerating ? "generating" : "waiting", text, codeBlocks });
      }

      // Check if a new response container appeared
      if (hasNewResponse) {
        lastText = dom.lastResponseText;
        hasCode = dom.hasCodeBlock;

        // A missing Stop button can be a transient render or a localized
        // control. Wait for this answer's terminal action row and stable
        // text/code together; never freeze a partial JSON block as completed.
        const complete = !dom.isGenerating && dom.hasResponseCompletion === true && lastText.length > 0;
        const candidate = complete ? JSON.stringify([dom.responseCount, text, codeBlocks]) : "";
        if (candidate !== completionSignature) {
          completionSignature = candidate; completionSince = performance.now();
        }
        if (complete && performance.now() - completionSince >= 600) {
          return {
            text: lastText,
            completed: true,
            cancelled: false,
            hasCodeBlock: hasCode,
            codeBlocks: dom.lastResponseCodeBlocks,
          };
        }
      } else {
        completionSignature = "";
      }

      await new Promise((r) => setTimeout(r, Math.max(0, Math.min(200, clock.remaining(performance.now())))));
    }

    return {
      text: lastText,
      completed: false,
      cancelled: false,
      hasCodeBlock: hasCode,
    };
  }

  close(deadlineMs = 5000): Promise<void> {
    if (this.closing) return this.closing;
    this.lifecycleEpoch++;
    const pending = Promise.resolve().then(() => this.performClose(deadlineMs));
    this.closing = pending;
    pending.then(() => { this.closing = undefined; }, () => { this.closing = undefined; });
    return pending;
  }

  /** Drop this process's CDP and child handles while intentionally leaving its owned Chrome alive. */
  async detachPreservingOwnedProcess(): Promise<void> {
    if (this.closing) throw new Error("Cannot preserve Chrome while driver cleanup is already running.");
    const proc = this.childProcess;
    if (!this.isOwnedProcess || !proc?.pid || proc.exitCode !== null) throw new Error("There is no live owned Chrome process to preserve.");
    this.lifecycleEpoch++;
    this.cdp?.close();
    this.cdp = null;
    this.childProcess = null;
    this.createdInitialTarget = undefined;
    this.isOwnedProcess = false;
    this.isAttachedTarget = false;
  }

  private async performClose(deadlineMs: number): Promise<void> {
    const deadline = performance.now() + deadlineMs;
    const isOwned = this.isOwnedProcess;
    const proc = this.childProcess;

    // On Windows terminate the owned tree while its root still exists. Killing the
    // root first (including Browser.close) can detach utilities holding profile files.
    if (isOwned && proc?.pid && proc.exitCode === null && process.platform === "win32") {
      try {
        const { execFileSync } = await import("node:child_process");
        execFileSync("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { windowsHide: true, stdio: "ignore", timeout: Math.max(1, Math.min(3000, Math.floor(deadline - performance.now()))) });
      } catch {}
    }

    if (this.cdp) {
      if (!isOwned && this.createdInitialTarget) {
        // A page can disconnect before its own close acknowledgement arrives.
        // Use the browser endpoint and confirm absence without relying on that page's socket.
        await CdpClient.closeOwnedTarget(this.debugPort, this.createdInitialTarget, Math.max(1, Math.floor(deadline - performance.now())));
        this.createdInitialTarget = undefined;
      }
      if (isOwned) {
        try {
          await this.cdp.send("Browser.close", {}, Math.max(1, Math.min(2000, deadline - performance.now()))).catch(() => {});
        } catch {}
      }
      this.cdp.close();
      this.cdp = null;
    }

    if (isOwned && proc && proc.exitCode === null && proc.pid) {
      if (process.platform === "win32") {
        try {
          const { execFileSync } = await import("node:child_process");
          execFileSync("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { windowsHide: true, stdio: "ignore", timeout: Math.max(1, Math.min(3000, Math.floor(deadline - performance.now()))) });
        } catch {}
      } else try { proc.kill("SIGTERM"); } catch {}
      let isDead = false;
      while (performance.now() < deadline) {
        if (proc.exitCode !== null) {
          isDead = true;
          break;
        }
        try {
          process.kill(proc.pid, 0);
        } catch {
          isDead = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!isDead) {
        try {
          proc.kill("SIGKILL");
        } catch {}
        try {
          process.kill(proc.pid, 0);
        } catch {
          isDead = true;
        }
      }
      if (!isDead) {
        throw new Error(`Failed to terminate owned Chrome process PID ${proc.pid} within ${deadlineMs}ms`);
      }
    }
    this.childProcess = null;
    this.isOwnedProcess = false;
    this.isAttachedTarget = false;
  }
}

