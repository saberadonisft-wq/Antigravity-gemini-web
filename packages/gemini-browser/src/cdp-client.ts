/**
 * Lightweight, zero-dependency Chrome DevTools Protocol (CDP) client
 * utilizing Node.js 22 native WebSocket and fetch.
 */

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
}

export interface CdpEvaluateResult<T = unknown> {
  result?: {
    type: string;
    value?: T;
    description?: string;
  };
  exceptionDetails?: {
    text: string;
    lineNumber: number;
    columnNumber: number;
  };
}

export class CdpCommandTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`CDP command '${method}' timed out after ${timeoutMs}ms`);
    this.name = "CdpCommandTimeoutError";
  }
}

let extensionAuth: { port: number; profileId: string; token: string } | undefined;
/** Each MCP owner is scoped to one profile. Credentials never enter target URLs. */
export function configureExtensionCdp(value?: { port: number; profileId: string; token: string }) { extensionAuth = value; }
const connectorHeaders = (port: number) => extensionAuth?.port === port ? { authorization: "Bearer " + extensionAuth.token } : undefined;

export class CdpClient {
  private ws: WebSocket | null = null;
  private messageId = 0;
  private pending = new Map<number, { resolve: (res: any) => void; reject: (err: any) => void }>();

  constructor(public readonly wsUrl: string) {}

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  async connect(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          if (this.ws) {
            try {
              this.ws.close();
            } catch {}
            this.ws = null;
          }
          reject(new Error(`CDP WebSocket connection timeout to ${this.wsUrl} after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      try {
        this.ws = new WebSocket(this.wsUrl);

        const endpoint = new URL(this.wsUrl);
        const auth = extensionAuth && endpoint.hostname === "127.0.0.1" && Number(endpoint.port) === extensionAuth.port ? extensionAuth : undefined;
        this.ws.onopen = () => {
          if (auth) { this.ws!.send(JSON.stringify({ type: "auth", role: "worker", profileId: auth.profileId, token: auth.token })); return; }
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        };

        this.ws.onerror = (evt) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            if (this.ws) {
              try {
                this.ws.close();
              } catch {}
              this.ws = null;
            }
            reject(new Error(`CDP WebSocket error on ${this.wsUrl}`));
          }
        };

        this.ws.onmessage = (evt) => {
          try {
            const data = JSON.parse(evt.data.toString());
            if (auth && !settled && data.type === "ready" && data.profileId === auth.profileId) { settled = true; clearTimeout(timer); resolve(); return; }
            if (data.id && this.pending.has(data.id)) {
              const { resolve: pResolve, reject: pReject } = this.pending.get(data.id)!;
              this.pending.delete(data.id);
              if (data.error) {
                pReject(new Error(`CDP Error ${data.error.code}: ${data.error.message}`));
              } else {
                pResolve(data.result);
              }
            }
          } catch {
            // Ignore malformed messages
          }
        };

        this.ws.onclose = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error("CDP connection closed before opening"));
          }
          for (const { reject: pReject } of this.pending.values()) {
            pReject(new Error("CDP connection closed"));
          }
          this.pending.clear();
        };
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 10000): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Cannot send CDP command '${method}': WebSocket not connected`);
    }

    const id = ++this.messageId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpCommandTimeoutError(method, timeoutMs));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      try {
        this.ws!.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async evaluate<T = unknown>(expression: string, returnByValue = true, timeoutMs = 10000): Promise<T | undefined> {
    const res = await this.send<CdpEvaluateResult<T>>("Runtime.evaluate", {
      expression,
      returnByValue,
      awaitPromise: true,
    }, timeoutMs);
    if (res.exceptionDetails) {
      throw new Error(`JavaScript Evaluation Error: ${res.exceptionDetails.text}`);
    }
    return res.result?.value;
  }

  async navigate(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
  }

  close(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    for (const { reject: pReject } of this.pending.values()) {
      try {
        pReject(new Error("CDP client closed"));
      } catch {}
    }
    this.pending.clear();
  }

  static async findTarget(debugPort: number, predicate: (t: CdpTarget) => boolean = () => true): Promise<CdpTarget | null> {
    try {
      const resp = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(2000), headers: connectorHeaders(debugPort) });
      if (!resp.ok) return null;
      const targets = (await resp.json()) as CdpTarget[];
      return targets.find(t => t.type === "page" && predicate(t)) ?? targets.find(predicate) ?? null;
    } catch {
      return null;
    }
  }

  static async confirmTargetClosed(debugPort: number, targetId: string, budgetMs = 2500): Promise<void> {
    const deadline = performance.now() + budgetMs;
    while (performance.now() < deadline) {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(1000, deadline - performance.now())))), headers: connectorHeaders(debugPort) });
      if (!response.ok) throw Error("Browser closure could not be inspected.");
      const targets = await response.json() as CdpTarget[];
      if (Array.isArray(targets) && !targets.some(target => target.id === targetId)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error("Owned target did not close within its cleanup budget.");
  }

  /** Close one known owned page without depending on any other page staying open. */
  static async closeOwnedTarget(debugPort: number, targetId: string, budgetMs = 5000): Promise<void> {
    const deadline = performance.now() + budgetMs;
    const remaining = () => {
      const value = Math.floor(deadline - performance.now());
      if (value < 1) throw Error("Owned target cleanup budget expired.");
      return value;
    };
    const version = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(Math.min(2000, remaining())), headers: connectorHeaders(debugPort) });
    if (!version.ok) throw Error("Browser control endpoint is unavailable.");
    const endpoint = new URL((await version.json() as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl);
    if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" || endpoint.port !== String(debugPort) || !endpoint.pathname.startsWith("/devtools/browser/") || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error("Browser control endpoint is invalid.");
    const control = new CdpClient(endpoint.href);
    try {
      await control.connect(Math.min(2000, remaining()));
      const targets = await control.send<{ targetInfos: Array<{ targetId: string }> }>("Target.getTargets", {}, Math.min(2000, remaining()));
      if (targets.targetInfos.some(target => target.targetId === targetId)) {
        await control.send("Target.closeTarget", { targetId }, Math.min(2000, remaining()));
      }
      await CdpClient.confirmTargetClosed(debugPort, targetId, remaining());
    } finally { control.close(); }
  }
}

