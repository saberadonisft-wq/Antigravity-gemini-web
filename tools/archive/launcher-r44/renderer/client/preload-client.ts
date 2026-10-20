import type {
  LauncherClient,
  RuntimeSnapshot,
  ControlCommand,
  CommandAck,
  OperationRecord,
  SessionSummary,
  ActivityQuery,
  ActivityEntry,
  RuntimeEvent,
  Page,
  UiError,
} from "@antigravity-gemini-web/contracts";

declare global {
  interface Window {
    launcherClient?: LauncherClient;
  }
}

export function isPreloadAvailable(): boolean {
  return typeof window !== "undefined" && !!window.launcherClient && ["getSnapshot", "execute", "getOperation", "getSessions", "getActivity", "subscribe"].every(method => typeof (window.launcherClient as unknown as Record<string, unknown>)[method] === "function");
}

export function getPreloadClient(): LauncherClient {
  if (!isPreloadAvailable()) {
    const error: UiError = {
      code: "PRELOAD_UNAVAILABLE",
      message: "Preload IPC interface is not detected. Live desktop mode requires running inside Electron with contextIsolation enabled.",
      retryable: false,
      suggestedAction: "review_integration",
    };
    throw error;
  }

  const rawClient = window.launcherClient!;

  return {
    ...(rawClient.getNativeChatImports&&rawClient.inspectNativeChatImport&&rawClient.executeNativeChatImport?{
      getNativeChatImports:rawClient.getNativeChatImports.bind(rawClient),
      inspectNativeChatImport:rawClient.inspectNativeChatImport.bind(rawClient),
      executeNativeChatImport:rawClient.executeNativeChatImport.bind(rawClient),
    }:{}),
    ...(rawClient.getNativeKnowledge&&rawClient.executeNativeKnowledge&&rawClient.importNativeKnowledge?{
      getNativeKnowledge:()=>rawClient.getNativeKnowledge!(),
      executeNativeKnowledge:rawClient.executeNativeKnowledge.bind(rawClient),
      importNativeKnowledge:rawClient.importNativeKnowledge.bind(rawClient),
    }:{}),
    ...(rawClient.getNativeAccounts&&rawClient.executeNativeAccount?{
      getNativeAccounts:()=>rawClient.getNativeAccounts!(),
      executeNativeAccount:rawClient.executeNativeAccount.bind(rawClient),
    }:{}),
    ...(rawClient.copyNativeExtensionPairingCode?{copyNativeExtensionPairingCode:rawClient.copyNativeExtensionPairingCode.bind(rawClient)}:{}),
    async getSnapshot(): Promise<RuntimeSnapshot> {
      if (!isPreloadAvailable()) throw new Error("Preload IPC disconnected.");
      return rawClient.getSnapshot();
    },
    async execute(command: ControlCommand): Promise<CommandAck> {
      if (!isPreloadAvailable()) throw new Error("Preload IPC disconnected.");
      return rawClient.execute(command);
    },
    async getOperation(operationId: string): Promise<OperationRecord> {
      if (!isPreloadAvailable()) throw new Error("Preload IPC disconnected.");
      return rawClient.getOperation(operationId);
    },
    async getSessions(cursor?: string): Promise<Page<SessionSummary>> {
      if (!isPreloadAvailable()) throw new Error("Preload IPC disconnected.");
      return rawClient.getSessions(cursor);
    },
    async getActivity(query: ActivityQuery): Promise<Page<ActivityEntry>> {
      if (!isPreloadAvailable()) throw new Error("Preload IPC disconnected.");
      return rawClient.getActivity(query);
    },
    subscribe(onEvent: (event: RuntimeEvent) => void): () => void {
      if (!isPreloadAvailable()) throw new Error("Preload IPC disconnected.");
      return rawClient.subscribe(onEvent);
    },
  };
}

