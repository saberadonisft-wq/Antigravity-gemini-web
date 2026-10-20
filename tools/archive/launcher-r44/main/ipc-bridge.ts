import {
  type LauncherClient, type ControlCommand, type CommandAck, type RuntimeEvent, type UiError,
  ControlCommandSchema, ActivityQuerySchema, RuntimeSnapshotSchema, CommandAckSchema,
  OperationRecordSchema, SessionSummarySchema, ActivityEntrySchema, RuntimeEventSchema, createPageSchema,
  sanitizeDiagnostics, safeUiError,
  NativeManagementCommandSchema,NativeManagementSnapshotSchema,type NativeManagementClient,
  NativeExtensionPairingIntentSchema,type NativeExtensionPairingClient,
  KnowledgeUiCommandSchema,KnowledgeImportIntentSchema,KnowledgeSnapshotSchema,type NativeKnowledgeClient,type KnowledgeImportIntent,type KnowledgeSnapshot,
  ChatImportIntentSchema,ChatImportUiCommandSchema,ChatImportSnapshotSchema,type NativeChatImportClient,type ChatImportIntent,type ChatImportSnapshot,
} from "@antigravity-gemini-web/contracts";

export interface IpcSender {
  id: number;
  send(channel: string, ...args: unknown[]): void;
  isDestroyed?(): boolean;
}
export interface IpcCallContext { sender: IpcSender; isMainFrame: boolean; origin: string; }
export interface IpcBridgeOptions {
  nativeAccounts?:NativeManagementClient;
  nativePairing?:NativeExtensionPairingClient;
  nativeKnowledge?:Pick<NativeKnowledgeClient,"getNativeKnowledge"|"executeNativeKnowledge">;
  onImportKnowledge?:(intent:KnowledgeImportIntent)=>Promise<KnowledgeSnapshot>;
  nativeChatImports?:Pick<NativeChatImportClient,"getNativeChatImports"|"executeNativeChatImport">;
  onInspectChatImport?:(intent:ChatImportIntent)=>Promise<ChatImportSnapshot>;
  allowedOrigins?: string[]; backend: LauncherClient;
  trustedSender?: (sender: IpcSender) => boolean;
  onSaveDialog?: () => Promise<string | null>;
  exportTo?: (command: Extract<ControlCommand, { type: "activity.export" }>, destination: string) => Promise<CommandAck>;
}
export type IpcReply = { ok: true; value: unknown } | { ok: false; error: UiError };

function appOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    if (url.protocol === "app:") return url.hostname === "local" && !url.port ? "app://local" : null;
    return ["http:", "https:"].includes(url.protocol) ? url.origin : null;
  } catch { return null; }
}

