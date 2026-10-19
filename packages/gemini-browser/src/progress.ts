export interface BrowserModelSelection { model: string; effort?: string }
export interface BrowserProgress {
  revision: number;
  elapsedMs: number;
  silentMs: number;
  stage: "waiting" | "generating" | "responding";
  text: string;
  codeBlocks?: string[];
}
export interface BrowserPollOptions {
  deadlineMs?: number;
  stallTimeoutMs?: number;
  onProgress?: (progress: BrowserProgress) => void;
  signal?: AbortSignal;
}
export interface BrowserConversationLease {
  /** Exact canonical Gemini URL captured at the latest authoritative idle checkpoint. */
  readonly conversationUrl?: string;
  close(): Promise<void>;
  /** Retire automation authority but leave an idle tab visible for inspection. */
  preserve?(): Promise<void>;
  suspend?(): Promise<void>;
  resume?(): Promise<void>;
}

/** Activity resets the idle budget; transport heartbeats never call this clock. */
export class ProgressDeadline {
  private lastActivity: number;
  constructor(readonly startedAt: number, readonly maxDurationMs: number, readonly stallTimeoutMs: number) {
    for (const value of [maxDurationMs, stallTimeoutMs]) if (!Number.isFinite(value) || value <= 0) throw Error("Invalid progress deadline.");
    this.lastActivity = startedAt;
  }
  activity(now: number) { this.lastActivity = now; }
  silentMs(now: number) { return Math.max(0, now - this.lastActivity); }
  remaining(now: number) { return Math.max(0, Math.min(this.maxDurationMs - (now - this.startedAt), this.stallTimeoutMs - this.silentMs(now))); }
  expired(now: number) { return this.remaining(now) <= 0; }
}
