import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BridgeError } from "./bridge-error.js";

export const WebModelSelection = z.object({ model: z.string().min(1).max(100), effort: z.string().min(1).max(60).optional() }).strict();
const RestoreRecord = z.object({ version: z.literal(1), token: z.string().uuid(), primary: WebModelSelection, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type ModelRestoreRecord = z.infer<typeof RestoreRecord>;

/** A crash must not silently make the temporary context model the primary model. */
export class ModelRestoreJournal {
  constructor(private readonly filename: string) {}
  private checkPath() {
    for (let target = this.filename;; target = path.dirname(target)) {
      try { if (fs.lstatSync(target).isSymbolicLink()) throw Error("Linked restore path."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new BridgeError("MODEL_RESTORE_PENDING", "Model restoration metadata is unavailable; no new prompt is allowed."); }
      if (path.dirname(target) === target) break;
    }
  }
  pending(): ModelRestoreRecord | undefined {
    this.checkPath();
    try { return RestoreRecord.parse(JSON.parse(fs.readFileSync(this.filename, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new BridgeError("MODEL_RESTORE_PENDING", "Model restoration metadata is invalid; no new prompt is allowed.");
    }
  }
  begin(primary: ModelRestoreRecord["primary"], fingerprint: string): ModelRestoreRecord {
    this.checkPath();
    const record = RestoreRecord.parse({ version: 1, token: randomUUID(), primary, fingerprint });
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    let fd: number;
    try { fd = fs.openSync(this.filename, "wx", 0o600); }
    catch { throw new BridgeError("MODEL_RESTORE_PENDING", "A previous temporary model selection must be restored before another prompt."); }
    try { fs.writeFileSync(fd, JSON.stringify(record) + "\n"); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    return record;
  }
  finish(record: ModelRestoreRecord) {
    if (this.pending()?.token !== record.token) throw new BridgeError("STALE_AUTHORITY", "Temporary model restoration ownership changed.");
    fs.unlinkSync(this.filename);
  }
}
