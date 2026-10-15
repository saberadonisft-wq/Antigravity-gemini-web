import { spawn, type ChildProcess } from "node:child_process";
import { CdpClient, type CdpTarget } from "./cdp-client.js";
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

  public isOwnedProcess = false;
  public isAttachedTarget = false;
  private opening?: Promise<boolean>;
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
    // 1. Check if an allowed Chrome CDP page target is already open
    let target = await CdpClient.findTarget(this.debugPort, (t) => this.isTargetAllowed(t));
    if (epoch !== this.lifecycleEpoch || this.closing) return false;

    if (target?.webSocketDebuggerUrl) {
      this.isAttachedTarget = !this.isOwnedProcess;
    } else {
      // 2. If not running, spawn Chrome as an owned process
      const args = [
        `--remote-debugging-port=${this.debugPort}`,
        `--user-data-dir=${this.userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
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
    return true;
  }

  async attachToExistingWs(wsUrl: string): Promise<void> {
    if (this.closing) throw new Error("Browser cleanup is in progress");
    this.isAttachedTarget = !this.isOwnedProcess;
    this.cdp?.close();
    this.cdp = new CdpClient(wsUrl);
    await this.cdp.connect();
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

  async inputPrompt(text: string): Promise<boolean> {
    if (!this.cdp) {
      throw new Error("Browser driver is not connected");
    }

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

        if (composer.tagName.toLowerCase() === 'textarea') {
          composer.value = ${JSON.stringify(text)};
          composer.dispatchEvent(new Event('input', { bubbles: true }));
          composer.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          composer.innerText = ${JSON.stringify(text)};
          composer.textContent = ${JSON.stringify(text)};
          composer.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      })()
    `;

    const ok = await this.cdp.evaluate<boolean>(script);
    return Boolean(ok);
  }

  async clickSend(): Promise<boolean> {
    if (!this.cdp) {
      throw new Error("Browser driver is not connected");
    }

    const script = `
      (() => {
        const inspection = ${getDomInspectionSnippet({ fixtureMode: this.fixtureMode, allowedOrigins: this.allowedOrigins })};
        if (!inspection.isAllowedSurface || inspection.accountState !== 'signed_in' || inspection.isGenerating) return false;
        const btn = document.querySelector("${GEMINI_SELECTORS.SEND_BUTTON}");
        if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true' || getComputedStyle(btn).display === 'none' || getComputedStyle(btn).visibility === 'hidden') return false;
        btn.click();
        return true;
      })()
    `;

    const ok = await this.cdp.evaluate<boolean>(script);
    return Boolean(ok);
  }

  async clickStop(timeoutMs = 2000): Promise<boolean> {
    if (!this.cdp) {
      throw new Error("Browser driver is not connected");
    }

    const script = `
      (() => {
        const inspection = ${getDomInspectionSnippet({ fixtureMode: this.fixtureMode, allowedOrigins: this.allowedOrigins })};
        if (!inspection.isAllowedSurface || !inspection.isGenerating) return false;
        const btn = document.querySelector("${GEMINI_SELECTORS.STOP_BUTTON}");
        if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true' || getComputedStyle(btn).display === 'none' || getComputedStyle(btn).visibility === 'hidden') return false;
        btn.click();
        return true;
      })()
    `;

    const ok = await this.cdp.evaluate<boolean>(script, true, timeoutMs);
    return Boolean(ok);
  }

  async pollForResponse(initialCount: number, timeoutMs = 30000): Promise<{ text: string; completed: boolean; cancelled: boolean; hasCodeBlock: boolean; codeBlocks?: string[] }> {
    const deadline = performance.now() + timeoutMs;
    let lastText = "";
    let hasCode = false;

    while (performance.now() < deadline) {
      const dom = await this.inspectDom(Math.max(1, Math.min(10000, deadline - performance.now())));

      // Check if a new response container appeared
      if (dom.responseCount > initialCount) {
        lastText = dom.lastResponseText;
        hasCode = dom.hasCodeBlock;

        // If stop button disappeared, generation has completed!
        if (!dom.isGenerating && lastText.length > 0) {
          return {
            text: lastText,
            completed: true,
            cancelled: false,
            hasCodeBlock: hasCode,
            codeBlocks: dom.lastResponseCodeBlocks,
          };
        }
      }

      await new Promise((r) => setTimeout(r, Math.max(0, Math.min(200, deadline - performance.now()))));
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

  private async performClose(deadlineMs: number): Promise<void> {
    const deadline = performance.now() + deadlineMs;
    const isOwned = this.isOwnedProcess;
    const proc = this.childProcess;

    if (this.cdp) {
      if (isOwned) {
        try {
          await this.cdp.send("Browser.close", {}, Math.max(1, Math.min(2000, deadline - performance.now()))).catch(() => {});
        } catch {}
      }
      this.cdp.close();
      this.cdp = null;
    }

    if (isOwned && proc && proc.exitCode === null && proc.pid) {
      try {
        proc.kill("SIGTERM");
      } catch {}
      if (process.platform === "win32") {
        try {
          const { execSync } = await import("node:child_process");
          execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: "ignore", timeout: Math.max(1, Math.min(3000, Math.floor(deadline - performance.now()))) });
        } catch {}
      }
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

