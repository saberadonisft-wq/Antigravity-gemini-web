import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { type UiError, type IntegrationPreviewResult } from "@antigravity-gemini-web/contracts";
import { atomicWriteFile } from "./local-store.js";
import { canonicalJson } from "./fingerprinting.js";

export interface ConfigPreview {
  previewId: string;
  action: "install" | "modify" | "restore";
  summary: string;
  canApply: boolean;
  baseHash: string;
  expectedRevision: number;
  patch: Record<string, unknown>;
  patchKeys: string[];
  originalValues?: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
  applied: boolean;
  restored: boolean;
}

export interface ConfigJournalEntry {
  timestamp: string;
  previewId: string;
  action: string;
  baseHash: string;
  newHash?: string;
  touchedKeys: string[];
  redacted: true;
}

export interface ConfigTransactionOptions {
  fixtureRoot: string;
  configPath: string;
  journalPath?: string;
  defaultTtlMs?: number;
}

const SENSITIVE_KEY_PATTERN = /password|secret|token|auth|cookie|key|credential/i;

function sanitizeJournalKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).map(k => SENSITIVE_KEY_PATTERN.test(k) ? `[REDACTED_KEY]` : k);
}

export class ConfigTransactionService {
  public readonly configPath: string;
  public readonly journalPath?: string;
  public readonly defaultTtlMs: number;
  private previews = new Map<string, ConfigPreview>();
  private readonly fixtureRoot: string;
  private journalBlocked = false;

