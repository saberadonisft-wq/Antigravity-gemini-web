import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { type UiError } from "@antigravity-gemini-web/contracts";

export function atomicWriteFile(destination: string, contents: string): void {
  const target = path.resolve(destination);
  const temporary = target + "." + crypto.randomUUID() + ".tmp";
  let fd: number | undefined;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, contents, "utf8"); fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, target);
  } catch {
    throw { code: "SERVICE_UNAVAILABLE", message: "Atomic file commit failed.", retryable: true } satisfies UiError;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export class LocalStore<T> {
  private expectedHash?: string;
  constructor(public readonly file: string, private readonly schema: z.ZodType<T>) {}
  private readRaw(): string | undefined {
    try {
      if (fs.statSync(this.file).size > 4_000_000) throw new Error("oversized");
      return fs.readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw { code: "SERVICE_UNAVAILABLE", message: "Local metadata is unreadable.", retryable: false } satisfies UiError;
    }
  }
  private hash(raw?: string): string | undefined { return raw === undefined ? undefined : crypto.createHash("sha256").update(raw).digest("hex"); }
  load(fallback: T): T {
    const raw = this.readRaw();
    this.expectedHash = this.hash(raw);
    if (raw === undefined) return structuredClone(fallback);
    try { return this.schema.parse(JSON.parse(raw)); }
    catch { throw { code: "CONTRACT_MISMATCH", message: "Local metadata is invalid; it was not overwritten.", retryable: false } satisfies UiError; }
  }
  save(value: T): void {
    const validated = this.schema.parse(value);
    if (this.hash(this.readRaw()) !== this.expectedHash) {
      throw { code: "CONFIG_CONFLICT", message: "Local metadata changed outside this runtime.", retryable: false } satisfies UiError;
    }
    const raw = JSON.stringify(validated);
    atomicWriteFile(this.file, raw);
    this.expectedHash = this.hash(raw);
  }
}
