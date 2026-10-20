import type { NativeManagementClient, NativeExtensionPairingClient } from "@antigravity-gemini-web/contracts";
export type DesktopClient = NativeManagementClient & NativeExtensionPairingClient;
declare global { interface Window { launcherClient?:DesktopClient } }
