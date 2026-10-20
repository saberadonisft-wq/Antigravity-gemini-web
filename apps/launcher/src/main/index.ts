import {app,BrowserWindow,ipcMain,protocol,net,clipboard} from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {fileURLToPath,pathToFileURL} from "node:url";
import {safeUiError} from "@antigravity-gemini-web/contracts";
import {NativeOwnerClient} from "./native-owner-client.js";
import {DesktopIpc,desktopChannels} from "./desktop-ipc.js";
import {configureElectronStorage} from "./electron-storage.js";
import {focusLauncherWindow} from "./window-lifecycle.js";
protocol.registerSchemesAsPrivileged([{scheme:"app",privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const smoke=process.env.AG_LAUNCHER_SMOKE==="1";
const sandbox=smoke?path.resolve(process.env.AG_LAUNCHER_DATA_DIR??""):undefined;
if(sandbox&&(path.dirname(sandbox).toLowerCase()!==path.resolve(os.tmpdir()).toLowerCase()||!path.basename(sandbox).startsWith("launcher-smoke-")))throw Error("Invalid smoke sandbox");
app.setName("Antigravity Gemini Web");configureElectronStorage(app,"live",sandbox);
let window:BrowserWindow|undefined;
if(!app.requestSingleInstanceLock())app.exit(0);
else{
 app.on("second-instance",()=>focusLauncherWindow(window));app.on("window-all-closed",()=>app.quit());
 app.whenReady().then(async()=>{
  const assets=path.join(root,"dist-renderer");
  protocol.handle("app",request=>{
   const url=new URL(request.url);if(url.hostname!=="local"||url.username||url.password)return new Response(null,{status:403});
   let decoded:string;try{decoded=decodeURIComponent(url.pathname);}catch{return new Response(null,{status:400});}
   const file=path.resolve(assets,"."+(decoded==="/"?"/index.html":decoded)),relative=path.relative(assets,file);
   if(relative.startsWith("..")||path.isAbsolute(relative)||!fs.existsSync(file)||!fs.statSync(file).isFile())return new Response(null,{status:404});
   return net.fetch(pathToFileURL(file).href);
  });
  const descriptor=smoke?path.join(sandbox!,"native-owner.json"):undefined;
  const endpoint=descriptor?JSON.parse(fs.readFileSync(descriptor,"utf8")).endpoint:undefined;
  const owner=new NativeOwnerClient(descriptor,endpoint);
  window=new BrowserWindow({width:1280,height:800,minWidth:800,minHeight:600,show:!smoke,webPreferences:{preload:path.join(root,"dist/preload/index.cjs"),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:false}});
  const content=window.webContents;
  const bridge=new DesktopIpc(owner,id=>id===content.id&&!content.isDestroyed(),value=>{if(smoke)fs.writeFileSync(path.join(sandbox!,"pairing-copied"),"true");else clipboard.writeText(value);});
  for(const channel of desktopChannels)ipcMain.handle(channel,(event,...args:unknown[])=>bridge.invoke(channel,{sender:event.sender,isMainFrame:!!event.senderFrame&&event.senderFrame===event.sender.mainFrame,origin:event.senderFrame?.url??""},...args));
  ipcMain.on("launcher:preload-ready",(event,flags)=>{try{bridge.validate({sender:event.sender,isMainFrame:!!event.senderFrame&&event.senderFrame===event.sender.mainFrame,origin:event.senderFrame?.url??""});if(smoke)fs.writeFileSync(path.join(sandbox!,"preload-security.json"),JSON.stringify(flags));}catch{}});
  content.setWindowOpenHandler(()=>({action:"deny"}));content.session.setPermissionRequestHandler((_requester,_permission,callback)=>callback(false));content.session.setPermissionCheckHandler(()=>false);
  content.on("will-navigate",event=>event.preventDefault());content.on("will-attach-webview",event=>event.preventDefault());
  await window.loadURL("app://local/index.html");
  if(smoke){const {runDesktopAcceptance}=await import("./desktop-acceptance.js");await runDesktopAcceptance(window,sandbox!);window.close();}
 }).catch(error=>{console.error(JSON.stringify({error:safeUiError(error)}));app.exit(1);});
}
