import { app, BrowserWindow, ipcMain, protocol, net, dialog } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RuntimeFacade } from "@antigravity-gemini-web/runtime";
import { createServer } from "node:net";
import { safeUiError, sanitizeDiagnostics } from "@antigravity-gemini-web/contracts";
import { IpcSecurityBridge } from "./ipc-bridge.js";
import { focusLauncherWindow } from "./window-lifecycle.js";
import { AcceptanceControls, AcceptanceBrowser } from "./acceptance-controls.js";
import { configureElectronStorage } from "./electron-storage.js";
import { NativeOwnerClient } from "./native-owner-client.js";

protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const launcherRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const assets = path.join(launcherRoot, "dist-renderer");
const smoke = process.env.AG_LAUNCHER_SMOKE === "1";
const mode = process.argv.includes("--demo") ? "demo" : "live";
let smokeSandbox: string | undefined;
if (smoke) {
  const data = path.resolve(process.env.AG_LAUNCHER_DATA_DIR ?? "");
  if (path.dirname(data).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(data).startsWith("launcher-smoke-")) throw new Error("Invalid smoke sandbox.");
  smokeSandbox = data;
}
app.setName("Antigravity Gemini Web");
configureElectronStorage(app, mode, smokeSandbox);
let runtime: RuntimeFacade | undefined;
let bridge: IpcSecurityBridge | undefined;
let window: BrowserWindow | undefined;
let quitting = false;
let quitPromise: Promise<void> | undefined;
let preloadSecurity: { sandboxed: boolean; contextIsolated: boolean } | undefined;
const registered = new Set<number>();
const acceptance = smoke ? new AcceptanceControls() : undefined;
let finishAcceptance: (() => Promise<void>) | undefined;

