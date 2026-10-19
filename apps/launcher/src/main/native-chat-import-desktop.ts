import { BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import type { RuntimeFacade } from "@antigravity-gemini-web/runtime";
import type { ChatImportSnapshot, NativeManagementSnapshot } from "@antigravity-gemini-web/contracts";

/** Owned Electron/IPC/HTTP acceptance. Chooser grant and account identities are synthetic. */
export async function runNativeChatImportDesktop(window: BrowserWindow, runtime: RuntimeFacade, directory: string) {
  const evaluate = (script: string) => window.webContents.executeJavaScript(script, true);
  async function wait(script: string) { const end = performance.now() + 12000; while (performance.now() < end) { if (await evaluate(script)) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw Error("Import UI deadline: " + script); }
  const read = () => evaluate("window.launcherClient.getNativeChatImports()") as Promise<ChatImportSnapshot>;
  const select = (id: string, value: string) => evaluate(`(()=>{const element=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  async function capture(name: string) {
    await evaluate("document.getAnimations().forEach(animation=>animation.finish());document.querySelector('.app-content').scrollTop=0");
    for (let index = 0; index < 3; index++) { window.webContents.invalidate(); await new Promise(resolve => setTimeout(resolve, 150)); const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); if (index && !image.isEmpty()) { fs.writeFileSync(path.join(directory, name), image.toPNG()); return; } }
    throw Error("Import screenshot unavailable");
  }
  const errors: string[] = []; window.webContents.on("console-message", (_event, level, message) => { if (level >= 3) errors.push(message); });
  await wait("!!document.querySelector('[data-imports-nav]')"); await evaluate("document.querySelector('[data-imports-nav]').click()");
  await wait("!!document.getElementById('chat-import-account') && !document.querySelector('[data-import-select]').disabled");
  const accounts = await evaluate("window.launcherClient.getNativeAccounts()") as NativeManagementSnapshot, [a, b] = accounts.accounts;
  const owner = JSON.parse(fs.readFileSync(path.join(directory, "native-owner.json"), "utf8"));
  assert.equal(await evaluate("typeof window.require+' '+typeof window.process"), "undefined undefined");
  assert.equal(await evaluate("Object.keys(window.launcherClient).length"), 14);
  const beforeBad = (await read()).jobs.length;
  assert.equal(await evaluate(`window.launcherClient.inspectNativeChatImport({expectedOwnerId:${JSON.stringify(accounts.ownerId)},expectedRevision:0,expectedAccountRevision:${accounts.revision},accountId:${JSON.stringify(a!.accountId)},identityEpoch:${a!.identityEpoch},provider:'chatgpt',file:'C:\\private\\arbitrary.zip'}).then(()=>false,()=>true)`), true);
  assert.equal((await read()).jobs.length, beforeBad);
  await evaluate("document.querySelector('[data-import-select]').click()"); await wait("!!document.querySelector('[data-import-state=ready]')");
  let snapshot = await read(); const first = snapshot.jobs[0]!;
  assert.equal(first.accountId, a!.accountId); assert.equal(first.identityEpoch, a!.identityEpoch); assert.equal(first.inspection?.directory.files, 2);
  assert.ok(!JSON.stringify(snapshot).includes(directory)); assert.ok(!JSON.stringify(snapshot).includes(owner.controlToken)); assert.ok(!JSON.stringify(snapshot).includes("SYNTHETIC_ARCHIVE_DATA_ONLY"));
  assert.equal(snapshot.googleSubmission, "not_submitted");
  fs.writeFileSync(path.join(directory, "imports-dialog.json"), JSON.stringify({ canceled: true, filePaths: [] }));
  await evaluate("document.querySelector('[data-import-select]').click()"); await wait("document.body.innerText.includes('Đã hủy chọn tệp')"); assert.equal((await read()).jobs.length, 1);
  fs.writeFileSync(path.join(directory, "imports-dialog.json"), JSON.stringify({ canceled: false, filePaths: [path.join(directory, "synthetic-history.zip")] }));
  const current = await evaluate("window.launcherClient.getNativeAccounts()") as NativeManagementSnapshot;
  await evaluate(`window.launcherClient.executeNativeAccount({action:'use',accountId:${JSON.stringify(b!.accountId)},expectedOwnerId:${JSON.stringify(current.ownerId)},expectedRevision:${current.revision}})`);
  await wait("!!document.querySelector('[data-import-state=stale]')");
  snapshot = await read(); assert.equal(snapshot.jobs[0]!.inspection, undefined);
  await select("chat-import-account", b!.accountId); await wait("!document.querySelector('[data-import-select]').disabled");
  await evaluate("document.querySelector('[data-import-select]').click()"); await wait("!!document.querySelector('[data-import-state=ready]')");
  snapshot = await read(); assert.ok(snapshot.jobs.some(job => job.accountId === b!.accountId && job.state === "ready"));
  window.setContentSize(1280, 900); await wait("innerWidth===1280");
  for (const theme of ["light", "dark"] as const) {
    const state = await runtime.getSnapshot(); assert.equal((await runtime.execute({ requestId: "import-ui-" + theme, type: "settings.update", payload: { expectedRevision: state.settings.revision, patch: { language: theme === "light" ? "vi" : "en", theme } } })).accepted, true);
    await wait(`document.documentElement.getAttribute('data-theme')==='${theme}'`); await capture("imports-" + theme + ".png");
  }
  assert.equal(await evaluate("document.getElementById('chat-import-title').textContent"), "Prepare chat history import");
  window.setContentSize(800, 700); await wait("innerWidth===800"); await capture("imports-800px.png");
  assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1 && document.querySelector('.app-content').scrollWidth<=document.querySelector('.app-content').clientWidth+1"), true);
  assert.equal(await evaluate("[...document.querySelectorAll('.native-imports button,.native-imports select')].filter(element=>element.checkVisibility()).every(element=>element.getBoundingClientRect().height>=43.5)"), true);
  await evaluate("document.getElementById('chat-import-account').focus()"); assert.equal(await evaluate("document.activeElement.id"), "chat-import-account");
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(directory, "native-chat-import-desktop.json"), JSON.stringify({ checkedAt: new Date().toISOString(), status: "PASS_ELECTRON_CHAT_IMPORT_PREVIEW", nativeRuntimeRevision: accounts.runtimeRevision, electron: "REAL", ipc: "REAL_SANDBOXED_PRELOAD", owner: "REAL_HTTP", archiveWorker: "REAL_WORKER_THREAD", osChooser: "SYNTHETIC_MAIN_GRANT", accountIdentity: "SYNTHETIC_REGISTERED", arbitraryRendererPathsDenied: true, selectionCancelCreatesNoJob: true, accountChangeWithdrawsPreview: true, explicitSecondAccount: true, metadataOnly: true, googleSubmission: "not_submitted", widths: [1280, 800], minimumTarget44px: true, keyboard: true, horizontalOverflow: false, rendererErrors: 0 }, null, 2) + "\n");
}