  constructor(options: ConfigTransactionOptions) {
    this.fixtureRoot = path.resolve(options.fixtureRoot);
    const relative = path.relative(path.resolve(os.tmpdir()), this.fixtureRoot);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(this.fixtureRoot)) throw { code: "INVALID_ARGUMENT", message: "An owned fixture root inside OS temp is required.", retryable: false } satisfies UiError;
    this.configPath = path.resolve(options.configPath);
    if (options.journalPath) this.journalPath = path.resolve(options.journalPath);
    this.defaultTtlMs = options.defaultTtlMs ?? 30000;
    this.validateTtl(this.defaultTtlMs);
    this.validateScope();
  }

  private validateTtl(ttl: number): void {
    if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 300000) throw { code: "INVALID_ARGUMENT", message: "Invalid preview lifetime.", retryable: false } satisfies UiError;
  }

  private validateScope(): void {
    if (this.journalBlocked) throw { code: "OUTCOME_UNKNOWN", message: "Fixture evidence requires reconciliation.", retryable: false } satisfies UiError;
    const physical = fs.realpathSync(this.fixtureRoot);
    if ((process.platform === "win32" ? physical.toLowerCase() : physical) !== (process.platform === "win32" ? this.fixtureRoot.toLowerCase() : this.fixtureRoot)) throw { code: "CONFIG_CONFLICT", message: "Fixture identity changed.", retryable: false } satisfies UiError;
    if (this.journalPath && path.relative(this.configPath, this.journalPath) === "") throw { code: "INVALID_ARGUMENT", message: "Journal and target must be separate.", retryable: false } satisfies UiError;
    for (const target of [this.configPath, ...(this.journalPath ? [this.journalPath] : [])]) {
      const relative = path.relative(this.fixtureRoot, target);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw { code: "INVALID_ARGUMENT", message: "Path is outside the fixture.", retryable: false } satisfies UiError;
      let current = this.fixtureRoot;
      for (const part of relative.split(path.sep)) {
        current = path.join(current, part);
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw { code: "CONFIG_CONFLICT", message: "Fixture links are not allowed.", retryable: false } satisfies UiError;
      }
    }
  }

  private computeHash(content: string): string {
    return crypto.createHash("sha256").update(content, "utf8").digest("hex");
  }

  private readCurrent(): { content: string; json: Record<string, unknown>; hash: string; revision: number } {
    this.validateScope();
    if (!fs.existsSync(this.configPath)) {
      throw { code: "HOST_NOT_FOUND", message: "Target configuration file does not exist.", retryable: false } satisfies UiError;
    }
    if (!fs.statSync(this.configPath).isFile() || fs.statSync(this.configPath).size > 1000000) throw { code: "CONTRACT_MISMATCH", message: "Invalid fixture target.", retryable: false } satisfies UiError;
    const content = fs.readFileSync(this.configPath, "utf8");
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(content);
    } catch {
      throw { code: "CONTRACT_MISMATCH", message: "Target configuration file is not valid JSON.", retryable: false } satisfies UiError;
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) throw { code: "CONTRACT_MISMATCH", message: "Fixture must contain a JSON object.", retryable: false } satisfies UiError;
    if (Object.hasOwn(json, "revision") && (!Number.isSafeInteger(json.revision) || (json.revision as number) < 1 || (json.revision as number) >= Number.MAX_SAFE_INTEGER)) throw { code: "CONTRACT_MISMATCH", message: "Invalid fixture revision.", retryable: false } satisfies UiError;
    const hash = this.computeHash(content);
    const revision = typeof json.revision === "number" && Number.isSafeInteger(json.revision) ? json.revision : 1;
    return { content, json, hash, revision };
  }

  private appendJournal(entry: ConfigJournalEntry): void {
    if (!this.journalPath) return;
    this.validateScope();
    let fd: number | undefined;
    try {
      if (fs.existsSync(this.journalPath) && fs.statSync(this.journalPath).size > 4000000) throw new Error("Journal capacity");
      fs.mkdirSync(path.dirname(this.journalPath), { recursive: true });
      fd = fs.openSync(this.journalPath, "a", 0o600);
      fs.writeFileSync(fd, JSON.stringify(entry) + "\n", "utf8");
      fs.fsyncSync(fd);
    } catch {
      throw { code: "SERVICE_UNAVAILABLE", message: "Fixture journal commit failed.", retryable: false } satisfies UiError;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  public async preview(
    action: "install" | "modify" | "restore",
    patch: Record<string, unknown>,
    options?: { activeTurn?: boolean; ttlMs?: number }
  ): Promise<IntegrationPreviewResult> {
    if (options?.activeTurn) {
      throw { code: "BUSY", message: "Cannot preview configuration changes during an active turn.", retryable: false } satisfies UiError;
    }

    this.validateScope();
    if (this.previews.size >= 128) throw { code: "QUEUE_FULL", message: "Fixture preview registry is full.", retryable: false } satisfies UiError;
    if (!["install", "modify", "restore"].includes(action) || !patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some(key => !/^[a-zA-Z0-9_.:-]{1,128}$/.test(key) || ["revision", "__proto__", "constructor", "prototype"].includes(key))) throw { code: "INVALID_ARGUMENT", message: "Invalid fixture patch.", retryable: false } satisfies UiError;
    const jsonValue = (value: unknown, depth = 0): void => {
      if (depth > 20) throw { code: "INVALID_ARGUMENT", message: "Patch nesting exceeded.", retryable: false } satisfies UiError;
      if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
      if (Array.isArray(value)) { value.forEach(item => jsonValue(item, depth + 1)); return; }
      if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) { Object.values(value).forEach(item => jsonValue(item, depth + 1)); return; }
      throw { code: "INVALID_ARGUMENT", message: "Patch must contain JSON values.", retryable: false } satisfies UiError;
    };
    jsonValue(patch);
    if (JSON.stringify(patch).length > 100000 || Object.keys(patch).length > 100) throw { code: "INVALID_ARGUMENT", message: "Patch capacity exceeded.", retryable: false } satisfies UiError;
    let baseHash = "";
    let expectedRevision = 1;
    let existingJson: Record<string, unknown> = {};

    if (action === "install" && !fs.existsSync(this.configPath)) {
      baseHash = this.computeHash("");
      expectedRevision = 0;
    } else {
      const current = this.readCurrent();
      baseHash = current.hash;
      expectedRevision = current.revision;
      existingJson = current.json;
    }

    const patchKeys = Object.keys(patch);
    if (patchKeys.length === 0) {
      throw { code: "INVALID_ARGUMENT", message: "Patch contains no modification keys.", retryable: false } satisfies UiError;
    }

    const previewId = crypto.randomUUID();
    const ttlMs = options?.ttlMs ?? this.defaultTtlMs;
    this.validateTtl(ttlMs);
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + ttlMs).toISOString();

    const previewRecord: ConfigPreview = {
      previewId,
      action,
      summary: `Config transaction preview for ${action} (${patchKeys.length} properties modified).`,
      canApply: true,
      baseHash,
      expectedRevision,
      patch: structuredClone(patch),
      patchKeys,
      createdAt,
      expiresAt,
      applied: false,
      restored: false,
    };

    this.appendJournal({
      timestamp: createdAt,
      previewId,
      action,
      baseHash,
      touchedKeys: sanitizeJournalKeys(patch),
      redacted: true,
    });

    this.previews.set(previewId, previewRecord);
    return {
      previewId,
      action,
      summary: previewRecord.summary,
      canApply: true,
    };
  }

  public async apply(
    previewId: string,
    options?: { confirmed?: boolean; activeTurn?: boolean }
  ): Promise<{ previewId: string; applied: boolean; revision: number; newHash: string }> {
    if (options?.activeTurn) {
      throw { code: "BUSY", message: "Cannot apply configuration changes during an active turn.", retryable: false } satisfies UiError;
    }
    if (options?.confirmed !== true) {
      throw { code: "CONFIRMATION_REQUIRED", message: "Explicit confirmation is required to apply configuration changes.", retryable: false } satisfies UiError;
    }

    const preview = this.previews.get(previewId);
    if (!preview) {
      throw { code: "HOST_NOT_FOUND", message: `Transaction preview '${previewId}' not found.`, retryable: false } satisfies UiError;
    }
    if (preview.applied) {
      throw { code: "CONFIG_CONFLICT", message: `Transaction '${previewId}' has already been applied.`, retryable: false } satisfies UiError;
    }
    if (Date.now() >= Date.parse(preview.expiresAt)) {
      throw { code: "TRANSACTION_EXPIRED", message: `Transaction preview '${previewId}' has expired.`, retryable: false } satisfies UiError;
    }

    let currentJson: Record<string, unknown> = {};
    if (fs.existsSync(this.configPath)) {
      const current = this.readCurrent();
      if (current.hash !== preview.baseHash) {
        throw { code: "CONFIG_CONFLICT", message: "External modification detected; base configuration changed since preview.", retryable: false } satisfies UiError;
      }
      currentJson = current.json;
    } else if (preview.expectedRevision !== 0) {
      throw { code: "HOST_NOT_FOUND", message: "Target configuration file disappeared.", retryable: false } satisfies UiError;
    }

    // Capture original values for surgical rollback (only owned keys)
    const originalValues: Record<string, unknown> = {};
    for (const key of preview.patchKeys) {
      if (Object.hasOwn(currentJson, key)) {
        originalValues[key] = structuredClone(currentJson[key]);
      }
    }
    preview.originalValues = originalValues;

    // Apply patch
    const nextRevision = preview.expectedRevision + 1;
    const updatedJson: Record<string, unknown> = {
      ...currentJson,
      ...preview.patch,
      revision: nextRevision,
    };

    const newContent = JSON.stringify(updatedJson, null, 2);
    this.validateScope();
    this.appendJournal({ timestamp: new Date().toISOString(), previewId, action: "apply.prepared", baseHash: preview.baseHash, newHash: this.computeHash(newContent), touchedKeys: sanitizeJournalKeys(preview.patch), redacted: true });
    atomicWriteFile(this.configPath, newContent);
    const newHash = this.computeHash(newContent);

    preview.applied = true;

    try {
    this.appendJournal({
      timestamp: new Date().toISOString(),
      previewId,
      action: preview.action,
      baseHash: preview.baseHash,
      newHash,
      touchedKeys: sanitizeJournalKeys(preview.patch),
      redacted: true,
    });
    } catch { this.journalBlocked = true; throw { code: "OUTCOME_UNKNOWN", message: "Fixture changed but terminal evidence is unavailable.", retryable: false } satisfies UiError; }


    return {
      previewId,
      applied: true,
      revision: nextRevision,
      newHash,
    };
  }

  public async restore(
    previewId: string,
    options?: { confirmed?: boolean; activeTurn?: boolean }
  ): Promise<{ previewId: string; restored: boolean; revision: number }> {
    if (options?.activeTurn) {
      throw { code: "BUSY", message: "Cannot restore configuration during an active turn.", retryable: false } satisfies UiError;
    }

    this.validateScope();
    if (options?.confirmed !== true) throw { code: "CONFIRMATION_REQUIRED", message: "Explicit restore confirmation is required.", retryable: false } satisfies UiError;
    const preview = this.previews.get(previewId);
    if (!preview || !preview.applied) {
      throw { code: "HOST_NOT_FOUND", message: `Applied transaction record for '${previewId}' not found.`, retryable: false } satisfies UiError;
    }
    if (preview.restored) {
      throw { code: "CONFIG_CONFLICT", message: `Transaction '${previewId}' has already been restored.`, retryable: false } satisfies UiError;
    }

    const current = this.readCurrent();
    const currentJson = current.json;

    for (const key of preview.patchKeys) {
      if (!Object.hasOwn(currentJson, key) || canonicalJson(currentJson[key]) !== canonicalJson(preview.patch[key])) throw { code: "CONFIG_CONFLICT", message: "An owned property was edited externally; restore was not applied.", retryable: false } satisfies UiError;
    }
    if (current.revision <= preview.expectedRevision) throw { code: "CONFIG_CONFLICT", message: "Fixture revision moved backwards.", retryable: false } satisfies UiError;

    // Surgical rollback: ONLY restore/delete keys owned by this preview
    // Any external additions or modifications to unrelated keys remain completely untouched!
    for (const key of preview.patchKeys) {
      if (preview.originalValues && Object.hasOwn(preview.originalValues, key)) {
        currentJson[key] = structuredClone(preview.originalValues[key]);
      } else {
        delete currentJson[key];
      }
    }

    const nextRevision = current.revision + 1;
    currentJson.revision = nextRevision;

    const newContent = JSON.stringify(currentJson, null, 2);
    this.appendJournal({ timestamp: new Date().toISOString(), previewId, action: "restore.prepared", baseHash: current.hash, newHash: this.computeHash(newContent), touchedKeys: sanitizeJournalKeys(preview.patch), redacted: true });
    atomicWriteFile(this.configPath, newContent);
    const newHash = this.computeHash(newContent);

    preview.restored = true;

    try {
    this.appendJournal({
      timestamp: new Date().toISOString(),
      previewId,
      action: "restore",
      baseHash: current.hash,
      newHash,
      touchedKeys: sanitizeJournalKeys(preview.patch),
      redacted: true,
    });
    } catch { this.journalBlocked = true; throw { code: "OUTCOME_UNKNOWN", message: "Fixture changed but terminal evidence is unavailable.", retryable: false } satisfies UiError; }


    return {
      previewId,
      restored: true,
      revision: nextRevision,
    };
  }
}

