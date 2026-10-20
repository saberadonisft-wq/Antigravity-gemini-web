import {contextBridge,ipcRenderer} from "electron";
import {NativeManagementSnapshotSchema,NativeManagementCommandSchema,NativeExtensionPairingIntentSchema,UiErrorSchema,safeUiError} from "@antigravity-gemini-web/contracts";
async function call(channel:string,...args:unknown[]){const reply=await ipcRenderer.invoke(channel,...args);if(reply?.ok===false)throw UiErrorSchema.parse(reply.error);if(reply?.ok!==true)throw safeUiError({code:"CONTRACT_MISMATCH"});return reply.value;}
contextBridge.exposeInMainWorld("launcherClient",{
 async getNativeAccounts(offset=0){return NativeManagementSnapshotSchema.parse(await call("launcher:getNativeAccounts",offset));},
 async executeNativeAccount(command:unknown){return NativeManagementSnapshotSchema.parse(await call("launcher:executeNativeAccount",NativeManagementCommandSchema.parse(command)));},
 async copyNativeExtensionPairingCode(intent:unknown){await call("launcher:copyNativeExtensionPairingCode",NativeExtensionPairingIntentSchema.parse(intent));},
});
ipcRenderer.send("launcher:preload-ready",{sandboxed:process.sandboxed,contextIsolated:process.contextIsolated});
