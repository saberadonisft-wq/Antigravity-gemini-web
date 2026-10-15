import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { GeminiBrowserAdapter, PromptTurnResponse } from "@antigravity-gemini-web/gemini-browser";
import { z } from "zod";

export const RequestId = z.string().regex(/^[a-zA-Z0-9_-]{8,96}$/);
export const MAX_BROWSER_PROMPT_CHARS = 262144;
const Receipt = z.object({ requestId: RequestId, hash: z.string().regex(/^[a-f0-9]{64}$/), phase: z.enum(["reserved", "accepted", "terminal"]) }).strict();
type Receipt = z.infer<typeof Receipt>;
type Turn = Receipt & { turnId: string; done: Promise<void>; response?: PromptTurnResponse; settled: boolean; started: boolean; cancelRequested: boolean };
export class BridgeError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

// A single process owns mutations on the shared browser. No prompt, result or credential is persisted.
export class GeminiMcpService {
  private turns = new Map<string, Turn>();
  private receipts: Receipt[];
  private busy?: string;
  private stopped = false;
  private faulted = false;
  private closing?: Promise<void>;
  private cancelPending?: Promise<unknown>;
  private epoch = randomUUID();
  constructor(public readonly browser: GeminiBrowserAdapter, private readonly ledgerFile: string) {
    try {
      this.receipts = fs.existsSync(ledgerFile) ? z.array(Receipt).max(2048).parse(JSON.parse(fs.readFileSync(ledgerFile, "utf8"))) : [];
      if (new Set(this.receipts.map(r => r.requestId)).size !== this.receipts.length) throw Error("duplicate identity");
    } catch { throw new BridgeError("LEDGER_UNAVAILABLE", "Request ledger cannot be read. No prompts will be sent."); }
  }
  private available() {
    if (this.stopped || this.faulted) throw new BridgeError("SERVICE_UNAVAILABLE", "Bridge is closed or persistence failed; no new browser actions are allowed.");
  }
  private save() {
    const temporary = this.ledgerFile + "." + randomUUID() + ".tmp";
    try {
      fs.mkdirSync(path.dirname(this.ledgerFile), { recursive: true });
      const descriptor = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(descriptor, JSON.stringify(this.receipts)); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, this.ledgerFile);
    } catch {
      this.faulted = true;
      try { fs.unlinkSync(temporary); } catch {}
      throw new BridgeError("LEDGER_UNAVAILABLE", "Request ledger could not be saved; do not resend accepted prompts.");
    }
  }
  async status() {
    this.available();
    const status = await this.browser.checkStatus();
    return {
      browserState: status.browserState, accountState: status.accountState,
      activeRequestId: this.busy ?? null, transport: "stdio", route: "mcp_browser_tool",
      nativeInference: "unverified", reverseHostTools: "not_connected", checkedAt: status.checkedAt,
      maxPromptChars: MAX_BROWSER_PROMPT_CHARS, freshConversationSupported: typeof this.browser.openFreshConversation === "function",
    };
  }
  async openBrowser() {
    this.available();
    const result = await this.browser.openBrowser();
    if (!result.opened) throw new BridgeError("BROWSER_UNAVAILABLE", "Could not open the isolated browser. Check Chrome path and profile ownership.");
    return { opened: true, ...await this.status() };
  }
  async submit(requestId: string, prompt: string, options?: { freshConversation?: boolean }) {
    this.available();
    RequestId.parse(requestId);
    z.string().min(1).max(MAX_BROWSER_PROMPT_CHARS).parse(prompt);
    const hash = createHash("sha256").update(options?.freshConversation ? "fresh-conversation\n" + prompt : prompt).digest("hex");
    const existing = this.receipts.find(r => r.requestId === requestId);
    if (existing) {
      if (existing.hash !== hash) throw new BridgeError("CONFIG_CONFLICT", "Request ID is already bound to different content.");
      if (!this.turns.has(requestId)) throw new BridgeError("OUTCOME_UNKNOWN", "Request belongs to an earlier process. Inspect Gemini history; it will not be replayed.");
      return this.result(requestId, 0);
    }
    if (this.busy || this.cancelPending) throw new BridgeError("BUSY", "Another request owns the browser. Fetch its result or cancel it first.");
    if (this.receipts.length >= 2048 || this.turns.size >= 128) throw new BridgeError("QUEUE_FULL", "Request capacity reached; identities are retained to prevent replay.");
    // Reserve synchronously and durably before any await or DOM action.
    const receipt: Receipt = { requestId, hash, phase: "reserved" };
    this.receipts.push(receipt);
    this.save();
    this.busy = requestId;
    const turn: Turn = { ...receipt, turnId: `mcp-${this.epoch}-${requestId}`, done: Promise.resolve(), settled: false, started: false, cancelRequested: false };
    this.turns.set(requestId, turn);
    turn.done = Promise.resolve().then(async () => {
      let fresh: { close(): Promise<void> } | undefined;
      try {
        this.available();
        if (options?.freshConversation) {
          if (!this.browser.openFreshConversation) throw new BridgeError("UNSUPPORTED_OPERATION", "Browser adapter cannot isolate a native conversation.");
          fresh = await this.browser.openFreshConversation();
        }
        if (turn.cancelRequested) throw new BridgeError("CANCELLED", "Cancelled before browser submission.");
        turn.started = true;
        await this.browser.submitPrompt(turn.turnId, prompt, { timeoutMs: 120000 });
        receipt.phase = "accepted"; this.save();
        const response = await this.browser.pollResponse(turn.turnId, { deadlineMs: 120000 });
        if (!turn.response) turn.response = response;
      } catch (error) {
        if (!turn.response) turn.response = {
          turnId: turn.turnId, status: error instanceof BridgeError && error.code === "CANCELLED" ? "cancelled" : "failed", text: "", completedAt: new Date().toISOString(),
          error: { code: error instanceof BridgeError ? error.code : "BROWSER_TURN_FAILED", message: "Browser request did not complete. Do not resend automatically; inspect the browser.", retryable: false },
        };
      } finally {
        if (fresh) try { await fresh.close(); } catch { this.faulted = true; }
        receipt.phase = "terminal";
        try { this.save(); } catch { /* faulted fences every future mutation */ }
        turn.settled = true;
        // Failed or uncertain generations keep ownership until bridge cleanup.
        if (turn.response?.status === "completed" || turn.response?.status === "cancelled") this.busy = undefined;
      }
    });
    return { requestId, status: "pending" as const, acceptedBy: "mcp_bridge", browserAcceptance: "pending" };
  }
  async result(requestId: string, waitMs = 0) {
    const turn = this.turns.get(requestId);
    if (!turn) throw new BridgeError(this.receipts.some(r => r.requestId === requestId) ? "OUTCOME_UNKNOWN" : "REQUEST_NOT_FOUND", "No in-memory result exists for this request; it will not be replayed.");
    if (waitMs > 0 && !turn.settled) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([turn.done, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(20000, waitMs)); })]); }
      finally { clearTimeout(timer); }
    }
    if (!turn.response || !turn.settled) return { requestId, status: "pending" as const };
    const response = turn.response;
    if (response.text.length > 131072) throw new BridgeError("RESULT_TOO_LARGE", "Result exceeds 128 KiB characters. Read it in the browser; no truncated answer is returned.");
    return { requestId, status: response.status, text: response.text, modelDetected: response.modelDetected,
      codeBlocks: response.codeBlocks,
      completedAt: response.completedAt, error: response.error ? { code: response.error.code, message: "Browser operation failed; inspect the browser before retrying." } : undefined };
  }
  async cancel(requestId: string) {
    this.available();
    const turn = this.turns.get(requestId);
    if (!turn) throw new BridgeError("REQUEST_NOT_FOUND", "Request does not belong to this bridge process.");
    if (turn.response) return { requestId, cancelled: false, status: turn.response.status };
    turn.cancelRequested = true;
    if (!turn.started) return { requestId, cancelled: true, status: "cancelled_before_submission" };
    const pending = this.browser.cancelPrompt(turn.turnId);
    this.cancelPending = pending;
    try {
      const response = await pending;
      return { requestId, cancelled: response.cancelled };
    } finally { if (this.cancelPending === pending) this.cancelPending = undefined; }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.closing = this.browser.cleanup();
    return this.closing;
  }
}
