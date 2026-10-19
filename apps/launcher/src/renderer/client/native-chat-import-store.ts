import { safeUiError, type LauncherClient, type ChatImportSnapshot, type NativeManagementSnapshot, type ChatImportProvider, type UiError } from "@antigravity-gemini-web/contracts";

export interface NativeChatImportViewState { snapshot?: ChatImportSnapshot; accounts?: NativeManagementSnapshot; fresh: boolean; loading: boolean; pending?: "select" | "cancel" | "clear"; error?: UiError; notice?: "selection_cancelled" }
export class NativeChatImportStore {
  private state: NativeChatImportViewState = { fresh: false, loading: true };
  private listeners = new Set<(state: NativeChatImportViewState) => void>();
  private generation = 0; private disposed = false; private reading = false; private observedAt = 0;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly client: LauncherClient, private readonly now = () => Date.now()) {}
  get current() { return structuredClone(this.state); }
  listen(listener: (state: NativeChatImportViewState) => void) { this.listeners.add(listener); listener(this.current); return () => { this.listeners.delete(listener); }; }
  private update(patch: Partial<NativeChatImportViewState>) { if (this.disposed) return; this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(this.current); }
  private aligned(snapshot: ChatImportSnapshot, accounts: NativeManagementSnapshot) {
    if (snapshot.ownerId !== accounts.ownerId || snapshot.accountRevision !== accounts.revision) throw { code: "STALE_AUTHORITY" };
  }
  start() { void this.refresh(); this.timer = setInterval(() => { void this.refresh(); }, 1000); }
  async refresh() {
    if (this.disposed || this.reading || this.state.pending) return;
    this.reading = true; const generation = this.generation;
    try {
      if (!this.client.getNativeChatImports || !this.client.getNativeAccounts) throw { code: "UNSUPPORTED_OPERATION" };
      const [snapshot, accounts] = await Promise.all([this.client.getNativeChatImports(), this.client.getNativeAccounts()]); this.aligned(snapshot, accounts);
      if (generation === this.generation) { this.observedAt = this.now(); this.update({ snapshot, accounts, fresh: true, loading: false, error: undefined, notice: snapshot.ownerId === this.state.snapshot?.ownerId ? this.state.notice : undefined }); }
    } catch (error) { if (generation === this.generation) this.update({ fresh: false, loading: false, error: safeUiError(error), notice: undefined }); }
    finally { this.reading = false; }
  }
  private authority() {
    const age = this.now() - this.observedAt;
    if (this.disposed || this.state.pending) return;
    if (!this.state.fresh || !this.state.snapshot || !this.state.accounts || age < 0 || age > 10000) { this.update({ fresh: false, error: safeUiError({ code: "RUNTIME_DISCONNECTED" }) }); return; }
    return { snapshot: this.state.snapshot, accounts: this.state.accounts };
  }
  private async mutate(action: NonNullable<NativeChatImportViewState["pending"]>, operation: () => Promise<ChatImportSnapshot>) {
    this.generation++; const generation = this.generation; this.update({ pending: action, error: undefined, notice: undefined });
    try {
      const snapshot = await operation(), accounts = await this.client.getNativeAccounts!(); this.aligned(snapshot, accounts);
      if (!this.disposed && generation === this.generation) { this.observedAt = this.now(); this.update({ snapshot, accounts, fresh: true }); }
    } catch (error) {
      const safe = safeUiError(error);
      if (!this.disposed && generation === this.generation) this.update(safe.code === "CANCELLED" ? { notice: "selection_cancelled", error: undefined } : { fresh: false, error: safe });
    } finally { if (!this.disposed && generation === this.generation) { this.update({ pending: undefined }); await this.refresh(); } }
  }
  async inspect(accountId: string, identityEpoch: number, provider: ChatImportProvider) {
    const authority = this.authority(); if (!authority) return;
    const { snapshot, accounts } = authority, account = accounts.accounts.find(value => value.accountId === accountId);
    if (!snapshot.experimentalEnabled || !this.client.inspectNativeChatImport) { this.update({ error: safeUiError({ code: "UNSUPPORTED_OPERATION" }) }); return; }
    if (!snapshot.canInspect || !accounts.canMutate) { this.update({ error: safeUiError({ code: "BUSY" }) }); return; }
    if (!account?.enabled || !account.identityRegistered || account.identityEpoch !== identityEpoch) { this.update({ error: safeUiError({ code: "STALE_AUTHORITY" }) }); return; }
    await this.mutate("select", () => this.client.inspectNativeChatImport!({ expectedOwnerId: snapshot.ownerId, expectedRevision: snapshot.revision, expectedAccountRevision: snapshot.accountRevision, accountId, identityEpoch, provider }));
  }
  async execute(action: "cancel" | "clear", jobId: string) {
    const authority = this.authority(); if (!authority || !this.client.executeNativeChatImport) return;
    await this.mutate(action, () => this.client.executeNativeChatImport!({ action, expectedOwnerId: authority.snapshot.ownerId, jobId }));
  }
  dispose() { this.disposed = true; this.generation++; clearInterval(this.timer); this.listeners.clear(); }
}
