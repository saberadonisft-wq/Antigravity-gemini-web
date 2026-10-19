import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AccountRegistryFileSchema, type AccountRecord, type AccountRegistryFile } from "@antigravity-gemini-web/contracts";
import { NativeRouteError } from "./native-protocol.js";
import { atomicPrivateFile, assertNoLinks } from "./installation.js";

type NewAccount = { displayName: string; profilePath: string; statePath: string; debugPort?: number; identityFingerprint?: string; browserTransport?: "cdp" | "extension" };
type AccountPatch = Partial<Pick<AccountRecord, "displayName" | "identityFingerprint" | "enabled" | "capabilities">>;
const emptyRegistry = (): AccountRegistryFile => ({ version: 1, revision: 0, activeAccountId: "", accounts: [] });
const pathKey = (value: string) => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};
const overlaps = (a: string, b: string) => a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep) || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);

/** Atomic files prevent torn writes; an exclusive lock also prevents lost updates. */
export class AccountRegistry {
  private data: AccountRegistryFile = emptyRegistry();
  private loaded = false;
  constructor(private readonly registryPath: string) { this.reload(); }

  private validate(value: unknown, writing = false): AccountRegistryFile {
    const parsed = AccountRegistryFileSchema.safeParse(value);
    if (!parsed.success) throw new NativeRouteError(writing ? "INVALID_ARGUMENT" : "INVALID_ACCOUNT_REGISTRY", "Account registry data is invalid; no changes were saved.", writing ? 400 : 503);
    const data = parsed.data;
    const names = new Set<string>(), ids = new Set<string>(), ports = new Set<number>();
    const paths: Array<{ profile: string; state: string }> = [];
    for (const account of data.accounts) {
      if (ids.has(account.accountId) || names.has(account.displayName.trim().toLowerCase())) throw new NativeRouteError("ACCOUNT_CONFLICT", "Account IDs and names must be unique.", 409);
      if (!account.displayName.trim()) throw new NativeRouteError("INVALID_ARGUMENT", "An account name is required.");
      ids.add(account.accountId); names.add(account.displayName.trim().toLowerCase());
      if (ports.has(account.debugPort)) throw new NativeRouteError("PORT_COLLISION", "CDP port is already assigned to another account.", 409);
      ports.add(account.debugPort);
      if (!path.isAbsolute(account.profilePath) || !path.isAbsolute(account.statePath)) throw new NativeRouteError("INVALID_ACCOUNT_REGISTRY", "Account directories must be absolute.", 503);
      assertNoLinks(account.profilePath); assertNoLinks(account.statePath);
      const profile = pathKey(account.profilePath), state = pathKey(account.statePath);
      if (paths.some(other => overlaps(other.profile, profile))) throw new NativeRouteError("ACCOUNT_PROFILE_CONFLICT", "Account profile directories must be isolated.", 409);
      if (overlaps(profile, state) || paths.some(other => overlaps(other.state, state) || overlaps(other.profile, state) || overlaps(other.state, profile))) throw new NativeRouteError("ACCOUNT_STATE_CONFLICT", "Account state directories must be isolated from every other profile and state directory.", 409);
      paths.push({ profile, state });
    }
    return data;
  }

  private reload(): void {
    assertNoLinks(this.registryPath);
    if (!fs.existsSync(this.registryPath)) {
      if (this.loaded) throw new NativeRouteError("INVALID_ACCOUNT_REGISTRY", "Account registry disappeared; refusing to recreate it from stale data.", 503);
      this.data = emptyRegistry(); return;
    }
    let value: unknown;
    try { value = JSON.parse(fs.readFileSync(this.registryPath, "utf8")); }
    catch { throw new NativeRouteError("INVALID_ACCOUNT_REGISTRY", "Account registry file is unreadable JSON.", 503); }
    // At most 32 records: read the file rather than relying on filesystem mtime resolution.
    this.data = this.validate(value); this.loaded = true;
  }