export class IpcSecurityBridge {
  public get subscriberCount(): number { return this.activeSubscribers.size; }
  private readonly origins: Set<string>;
  private readonly backend: LauncherClient;
  private readonly activeSubscribers = new Map<number, () => void>();
  public static readonly ALLOWED_CHANNELS = new Set([
    "launcher:getSnapshot", "launcher:execute", "launcher:getOperation",
    "launcher:getSessions", "launcher:getActivity", "launcher:subscribe", "launcher:unsubscribe",
    "launcher:getNativeAccounts", "launcher:executeNativeAccount", "launcher:copyNativeExtensionPairingCode",
    "launcher:getNativeKnowledge", "launcher:executeNativeKnowledge", "launcher:importNativeKnowledge",
    "launcher:getNativeChatImports", "launcher:inspectNativeChatImport", "launcher:executeNativeChatImport",
  ]);
  constructor(private readonly options: IpcBridgeOptions) {
    this.backend = options.backend;
    this.origins = new Set(options.allowedOrigins ?? ["app://local"]);
  }
  public validateContext(context: IpcCallContext): void {
    if (!context.isMainFrame) throw { code: "UNAUTHORIZED_FRAME", message: "Main frame required.", retryable: false } satisfies UiError;
    const origin = appOrigin(context.origin);
    if (!origin || !this.origins.has(origin)) throw { code: "UNAUTHORIZED_ORIGIN", message: "Application origin required.", retryable: false } satisfies UiError;
    if (!this.options.trustedSender?.(context.sender) || context.sender.isDestroyed?.()) {
      throw { code: "UNAUTHORIZED_SENDER", message: "Registered window required.", retryable: false } satisfies UiError;
    }
  }
  public async invoke(channel: string, context: IpcCallContext, ...args: unknown[]): Promise<IpcReply> {
    try { return { ok: true, value: await this.handleInvoke(channel, context, ...args) }; }
    catch (error) { return { ok: false, error: safeUiError(error) }; }
  }
  public async handleInvoke(channel: string, context: IpcCallContext, ...args: unknown[]): Promise<unknown> {
    if (!IpcSecurityBridge.ALLOWED_CHANNELS.has(channel)) throw { code: "UNKNOWN_CHANNEL", message: "Channel denied.", retryable: false } satisfies UiError;
    this.validateContext(context);
    const noArgs = ["launcher:getSnapshot", "launcher:subscribe", "launcher:unsubscribe", "launcher:getNativeAccounts", "launcher:getNativeKnowledge", "launcher:getNativeChatImports"].includes(channel);
    if ((noArgs && args.length) || (!noArgs && args.length > 1)) throw { code: "INVALID_ARGUMENT", message: "Invalid argument count.", retryable: false } satisfies UiError;
    switch (channel) {
      case "launcher:getNativeChatImports": {
        if(!this.options.nativeChatImports)throw safeUiError({code:"UNSUPPORTED_OPERATION"});
        return ChatImportSnapshotSchema.parse(await this.options.nativeChatImports.getNativeChatImports());
      }
      case "launcher:inspectNativeChatImport": {
        if(!this.options.onInspectChatImport)throw safeUiError({code:"UNSUPPORTED_OPERATION"});
        const intent=ChatImportIntentSchema.safeParse(args[0]);if(!intent.success)throw safeUiError({code:"CONTRACT_MISMATCH"});
        return ChatImportSnapshotSchema.parse(await this.options.onInspectChatImport(intent.data));
      }
      case "launcher:executeNativeChatImport": {
        if(!this.options.nativeChatImports)throw safeUiError({code:"UNSUPPORTED_OPERATION"});
        const command=ChatImportUiCommandSchema.safeParse(args[0]);if(!command.success)throw safeUiError({code:"CONTRACT_MISMATCH"});
        return ChatImportSnapshotSchema.parse(await this.options.nativeChatImports.executeNativeChatImport(command.data));
      }
      case "launcher:getNativeKnowledge": {
        if(!this.options.nativeKnowledge)throw safeUiError({code:"UNSUPPORTED_OPERATION"});
        return KnowledgeSnapshotSchema.parse(await this.options.nativeKnowledge.getNativeKnowledge());
      }
      case "launcher:executeNativeKnowledge": {
        if(!this.options.nativeKnowledge)throw safeUiError({code:"UNSUPPORTED_OPERATION"});
        const command=KnowledgeUiCommandSchema.safeParse(args[0]);if(!command.success)throw safeUiError({code:"CONTRACT_MISMATCH"});
        return KnowledgeSnapshotSchema.parse(await this.options.nativeKnowledge.executeNativeKnowledge(command.data));
      }
      case "launcher:importNativeKnowledge": {
        if(!this.options.onImportKnowledge)throw safeUiError({code:"UNSUPPORTED_OPERATION"});
        const intent=KnowledgeImportIntentSchema.safeParse(args[0]);if(!intent.success)throw safeUiError({code:"CONTRACT_MISMATCH"});
        return KnowledgeSnapshotSchema.parse(await this.options.onImportKnowledge(intent.data));
      }
      case "launcher:getNativeAccounts": {
        if(!this.options.nativeAccounts)throw safeUiError({code:"UNSUPPORTED_OPERATION"});
        return NativeManagementSnapshotSchema.parse(await this.options.nativeAccounts.getNativeAccounts());
      }
      case "launcher:executeNativeAccount": {
        if(!this.options.nativeAccounts)throw safeUiError({code:"UNSUPPORTED_OPERATION"});
        const parsed=NativeManagementCommandSchema.safeParse(args[0]);if(!parsed.success)throw safeUiError({code:"CONTRACT_MISMATCH"});
        return NativeManagementSnapshotSchema.parse(await this.options.nativeAccounts.executeNativeAccount(parsed.data));
      }
      case "launcher:copyNativeExtensionPairingCode": {
        if(!this.options.nativePairing)throw safeUiError({code:"UNSUPPORTED_OPERATION"});
        const intent=NativeExtensionPairingIntentSchema.safeParse(args[0]);if(!intent.success)throw safeUiError({code:"CONTRACT_MISMATCH"});
        await this.options.nativePairing.copyNativeExtensionPairingCode(intent.data);
        return {copied:true};
      }
      case "launcher:getSnapshot": return sanitizeDiagnostics(RuntimeSnapshotSchema.parse(await this.backend.getSnapshot()));
      case "launcher:execute": {
        const parsed = ControlCommandSchema.safeParse(args[0]);
        if (!parsed.success) throw { code: "CONTRACT_MISMATCH", message: "Invalid command.", retryable: false } satisfies UiError;
        const command = parsed.data;
        if (command.requestId.length > 128) throw { code: "CONTRACT_MISMATCH", message: "Request identity is too large.", retryable: false } satisfies UiError;
        if (command.type === "integration.apply" || command.type === "integration.preview" || (command.type === "runtime.check" && command.payload.scope === "end_to_end")) {
          throw { code: "NATIVE_ROUTE_UNVERIFIED", message: "Native route remains unverified.", retryable: false } satisfies UiError;
        }
        if (command.type === "model.select") throw { code: "MODEL_UNAVAILABLE", message: "No model provider.", retryable: false } satisfies UiError;
        if (command.type === "activity.export" && this.options.onSaveDialog) {
          const destination = await this.options.onSaveDialog();
          if (!destination) return { requestId: command.requestId, accepted: false, error: safeUiError({ code: "CANCELLED" }) } satisfies CommandAck;
          if (!this.options.exportTo) throw { code: "SERVICE_UNAVAILABLE", message: "No file exporter.", retryable: false } satisfies UiError;
          return sanitizeDiagnostics(CommandAckSchema.parse(await this.options.exportTo(command, destination)));
        }
        return sanitizeDiagnostics(CommandAckSchema.parse(await this.backend.execute(command)));
      }
      case "launcher:getOperation": {
        if (typeof args[0] !== "string" || !args[0] || args[0].length > 128) throw { code: "INVALID_ARGUMENT", message: "Operation identity required.", retryable: false } satisfies UiError;
        return sanitizeDiagnostics(OperationRecordSchema.parse(await this.backend.getOperation(args[0])));
      }
      case "launcher:getSessions": {
        if (args[0] !== undefined && (typeof args[0] !== "string" || args[0].length > 128)) throw { code: "INVALID_ARGUMENT", message: "Invalid cursor.", retryable: false } satisfies UiError;
        return sanitizeDiagnostics(createPageSchema(SessionSummarySchema).parse(await this.backend.getSessions(args[0] as string | undefined)));
      }
      case "launcher:getActivity": {
        const parsed = ActivityQuerySchema.safeParse(args[0] ?? {});
        if (!parsed.success) throw { code: "CONTRACT_MISMATCH", message: "Invalid activity query.", retryable: false } satisfies UiError;
        return sanitizeDiagnostics(createPageSchema(ActivityEntrySchema).parse(await this.backend.getActivity(parsed.data)));
      }
      case "launcher:subscribe": {
        this.disposeSender(context.sender.id);
        const unsubscribe = this.backend.subscribe((raw: RuntimeEvent) => {
          try {
            this.validateContext(context);
            const event = RuntimeEventSchema.parse(raw);
            context.sender.send("launcher:event", sanitizeDiagnostics(event));
          } catch { this.disposeSender(context.sender.id); }
        });
        this.activeSubscribers.set(context.sender.id, unsubscribe);
        return { subscribed: true };
      }
      case "launcher:unsubscribe": this.disposeSender(context.sender.id); return { subscribed: false };
    }
  }
  public disposeSender(id: number): void {
    const unsubscribe = this.activeSubscribers.get(id);
    this.activeSubscribers.delete(id);
    unsubscribe?.();
  }
  public disposeAll(): void {
    let failed = false;
    for (const id of [...this.activeSubscribers.keys()]) { try { this.disposeSender(id); } catch { failed = true; } }
    if (failed) throw safeUiError({ code: "SERVICE_UNAVAILABLE" });
  }
}