if (!app.requestSingleInstanceLock()) {
  app.exit(0); // No runtime exists in the secondary process; stop before Chromium opens the owner's cache.
} else {
  app.on("second-instance", () => { if (acceptance) acceptance.secondInstances++; focusLauncherWindow(window); });
  app.on("before-quit", event => {
    if (quitting) return;
    event.preventDefault();
    quitPromise ??= (async () => {
      let failed = false;
      try { bridge?.disposeAll(); } catch { failed = true; }
      try { await runtime?.stop(); } catch { failed = true; }
      try { await finishAcceptance?.(); } catch (error) { failed = true; if (smoke) console.error("Acceptance shutdown failed: " + String(error)); }
      quitting = true;
      if (failed) app.exit(1); else app.quit();
    })();
  });
  app.on("window-all-closed", () => app.quit());
  app.whenReady().then(async () => {
    if (Number(process.versions.node.split(".")[0]) < 22 || !globalThis.WebSocket || !globalThis.fetch) throw new Error("Runtime requires Node 22 APIs.");
    protocol.handle("app", request => {
      const url = new URL(request.url);
      if (url.hostname !== "local" || url.username || url.password) return new Response(null, { status: 403 });
      let decoded: string;
      try { decoded = decodeURIComponent(url.pathname); } catch { return new Response(null, { status: 400 }); }
      const fixture = smoke && decoded.startsWith("/acceptance/");
      const assetRoot = fixture ? path.join(launcherRoot, "dist-acceptance") : assets;
      const assetPath = fixture ? decoded.slice("/acceptance".length) : decoded;
      const file = path.resolve(assetRoot, "." + (assetPath === "/" ? "/index.html" : assetPath));
      const relative = path.relative(assetRoot, file);
      if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response(null, { status: 404 });
      return net.fetch(pathToFileURL(file).href);
    });
    const probePort = smoke ? await new Promise<number>((resolve, reject) => {
      const server = createServer(); server.on("error", reject);
      server.listen(0, "127.0.0.1", () => { const port = (server.address() as { port: number }).port; server.close(error => error ? reject(error) : resolve(port)); });
    }) : undefined;
    runtime = new RuntimeFacade({
      mode, appDataDir: smoke ? process.env.AG_LAUNCHER_DATA_DIR : undefined,
      liveBrowserAdapter: smoke ? new AcceptanceBrowser(acceptance!, { chromePath: path.join(process.env.AG_LAUNCHER_DATA_DIR!, "no-browser.exe"), debugPort: probePort, userDataDir: path.join(process.env.AG_LAUNCHER_DATA_DIR!, "browser_profile") }) : undefined,
      chooseExportDestination: async () => {
        if (acceptance?.pendingExport) { const pending = acceptance.pendingExport; acceptance.pendingExport = undefined; return pending.promise; }
        const language = (await runtime!.getSnapshot()).settings.language;
        const result = await dialog.showSaveDialog(window!, { title: acceptance?.nativeDialog ? "Owned G4 Save Fixture" : language === "en" ? "Export redacted activity log" : "Xuất nhật ký đã khử dữ liệu", defaultPath: acceptance?.nativeDialog?.destination ?? "activity.json", filters: [{ name: "JSON", extensions: ["json"] }], properties: ["dontAddToRecent"] });
        return result.canceled ? null : result.filePath ?? null;
      },
    });
    const nativeAccountSmoke=smoke&&process.env.AG_NATIVE_ACCOUNTS_SMOKE==="1";
    const nativeKnowledgeSmoke=nativeAccountSmoke&&process.env.AG_NATIVE_KNOWLEDGE_SMOKE==="1";
    const nativeRealChooser=nativeKnowledgeSmoke&&process.env.AG_NATIVE_KNOWLEDGE_REAL_CHOOSER==="1";
    const smokeOwnerFile=nativeAccountSmoke?path.join(smokeSandbox!,"native-owner.json"):undefined;
    const nativeAccounts=smokeOwnerFile?new NativeOwnerClient(smokeOwnerFile,JSON.parse(fs.readFileSync(smokeOwnerFile,"utf8")).endpoint):mode==="live"&&!smoke?new NativeOwnerClient():undefined;
    let knowledgeDialogOpen=false;
    bridge = new IpcSecurityBridge({ backend: runtime, nativeAccounts,nativeKnowledge:nativeAccounts,
      onImportKnowledge:nativeAccounts?async intent=>{
        if(knowledgeDialogOpen)throw {code:"BUSY"};knowledgeDialogOpen=true;
        try{
          const status=await nativeAccounts.getNativeKnowledge();
          if(status.ownerId!==intent.expectedOwnerId)throw {code:"STALE_AUTHORITY"};
          if(status.revision!==intent.expectedRevision)throw {code:"CONFIG_CONFLICT"};
          if(!status.experimentalEnabled)throw {code:"SOURCE_EXPERIMENT_DISABLED"};
          if(!status.canMutate)throw {code:"BUSY"};
          // Test-only chooser grant; renderer never controls these filesystem paths.
          const recordChooser=(type:string,count?:number)=>{if(nativeRealChooser)fs.appendFileSync(path.join(smokeSandbox!,"knowledge-real-chooser-events.jsonl"),JSON.stringify({type,count,at:new Date().toISOString()})+"\n",{mode:0o600});};
          recordChooser("open");
          const selected=nativeKnowledgeSmoke&&!nativeRealChooser?JSON.parse(fs.readFileSync(path.join(smokeSandbox!,"knowledge-dialog.json"),"utf8")):await dialog.showOpenDialog(window!,{title:(await runtime!.getSnapshot()).settings.language==="en"?"Select project reference files":"Chọn file tham chiếu dự án",properties:["openFile","multiSelections","dontAddToRecent"]});
          recordChooser(selected.canceled?"cancel":"selected",selected.filePaths?.length??0);
          if(selected.canceled||!selected.filePaths?.length)throw {code:"CANCELLED"};
          return await nativeAccounts.importSelectedKnowledgeFiles(intent,selected.filePaths);
        }finally{knowledgeDialogOpen=false;}
      }:undefined,allowedOrigins: ["app://local"], trustedSender: sender => registered.has(sender.id) });
    ipcMain.on("launcher:preload-ready", (event, flags) => {
      try {
        bridge!.validateContext({ sender: event.sender, isMainFrame: !!event.senderFrame && event.senderFrame === event.sender.mainFrame, origin: event.senderFrame?.url ?? "" });
        preloadSecurity = { sandboxed: flags.sandboxed === true, contextIsolated: flags.contextIsolated === true };
      } catch {}
    });
    for (const channel of IpcSecurityBridge.ALLOWED_CHANNELS) ipcMain.handle(channel, (event, ...args: unknown[]) => bridge!.invoke(channel, {
      sender: event.sender,
      isMainFrame: !!event.senderFrame && event.senderFrame === event.sender.mainFrame,
      origin: event.senderFrame?.url ?? "",
    }, ...args));
    window = new BrowserWindow({
      width: 1280, height: 800, minWidth: 800, minHeight: 600, show: !smoke||nativeRealChooser,
      webPreferences: { preload: path.join(launcherRoot, "dist/preload/index.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false },
    });
    registered.add(window.webContents.id);
    const content = window.webContents;
    content.setWindowOpenHandler(() => ({ action: "deny" }));
    const clipboardOrigin = (url: string) => { try { const parsed = new URL(url); return parsed.protocol === "app:" && parsed.hostname === "local" && !parsed.username && !parsed.password; } catch { return false; } };
    content.session.setPermissionRequestHandler((requester, permission, callback, details) => callback(permission === "clipboard-sanitized-write" && registered.has(requester.id) && details.isMainFrame && clipboardOrigin(details.requestingUrl)));
    content.session.setPermissionCheckHandler((requester, permission, _origin, details) => permission === "clipboard-sanitized-write" && !!requester && registered.has(requester.id) && details.isMainFrame && clipboardOrigin(details.requestingUrl ?? ""));
    content.on("will-navigate", event => event.preventDefault());
    content.on("will-attach-webview", event => event.preventDefault());
    content.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) bridge!.disposeSender(content.id); });
    content.on("destroyed", () => { registered.delete(content.id); bridge!.disposeSender(content.id); });
    const target = "app://local/index.html?mode=" + mode;
    await window.loadURL(target);
    if(nativeAccountSmoke){
      if(nativeRealChooser){
        window.setTitle("Native Knowledge - Real Chooser Acceptance");
        const { runNativeKnowledgeRealChooser }=await import("./native-knowledge-real-chooser.js");await runNativeKnowledgeRealChooser(window,smokeSandbox!);
      }else if(nativeKnowledgeSmoke){
        const { runNativeKnowledgeDesktop }=await import("./native-knowledge-desktop.js");await runNativeKnowledgeDesktop(window,runtime,smokeSandbox!);
      }else if(process.env.AG_NATIVE_LIFECYCLE_SMOKE==="1"){
        const { runNativeLifecycleDesktop }=await import("./native-lifecycle-desktop.js");await runNativeLifecycleDesktop(window,smokeSandbox!);
      }else{
        const { runNativeAccountsDesktop }=await import("./native-accounts-desktop.js");await runNativeAccountsDesktop(window,runtime,smokeSandbox!);
      }
      window.close();return;
    }
    if (smoke) {
      const { runDesktopSmoke } = await import("./desktop-smoke.js");
      await runDesktopSmoke(window, runtime, bridge, () => preloadSecurity);
      const { runDesktopUi } = await import("./desktop-ui.js");
      await runDesktopUi(runtime.appDataDir);
      const { runNativeDialogs } = await import("./native-dialog-acceptance.js");
      await runNativeDialogs(window, runtime, acceptance!, launcherRoot);
      const { runDesktopLifecycle } = await import("./desktop-lifecycle.js");
      const close = await runDesktopLifecycle(window, runtime, bridge, acceptance!, launcherRoot);
      finishAcceptance = async () => {
        close.late.resolve(close.destination);
        await new Promise<void>(resolve => setImmediate(resolve));
        const operation = await runtime!.getOperation(close.operationId);
        if (operation.state !== "outcome_unknown" || fs.existsSync(close.destination) || bridge!.subscriberCount !== 0) throw new Error("Pending close did not fence its mutation.");
        const file = path.join(runtime!.appDataDir, "desktop-lifecycle.json");
        const result = JSON.parse(fs.readFileSync(file, "utf8"));
        fs.writeFileSync(file, JSON.stringify({ ...result, pendingClose: true, noLateExport: true, subscriptionsAfterClose: 0 }, null, 2));
      };
      window.close();
    }
  }).catch(async error => {
    if (smoke) console.error(JSON.stringify(sanitizeDiagnostics({ smokeFailure: String(error?.message ?? error), stack: String(error?.stack ?? "") })));
    console.error(JSON.stringify({ error: safeUiError(error) }));
    try { await runtime?.stop(); } catch {}
    quitting = true; app.exit(1);
  });
}