  private mutate<T>(change: (draft: AccountRegistryFile) => T, expectedRevision?: number): T {
    const lockPath = this.registryPath + ".lock";
    assertNoLinks(lockPath); fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    let fd: number;
    try { fd = fs.openSync(lockPath, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new NativeRouteError("ACCOUNT_REGISTRY_BUSY", "Account registry is locked by another writer. Retry after it finishes; inspect the lock owner if that process has exited.", 409);
      throw error;
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() })); fs.fsyncSync(fd);
      this.reload();
      if (expectedRevision !== undefined && expectedRevision !== this.data.revision) throw new NativeRouteError("STALE_ACCOUNT_SELECTION", "Account selection changed. Refresh before trying again.", 409);
      const draft = structuredClone(this.data), result = change(draft);
      if (JSON.stringify(draft) !== JSON.stringify(this.data)) {
        draft.revision = this.data.revision + 1;
        const validated = this.validate(draft, true);
        atomicPrivateFile(this.registryPath, JSON.stringify(validated, null, 2) + "\n");
        this.data = validated; this.loaded = true;
      }
      return structuredClone(result);
    } finally { fs.closeSync(fd); fs.unlinkSync(lockPath); }
  }

  private findIn(data: AccountRegistryFile, idOrName: string): AccountRecord {
    const account = data.accounts.find(a => a.accountId === idOrName || a.displayName.trim().toLowerCase() === idOrName.trim().toLowerCase());
    if (!account) throw new NativeRouteError("ACCOUNT_NOT_FOUND", "Account was not found in the registry.", 404);
    return account;
  }
  private selectEnabled(data: AccountRegistryFile) {
    if (!data.accounts.some(a => a.accountId === data.activeAccountId && a.enabled)) data.activeAccountId = data.accounts.find(a => a.enabled)?.accountId ?? "";
  }
  snapshot(): AccountRegistryFile { this.reload(); return structuredClone(this.data); }
  list(): AccountRecord[] { return this.snapshot().accounts; }
  get(accountId: string): AccountRecord | undefined { return this.list().find(a => a.accountId === accountId); }
  find(idOrName: string): AccountRecord | undefined { return this.list().find(a => a.accountId === idOrName || a.displayName.trim().toLowerCase() === idOrName.trim().toLowerCase()); }
  getActive(): AccountRecord | undefined { const data = this.snapshot(); return data.accounts.find(a => a.accountId === data.activeAccountId && a.enabled); }
  setActive(idOrName: string, expectedRevision?: number): AccountRecord {
    return this.mutate(data => {
      const account = this.findIn(data, idOrName);
      if (!account.enabled) throw new NativeRouteError("ACCOUNT_DISABLED", "This account is disabled.", 409);
      data.activeAccountId = account.accountId; return account;
    }, expectedRevision);
  }
  private append(data: AccountRegistryFile, params: NewAccount): AccountRecord {
    if (typeof params.profilePath !== "string" || !params.profilePath.trim() || typeof params.statePath !== "string" || !params.statePath.trim() || typeof params.displayName !== "string") throw new NativeRouteError("INVALID_ARGUMENT", "Account name, profile and state directories are required.");
    let debugPort = params.debugPort;
    if (debugPort === undefined) {
      const used = new Set(data.accounts.map(a => a.debugPort)); debugPort = 9223;
      while (used.has(debugPort) && debugPort <= 65535) debugPort++;
    }
    const now = new Date().toISOString();
    const record: AccountRecord = { accountId: "acc_" + randomUUID().replaceAll("-", "").slice(0, 16), displayName: params.displayName.trim(), profilePath: path.resolve(params.profilePath), statePath: path.resolve(params.statePath), debugPort, identityFingerprint: params.identityFingerprint, identityEpoch: params.identityFingerprint ? 1 : 0, enabled: true, capabilities: {}, createdAt: now, updatedAt: now, ...(params.browserTransport ? {browserTransport:params.browserTransport} : {}) };
    data.accounts.push(record); this.selectEnabled(data); return record;
  }
  add(params: NewAccount, expectedRevision?:number): AccountRecord { return this.mutate(data => this.append(data, params),expectedRevision); }
  update(idOrName: string, patch: AccountPatch): AccountRecord {
    return this.mutate(data => {
      const account = this.findIn(data, idOrName);
      if (patch.identityFingerprint !== undefined && patch.identityFingerprint !== account.identityFingerprint) account.identityEpoch++;
      Object.assign(account, patch); account.updatedAt = new Date().toISOString(); this.selectEnabled(data); return account;
    });
  }
  disable(idOrName: string, expectedRevision?: number): AccountRecord {
    return this.mutate(data => { const account = this.findIn(data, idOrName); account.enabled = false; account.updatedAt = new Date().toISOString(); this.selectEnabled(data); return account; }, expectedRevision);
  }
  remove(idOrName:string,expectedRevision:number):AccountRecord {
    return this.mutate(data=>{
      const account=this.findIn(data,idOrName);
      if(data.accounts.length<=1)throw new NativeRouteError("LAST_ACCOUNT","Add another account before removing the last bridge account.",409);
      if(data.activeAccountId===account.accountId)throw new NativeRouteError("ACCOUNT_SELECTED","Select a different account before removing this one.",409);
      data.accounts=data.accounts.filter(row=>row.accountId!==account.accountId);
      return account;
    },expectedRevision);
  }
  enrollIdentity(accountId: string, fingerprint: string, expectedEpoch: number): AccountRecord {
    return this.mutate(data => {
      const account = this.findIn(data, accountId);
      if (!account.enabled || account.identityEpoch !== expectedEpoch) throw new NativeRouteError("STALE_ACCOUNT_SELECTION", "Account changed during verification.", 409);
      if (account.identityFingerprint && account.identityFingerprint !== fingerprint) throw new NativeRouteError("ACCOUNT_IDENTITY_CHANGED", "The browser account does not match the registered identity.", 412);
      if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new NativeRouteError("INVALID_ARGUMENT", "Invalid identity fingerprint.");
      if (!account.identityFingerprint) { account.identityFingerprint = fingerprint; account.identityEpoch++; account.updatedAt = new Date().toISOString(); }
      return account;
    });
  }
  enable(idOrName: string, expectedRevision?: number): AccountRecord {
    return this.mutate(data => { const account = this.findIn(data, idOrName); account.enabled = true; account.updatedAt = new Date().toISOString(); this.selectEnabled(data); return account; }, expectedRevision);
  }
  ensureDefault(params: { profilePath: string; statePath: string; debugPort?: number }): AccountRecord | undefined {
    return this.mutate(data => {
      if (data.accounts.length) { this.selectEnabled(data); return data.accounts.find(a => a.accountId === data.activeAccountId && a.enabled); }
      return this.append(data, { ...params, debugPort: params.debugPort ?? 9223, displayName: "Default Account" });
    });
  }
}
