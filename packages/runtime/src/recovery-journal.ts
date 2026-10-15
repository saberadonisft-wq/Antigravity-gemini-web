import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  type JournalEntry, type UiError, JournalEntrySchema,
  isTerminalTurnState, canTransitionTurnState,
} from "@antigravity-gemini-web/contracts";
import { canonicalJson } from "./fingerprinting.js";
import { canonicalWorkspaceId } from "./context-manager.js";

export interface JournalBinding { workspaceId: string; sessionId: string; }
export interface RecoveryReport {
  totalRecovered: number;
  interruptedTurns: string[];
  unknownMutations: string[];
  activeEntries: Map<string, JournalEntry>;
  corruptLinesEncountered: number;
  replayBlocked: boolean;
}

export function mayHaveSideEffects(entry: Pick<JournalEntry, "phase" | "receipt">): boolean {
  return entry.receipt !== undefined || ["submitting", "accepted", "generating", "streaming", "tool_pending", "tool_running", "cancel_requested"].includes(entry.phase);
}

/** Single writer owned by one runtime process; synchronous commit precedes dispatch. */
export class RecoveryJournal {
  public readonly journalPath: string;
  private entries = new Map<string, JournalEntry>();
  private reconciledInstanceId?: string;
  private createdHere = false;
  private corruptLines = 0;
  private blocked = false;

  constructor(journalPath: string) { this.journalPath = path.resolve(journalPath); }

  public static hashPayload(payload: unknown): string {
    return crypto.createHash("sha256").update(typeof payload === "string" ? payload : canonicalJson(payload ?? "")).digest("hex");
  }

  private key(entry: JournalBinding & { turnId: string }): string {
    return JSON.stringify([canonicalWorkspaceId(entry.workspaceId), entry.sessionId, entry.turnId]);
  }

  public record(entry: JournalEntry): void {
    if (this.blocked || (!this.createdHere && !this.reconciledInstanceId && fs.existsSync(this.journalPath))) {
      throw { code: "OUTCOME_UNKNOWN", message: "Journal must be reconciled before mutations; corrupt evidence cannot be discarded.", retryable: false } satisfies UiError;
    }
    const parsed = JournalEntrySchema.safeParse(entry);
    if (!parsed.success) throw { code: "CONTRACT_MISMATCH", message: "Invalid journal metadata.", retryable: false } satisfies UiError;
    const validated = parsed.data;
    if (this.reconciledInstanceId && validated.instanceId !== this.reconciledInstanceId) {
      throw { code: "STALE_AUTHORITY", message: "Journal write belongs to a retired runtime.", retryable: false } satisfies UiError;
    }
    const key = this.key(validated);
    const previous = this.entries.get(key);
    if (previous) {
      if (previous.payloadHash !== validated.payloadHash || previous.requestId !== validated.requestId) {
        throw { code: "CONFIG_CONFLICT", message: "Journal identity has a conflicting payload or request.", retryable: false } satisfies UiError;
      }
      if (isTerminalTurnState(previous.phase)) {
        if (previous.phase === validated.phase) return;
        throw { code: "STALE_AUTHORITY", message: "Terminal journal outcome is immutable.", retryable: false } satisfies UiError;
      }
      if (!canTransitionTurnState(previous.phase, validated.phase)) {
        throw { code: "CONTRACT_MISMATCH", message: "Illegal journal phase transition.", retryable: false } satisfies UiError;
      }
    }
    const next = new Map(this.entries);
    next.set(key, validated);
    this.persist(next);
    this.entries = next;
    this.createdHere = true;
  }

  public get(turnId: string, binding?: JournalBinding): JournalEntry | undefined {
    if (binding) {
      const entry = this.entries.get(this.key({ ...binding, turnId }));
      return entry ? structuredClone(entry) : undefined;
    }
    const matches = this.getAll().filter(entry => entry.turnId === turnId);
    if (matches.length > 1) throw { code: "CONFIG_CONFLICT", message: "Turn identity is ambiguous without workspace/session binding.", retryable: false } satisfies UiError;
    return matches[0];
  }

  public getAll(): JournalEntry[] { return [...this.entries.values()].map(entry => structuredClone(entry)); }

  private report(): RecoveryReport {
    const entries = this.getAll();
    return {
      totalRecovered: entries.length,
      interruptedTurns: entries.filter(e => e.phase === "interrupted").map(e => e.turnId),
      unknownMutations: entries.filter(e => e.phase === "outcome_unknown").map(e => e.turnId),
      activeEntries: new Map(entries.map(e => [this.key(e), e])),
      corruptLinesEncountered: this.corruptLines,
      replayBlocked: this.blocked,
    };
  }

  public loadAndReconcile(currentInstanceId: string): RecoveryReport {
    if (!currentInstanceId.trim()) throw new TypeError("Runtime instance identity is required.");
    if (this.reconciledInstanceId) {
      if (this.reconciledInstanceId !== currentInstanceId) {
        throw { code: "CONFIG_CONFLICT", message: "A journal object can be owned by only one runtime instance.", retryable: false } satisfies UiError;
      }
      return this.report();
    }
    let raw: string;
    try { raw = fs.readFileSync(this.journalPath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.reconciledInstanceId = currentInstanceId;
        return this.report();
      }
      this.blocked = true;
      throw { code: "SERVICE_UNAVAILABLE", message: "Recovery journal is unreadable; mutations are blocked.", retryable: false } satisfies UiError;
    }

    const recovered = new Map<string, JournalEntry>();
    for (const line of raw.split(/\r?\n/).filter(line => line.trim())) {
      try {
        const entry = JournalEntrySchema.parse(JSON.parse(line));
        const key = this.key(entry);
        const previous = recovered.get(key);
        if (previous && (previous.requestId !== entry.requestId || previous.payloadHash !== entry.payloadHash ||
          (isTerminalTurnState(previous.phase) ? canonicalJson(previous) !== canonicalJson(entry) : !canTransitionTurnState(previous.phase, entry.phase)))) {
          throw new Error("Conflicting journal identity.");
        }
        recovered.set(key, entry);
      } catch { this.corruptLines++; }
    }
    for (const entry of recovered.values()) {
      // Re-reading an in-flight journal is recovery even if a caller reused its instance ID.
      if (!isTerminalTurnState(entry.phase)) {
        entry.phase = mayHaveSideEffects(entry) ? "outcome_unknown" : "interrupted";
        entry.terminalOutcome = {
          status: entry.phase, completedAt: new Date().toISOString(),
          errorCode: entry.phase === "outcome_unknown" ? "MUTATION_UNKNOWN" : "RUNTIME_DISCONNECTED",
        };
      }
    }
    this.blocked = this.blocked || this.corruptLines > 0;
    // Preserve corrupt evidence on disk so a second restart cannot forget the blocker.
    if (!this.blocked) this.persist(recovered);
    this.entries = recovered;
    this.reconciledInstanceId = currentInstanceId;
    return this.report();
  }

  private persist(entries: Map<string, JournalEntry>): void {
    const dir = path.dirname(this.journalPath);
    const tempPath = `${this.journalPath}.${crypto.randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fd = fs.openSync(tempPath, "wx", 0o600);
      fs.writeFileSync(fd, [...entries.values()].map(entry => JSON.stringify(entry)).join("\n") + "\n", "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      // Never fall back to overwriting the destination with a non-atomic copy/write.
      fs.renameSync(tempPath, this.journalPath);
    } catch {
      throw { code: "SERVICE_UNAVAILABLE", message: "Journal commit failed; mutation was not authorized.", retryable: true } satisfies UiError;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  }
}

