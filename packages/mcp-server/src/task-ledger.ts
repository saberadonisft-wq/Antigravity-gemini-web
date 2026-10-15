import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { BridgeError } from "./service.js";

const Record = z.object({ taskId: z.string().regex(/^[a-zA-Z0-9_-]{8,96}$/), workspaceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export class HostTaskLedger {
  private records: z.infer<typeof Record>[];
  private failed = false;
  constructor(private readonly file: string) {
    try {
      this.records = fs.existsSync(file) ? z.array(Record).max(2048).parse(JSON.parse(fs.readFileSync(file, "utf8"))) : [];
      if (new Set(this.records.map(r => r.taskId)).size !== this.records.length) throw Error("Duplicate task IDs");
    } catch { throw new BridgeError("LEDGER_UNAVAILABLE", "Host task receipts cannot be read. Native requests are blocked."); }
  }
  reserve(taskId: string, workspace: string) {
    if (this.failed) throw new BridgeError("LEDGER_UNAVAILABLE", "Task receipt persistence failed.");
    const workspaceHash = createHash("sha256").update(workspace).digest("hex");
    const previous = this.records.find(r => r.taskId === taskId);
    if (previous) throw new BridgeError(previous.workspaceHash === workspaceHash ? "OUTCOME_UNKNOWN" : "CONFIG_CONFLICT", "Task ID has already been used; inspect prior native actions and create a new task only with explicit intent.");
    if (this.records.length >= 2048) throw new BridgeError("QUEUE_FULL", "Host task receipt limit reached; replay identities cannot be discarded automatically.");
    const record = Record.parse({ taskId, workspaceHash });
    const temporary = this.file + "." + randomUUID() + ".tmp";
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const descriptor = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(descriptor, JSON.stringify([...this.records, record])); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, this.file); this.records.push(record);
    } catch {
      this.failed = true;
      try { fs.unlinkSync(temporary); } catch {}
      throw new BridgeError("LEDGER_UNAVAILABLE", "Host task identity could not be reserved. No native action was queued.");
    }
  }
}
