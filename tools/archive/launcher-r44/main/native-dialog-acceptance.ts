import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type BrowserWindow } from "electron";
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";
import type { RuntimeFacade } from "@antigravity-gemini-web/runtime";
import type { AcceptanceControls } from "./acceptance-controls.js";

export async function runNativeDialogs(window: BrowserWindow, runtime: RuntimeFacade, controls: AcceptanceControls, launcherRoot: string) {
  const results = [];
  for (const action of ["save","cancel"] as const) {
    const destination = path.join(runtime.appDataDir, "native-" + action + ".json");
    controls.nativeDialog = { action, destination };
    const helper = promisify(execFile)(path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",path.join(launcherRoot,"scripts/drive-save-dialog.ps1"),"-OwnerProcessId",String(process.pid),"-Action",action,"-Destination",destination], { windowsHide:true,timeout:12000 });
    helper.catch(() => {}); // observe helper even if IPC fails first
    const ack = await window.webContents.executeJavaScript("window.launcherClient.execute({requestId:'native-dialog-" + action + "',type:'activity.export',payload:{range:'last_24h'}})", true);
    await helper;
    const deadline = Date.now() + 5000;
    let operation = await runtime.getOperation(ack.operationId);
    while (operation.state === "running" || operation.state === "queued") {
      if (Date.now() >= deadline) throw new Error("Native export operation deadline.");
      await new Promise(resolve=>setTimeout(resolve,25)); operation = await runtime.getOperation(ack.operationId);
    }
    assert.equal(operation.state, action === "save" ? "succeeded" : "failed");
    if (action === "cancel") { assert.equal(operation.error?.code,"CANCELLED"); assert.equal(fs.existsSync(destination),false); }
    else { assert.equal(JSON.parse(fs.readFileSync(destination,"utf8")).version,1); }
    assert.equal(fs.readFileSync(path.join(runtime.appDataDir,"operations.json"),"utf8").includes(destination),false);
    assert.equal(JSON.stringify(operation).includes(destination),false);
    results.push({action,nativeDialog:true,fileWritten:action==="save",typedOutcome:operation.state,pathKeptInMain:true});
    controls.nativeDialog = undefined;
  }
  fs.writeFileSync(path.join(runtime.appDataDir,"desktop-dialog.json"),JSON.stringify({ownedProcessOnly:true,results},null,2));
}
