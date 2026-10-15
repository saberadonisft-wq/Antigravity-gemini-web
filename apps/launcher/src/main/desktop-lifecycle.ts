import { type BrowserWindow } from "electron";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import type { RuntimeFacade } from "@antigravity-gemini-web/runtime";
import type { IpcSecurityBridge } from "./ipc-bridge.js";
import type { AcceptanceControls } from "./acceptance-controls.js";

export async function runDesktopLifecycle(window: BrowserWindow, runtime: RuntimeFacade, bridge: IpcSecurityBridge, controls: AcceptanceControls, launcherRoot: string) {
  const evaluate = (source: string) => window.webContents.executeJavaScript(source, true);
  const wait = async (check: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error("Desktop lifecycle deadline.");
  };
  const instance = runtime.runtimeInstanceId;
  window.show(); window.minimize();
  await wait(() => window.isMinimized());
  const secondary = spawn(process.execPath, [launcherRoot], { env: { ...process.env }, windowsHide: true, stdio: "ignore" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([new Promise<number | null>((resolve, reject) => { secondary.once("exit", resolve); secondary.once("error", reject); }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Second instance did not exit.")), 5000); })]);
    assert.equal(code, 0);
    await wait(() => controls.secondInstances === 1 && !window.isMinimized() && window.isFocused());
    assert.equal(runtime.runtimeInstanceId, instance);
    assert.equal((await runtime.getSnapshot()).runtimeInstanceId, instance);
  } finally {
    if (timer) clearTimeout(timer);
    if (secondary.exitCode === null && secondary.pid) await promisify(execFile)("taskkill", ["/F", "/T", "/PID", String(secondary.pid)], { windowsHide: true, timeout: 5000 });
    window.hide();
  }
  const browser = controls.queueBrowser();
  const browserAck = await evaluate("window.launcherClient.execute({requestId:'lifecycle-browser',type:'browser.open',payload:{}})");
  assert.equal(browserAck.accepted, true);
  assert.equal((await runtime.getOperation(browserAck.operationId)).state, "running");
  const reload = new Promise<void>(resolve => window.webContents.once("did-finish-load", () => resolve()));
  window.webContents.reload(); await reload;
  await wait(async () => await evaluate("!!window.launcherClient && !!document.querySelector('nav')"));
  await wait(() => bridge.subscriberCount === 1);
  browser.resolve();
  await wait(async () => (await runtime.getOperation(browserAck.operationId)).state === "failed");
  assert.equal(bridge.subscriberCount, 1, "Reload must retain one backend subscription");
  const blocked = controls.queueExport();
  const exportAck = await evaluate("window.launcherClient.execute({requestId:'lifecycle-export',type:'activity.export',payload:{range:'last_24h'}})");
  assert.equal(exportAck.accepted, true);
  const navigate = new Promise<void>(resolve => window.webContents.once("did-finish-load", () => resolve()));
  await window.loadURL("app://local/index.html?mode=live&navigation=owned");
  await navigate;
  await wait(async () => await evaluate("!!window.launcherClient && !!document.querySelector('nav')"));
  await wait(() => bridge.subscriberCount === 1);
  blocked.resolve(null);
  await wait(async () => (await runtime.getOperation(exportAck.operationId)).state === "failed");
  assert.equal((await runtime.getOperation(exportAck.operationId)).error?.code, "CANCELLED");
  const late = controls.queueExport();
  const lateAck = await evaluate("window.launcherClient.execute({requestId:'close-pending-export',type:'activity.export',payload:{range:'last_24h'}})");
  const destination = path.join(runtime.appDataDir, "must-not-write-after-close.json");
  fs.writeFileSync(path.join(runtime.appDataDir, "desktop-lifecycle.json"), JSON.stringify({ secondInstance: true, ownerInstance: instance, pendingBrowserReload: true, pendingExportNavigation: true, oneSubscription: true, pendingCloseOperationId: lateAck.operationId }));
  return { destination, late, operationId: lateAck.operationId as string };
}
