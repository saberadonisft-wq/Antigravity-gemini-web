import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { ChatImportInspectionSchema, ChatImportSnapshotSchema, CHAT_IMPORT_MAX_ARCHIVE_BYTES, type AccountRegistryFile, type AccountRecord, type ChatImportJob, type ChatImportIntent, type ChatImportSnapshot, type ChatImportInspection, type ChatImportUiCommand } from "@antigravity-gemini-web/contracts";
import { NativeRouteError, canonical, object } from "./native-protocol.js";

const targetKey = (account: AccountRecord) => canonical({ enabled: account.enabled, profile: account.profilePath, state: account.statePath, port: account.debugPort, fingerprint: account.identityFingerprint, epoch: account.identityEpoch });
type Job = { view: ChatImportJob; accountRevision: number; target: string; started: number; file?: string; worker?: Worker; done?: Promise<void>; result?: ChatImportInspection; failure?: string };

/** Session-only local inspection. No archive bytes or paths enter public status. */
export class NativeChatImportJobs {
  private jobs = new Map<string, Job>();
  private running = new Set<string>();
  private revision = 0;
  private closing = false;
  private shutdown?: Promise<void>;
  constructor(private readonly registry: () => AccountRegistryFile, private readonly ownerId: string, private readonly now = () => performance.now()) {}
  private changed() { this.revision++; }
  private stop(job: Job, state: "cancelling" | "stale" | "expired", code?: string) {
    job.view.state = state; job.view.inspection = undefined; job.result = undefined; job.file = undefined; job.view.errorCode = code;
    if (job.worker && this.running.has(job.view.jobId)) void job.worker.terminate().catch(() => {});
    this.changed();
  }
  private validateTargets(registry: AccountRegistryFile) {
    for (const job of this.jobs.values()) {
      if (["cancelled", "failed", "stale", "expired"].includes(job.view.state)) continue;
      const account = registry.accounts.find(value => value.accountId === job.view.accountId);
      if (!account || registry.revision !== job.accountRevision || targetKey(account) !== job.target) this.stop(job, "stale", "IMPORT_TARGET_CHANGED");
      else if (this.now() - job.started >= 15 * 60 * 1000) this.stop(job, "expired", "IMPORT_PREVIEW_EXPIRED");
    }
  }
  snapshot(enabled: boolean, idle: boolean): ChatImportSnapshot {
    const registry = this.registry(); this.validateTargets(registry);
    return ChatImportSnapshotSchema.parse({ service: "gemini-native-chat-import", version: 1, ownerId: this.ownerId, revision: this.revision, accountRevision: registry.revision,
      experimentalEnabled: enabled, canInspect: enabled && idle && !this.closing && !this.running.size, inspectionActive: !!this.running.size,
      jobs: [...this.jobs.values()].map(job => structuredClone(job.view)), googleSubmission: "not_submitted" });
  }
  inspect(intent: ChatImportIntent, file: string, enabled: boolean, idle: boolean) {
    const snapshot = this.snapshot(enabled, idle), registry = this.registry();
    if (intent.expectedOwnerId !== this.ownerId) throw new NativeRouteError("STALE_AUTHORITY", "Native owner changed; refresh import status.", 409);
    if (intent.expectedRevision !== this.revision || intent.expectedAccountRevision !== registry.revision) throw new NativeRouteError("SOURCE_CONFIG_CONFLICT", "Import target changed; select the file again.", 409);
    if (!snapshot.canInspect) throw new NativeRouteError(enabled ? "BUSY" : "IMPORT_EXPERIMENT_DISABLED", "Local import inspection is not available for this owner state.", 409);
    const account = registry.accounts.find(value => value.accountId === intent.accountId);
    if (!account?.enabled || !account.identityFingerprint || account.identityEpoch !== intent.identityEpoch) throw new NativeRouteError("STALE_AUTHORITY", "Select a registered account identity before inspecting an archive.", 409);
    if (!path.isAbsolute(file)) throw new NativeRouteError("INVALID_ARGUMENT", "A main-process file selection is required.");
    while (this.jobs.size >= 8) { const oldest = this.jobs.keys().next().value!; this.jobs.delete(oldest); }
    const job: Job = { accountRevision: registry.revision, target: targetKey(account), started: this.now(), file, view: { jobId: randomUUID(), accountId: account.accountId, identityEpoch: account.identityEpoch, declaredProvider: intent.provider, state: "checking", bytesRead: 0, totalBytes: 0, createdAt: new Date().toISOString() } };
    this.jobs.set(job.view.jobId, job); this.changed();
    try {
      const worker = new Worker(new URL("./chat-import-worker.js", import.meta.url), { name: "chat-import-inspection", workerData: { file, provider: intent.provider }, execArgv: [], env: { ...process.env, NODE_OPTIONS: "" }, trackUnmanagedFds: true, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8 }, stdout: true, stderr: true });
      job.worker = worker; this.running.add(job.view.jobId); worker.stdout?.resume(); worker.stderr?.resume();
      worker.on("message", message => {
        if (job.view.state !== "checking" || !object(message)) return;
        if (message.kind === "progress" && Number.isSafeInteger(message.bytesRead) && Number.isSafeInteger(message.totalBytes) && (message.bytesRead as number) >= job.view.bytesRead && (message.totalBytes as number) <= CHAT_IMPORT_MAX_ARCHIVE_BYTES && (message.bytesRead as number) <= (message.totalBytes as number)) {
          job.view.bytesRead = message.bytesRead as number; job.view.totalBytes = message.totalBytes as number;
        } else if (message.kind === "complete") {
          const result = ChatImportInspectionSchema.safeParse(message.result);
          if (result.success && result.data.declaredProvider === job.view.declaredProvider && result.data.bytes === job.view.bytesRead && result.data.bytes === job.view.totalBytes) job.result = result.data;
          else job.failure = "IMPORT_INSPECTION_FAILED";
        } else if (message.kind === "failed") job.failure = typeof message.code === "string" && /^IMPORT_[A-Z_]{1,70}$/.test(message.code) ? message.code : "IMPORT_INSPECTION_FAILED";
      });
      worker.once("error", () => { job.failure = "IMPORT_INSPECTION_FAILED"; });
      job.done = new Promise(resolve => worker.once("exit", code => {
        this.running.delete(job.view.jobId); job.worker = undefined;
        try { this.validateTargets(this.registry()); } catch { job.view.state = "stale"; job.view.errorCode = "IMPORT_TARGET_CHANGED"; }
        if (job.view.state === "cancelling") job.view.state = "cancelled";
        else if (job.view.state === "checking") {
          if (code === 0 && job.result && !job.failure) { job.view.state = "ready"; job.view.inspection = job.result; }
          else { job.view.state = "failed"; job.view.errorCode = job.failure ?? "IMPORT_INSPECTION_FAILED"; }
        }
        if (job.view.state !== "ready") job.file = undefined;
        job.result = undefined; job.view.finishedAt = new Date().toISOString(); this.changed(); resolve();
      }));
    } catch { job.file = undefined; job.view.state = "failed"; job.view.errorCode = "IMPORT_INSPECTION_FAILED"; job.view.finishedAt = new Date().toISOString(); this.changed(); }
    return this.snapshot(enabled, idle);
  }
  execute(command: ChatImportUiCommand) {
    if (command.expectedOwnerId !== this.ownerId) throw new NativeRouteError("STALE_AUTHORITY", "Native owner changed; refresh import status.", 409);
    const job = this.jobs.get(command.jobId);
    if (!job) throw new NativeRouteError("REQUEST_NOT_FOUND", "The local inspection is no longer available.", 404);
    if (command.action === "cancel") { if (job.view.state === "checking") this.stop(job, "cancelling"); }
    else {
      if (this.running.has(command.jobId)) throw new NativeRouteError("BUSY", "Wait for the inspection worker to exit before removing its preview.", 409);
      this.jobs.delete(command.jobId); this.changed();
    }
  }
  close() {
    if (!this.shutdown) {
      this.closing = true; for (const job of this.jobs.values()) { job.file = undefined; if (this.running.has(job.view.jobId)) this.stop(job, "cancelling"); }
      this.shutdown = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([Promise.allSettled([...this.jobs.values()].map(job => job.done)), new Promise((_, reject) => { timer = setTimeout(() => reject(new NativeRouteError("IMPORT_INSPECTION_SHUTDOWN_PENDING", "An inspection worker has not exited.", 503)), 5000); })]); }
        finally { clearTimeout(timer); }
      })();
    }
    return this.shutdown;
  }
}
