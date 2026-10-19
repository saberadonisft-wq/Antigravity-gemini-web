import {
  type LauncherClient, type RuntimeEvent, type UiError,
  RuntimeSnapshotSchema, CommandAckSchema, OperationRecordSchema, SessionSummarySchema,
  ActivityEntrySchema, RuntimeEventSchema, UiErrorSchema, createPageSchema, safeUiError,
  NativeManagementSnapshotSchema,NativeManagementCommandSchema,
  KnowledgeSnapshotSchema,KnowledgeUiCommandSchema,KnowledgeImportIntentSchema,
} from "@antigravity-gemini-web/contracts";

export interface IpcInvoker {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}
export function createPreloadClient(invoker: IpcInvoker): LauncherClient {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  let subscribed = false;
  let queue: Promise<void> = Promise.resolve();
  let subscriptionError: UiError | undefined;
  async function call(channel: string, ...args: unknown[]): Promise<unknown> {
    const reply = await invoker.invoke(channel, ...args);
    if (!reply || typeof reply !== "object" || !("ok" in reply)) throw safeUiError({ code: "CONTRACT_MISMATCH" });
    if (reply.ok === false && "error" in reply) throw UiErrorSchema.parse(reply.error);
    if (reply.ok !== true || !("value" in reply)) throw safeUiError({ code: "CONTRACT_MISMATCH" });
    return reply.value;
  }
  function schedule(): Promise<void> {
    queue = queue.catch(() => {}).then(async () => {
      const desired = listeners.size > 0;
      if (desired !== subscribed) {
        await call(desired ? "launcher:subscribe" : "launcher:unsubscribe");
        subscribed = desired;
      }
      subscriptionError = undefined;
    });
    queue.catch(error => { subscriptionError = safeUiError(error); });
    return queue;
  }
  const channelListener = (_event: unknown, raw: unknown) => {
    const result = RuntimeEventSchema.safeParse(raw);
    if (!result.success) { subscriptionError = safeUiError({ code: "CONTRACT_MISMATCH" }); return; }
    for (const listener of listeners) { try { listener(structuredClone(result.data)); } catch {} }
  };
  return {
    async getNativeKnowledge(){return KnowledgeSnapshotSchema.parse(await call("launcher:getNativeKnowledge"));},
    async executeNativeKnowledge(command){return KnowledgeSnapshotSchema.parse(await call("launcher:executeNativeKnowledge",KnowledgeUiCommandSchema.parse(command)));},
    async importNativeKnowledge(intent){return KnowledgeSnapshotSchema.parse(await call("launcher:importNativeKnowledge",KnowledgeImportIntentSchema.parse(intent)));},
    async getNativeAccounts(){return NativeManagementSnapshotSchema.parse(await call("launcher:getNativeAccounts"));},
    async executeNativeAccount(command){return NativeManagementSnapshotSchema.parse(await call("launcher:executeNativeAccount",NativeManagementCommandSchema.parse(command)));},
    async getSnapshot() {
      if (listeners.size) await schedule(); // handshake subscription before establishing the snapshot
      if (subscriptionError) throw subscriptionError;
      return RuntimeSnapshotSchema.parse(await call("launcher:getSnapshot"));
    },
    async execute(command) { return CommandAckSchema.parse(await call("launcher:execute", command)); },
    async getOperation(id) { return OperationRecordSchema.parse(await call("launcher:getOperation", id)); },
    async getSessions(cursor) { return createPageSchema(SessionSummarySchema).parse(await call("launcher:getSessions", cursor)); },
    async getActivity(query) { return createPageSchema(ActivityEntrySchema).parse(await call("launcher:getActivity", query)); },
    subscribe(listener) {
      if (!listeners.size) invoker.on("launcher:event", channelListener);
      listeners.add(listener); schedule().catch(() => {});
      let disposed = false;
      return () => {
        if (disposed) return; disposed = true; listeners.delete(listener);
        if (!listeners.size) invoker.removeListener("launcher:event", channelListener);
        schedule().catch(() => {});
      };
    },
  };
}
