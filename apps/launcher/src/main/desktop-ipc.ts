import { NativeManagementCommandSchema, NativeManagementSnapshotSchema, NativeExtensionPairingIntentSchema, safeUiError } from "@antigravity-gemini-web/contracts";
import type { NativeOwnerClient } from "./native-owner-client.js";
export interface IpcCallContext { sender:{id:number;isDestroyed?:()=>boolean};isMainFrame:boolean;origin:string }

export const desktopChannels = ["launcher:getNativeAccounts", "launcher:executeNativeAccount", "launcher:copyNativeExtensionPairingCode"] as const;
/** Production IPC surface: three bounded native-owner operations only. */
export class DesktopIpc {
  constructor(private readonly client: Pick<NativeOwnerClient,"getNativeAccounts"|"executeNativeAccount"|"createNativeExtensionPairingCode">, private readonly trusted: (id: number) => boolean, private readonly copy: (value: string) => void) {}
  validate(context: IpcCallContext) {
    const url = new URL(context.origin);
    if (!context.isMainFrame) throw { code: "UNAUTHORIZED_FRAME" };
    if (url.protocol !== "app:" || url.hostname !== "local" || url.port || url.username || url.password) throw { code: "UNAUTHORIZED_ORIGIN" };
    if (!this.trusted(context.sender.id) || context.sender.isDestroyed?.()) throw { code: "UNAUTHORIZED_SENDER" };
  }
  async invoke(channel: string, context: IpcCallContext, ...args: unknown[]) {
    try {
      this.validate(context);
      if (!(desktopChannels as readonly string[]).includes(channel)) throw { code: "UNKNOWN_CHANNEL" };
      if (args.length > 1) throw { code: "INVALID_ARGUMENT" };
      if (channel === "launcher:getNativeAccounts") {
        const offset = args[0] ?? 0;
        if (!Number.isInteger(offset) || (offset as number) < 0 || (offset as number) > 2048) throw { code: "INVALID_ARGUMENT" };
        return { ok: true, value: NativeManagementSnapshotSchema.parse(await this.client.getNativeAccounts(offset as number)) };
      }
      if (channel === "launcher:executeNativeAccount") return { ok: true, value: NativeManagementSnapshotSchema.parse(await this.client.executeNativeAccount(NativeManagementCommandSchema.parse(args[0]))) };
      const code = await this.client.createNativeExtensionPairingCode(NativeExtensionPairingIntentSchema.parse(args[0]));
      // Never put the pairing secret in an IPC response or renderer state.
      this.copy(code);
      return { ok: true, value: { copied: true } };
    } catch (error) { return { ok: false, error: safeUiError(error) }; }
  }
}
