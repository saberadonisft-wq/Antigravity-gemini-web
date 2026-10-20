import type { BrowserWindow } from "electron";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** Real renderer/preload/HTTP. Browser operations belong to the isolated synthetic owner. */
export async function runDesktopAcceptance(window: BrowserWindow, directory: string) {
  const evaluate = (script: string) => window.webContents.executeJavaScript(script, true);
  const errors: string[] = [];
  window.webContents.on("console-message", (_event, level, message) => { if (level >= 3) errors.push(message); });
  async function wait(script: string) { const deadline = Date.now() + 15000; while (Date.now() < deadline) { if (await evaluate(script)) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error("Desktop condition timed out: " + script); }
  async function click(selector: string) {
    await wait(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`);
    const box = await evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:'center'});if(!element.checkVisibility())throw Error('Hidden control');const r=element.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    window.webContents.sendInputEvent({type:"mouseDown",button:"left",clickCount:1,...box});
    window.webContents.sendInputEvent({type:"mouseUp",button:"left",clickCount:1,...box});
  }
  const fill = (id: string, value: string) => evaluate(`(()=>{const input=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await wait("document.querySelectorAll('[data-native-account]').length===2");
  assert.equal(await evaluate("document.querySelectorAll('nav button').length"),3);
  assert.equal(await evaluate("document.querySelector('.native-account-add select')===null"),true);
  const initial = await evaluate("window.launcherClient.getNativeAccounts()");
  const first=initial.accounts[0].accountId;
  await click(`[data-native-account="${first}"] [data-native-action=verify]`);
  await wait("document.body.textContent.includes('vừa được kiểm tra')");
  await click(`[data-native-account="${first}"] [data-native-action=pair]`);
  await wait("document.body.textContent.includes('Đã sao chép mã ghép nối')");
  assert.equal(fs.readFileSync(path.join(directory,"pairing-copied"),"utf8"),"true");
  await click('[data-view="chats"]');
  await wait("document.querySelector('.sessions-view') && document.body.textContent.includes('owned_fixture')");
  assert.equal(await evaluate("document.querySelectorAll('.native-account-recovery').length"),1);
  await click('[data-view="connections"]');
  await wait("document.querySelector('.overview-view') && document.body.textContent.includes('Chưa khởi động')");
  assert.equal(await evaluate("document.body.textContent.includes('Gate G0')"),false);
  // All views share the same owner store; losing its descriptor invalidates them together.
  const descriptor=path.join(directory,"native-owner.json");fs.renameSync(descriptor,descriptor+".held");
  try { await click('.overview-view .page-header button');await wait("document.body.textContent.includes('Chưa kết nối được runtime')");await click('[data-view="accounts"]');await wait("document.querySelector('[data-native-action=add]')?.disabled === true"); }
  finally { fs.renameSync(descriptor+".held",descriptor); }
  await click('[data-native-action=refresh]');await wait("document.querySelector('[data-native-action=add]')?.disabled === false || document.querySelector('[data-native-action=verify]')?.disabled === false");
  await fill("native-account-name","Added extension");await click('[data-native-action=add]');
  await wait("document.querySelectorAll('[data-native-account]').length===3");
  assert.equal((await evaluate("window.launcherClient.getNativeAccounts()")).accounts[2].browserTransport,"extension");
  // Removing the selected and final account is a supported state, including retained chat retirement.
  for (const account of (await evaluate("window.launcherClient.getNativeAccounts()")).accounts) {
    await click(`[data-native-account="${account.accountId}"] [data-native-action=remove]`);
    const checkbox=`[data-native-account="${account.accountId}"] input[type=checkbox]`;
    await click(checkbox);
    await click(`[data-native-account="${account.accountId}"] [data-native-action=confirm-remove]`);
    await wait(`!document.querySelector('[data-native-account="${account.accountId}"]')`);
  }
  assert.equal((await evaluate("window.launcherClient.getNativeAccounts()")).accounts.length,0);
  await fill("native-account-name","Final account");await click('[data-native-action=add]');await wait("document.querySelectorAll('[data-native-account]').length===1");
  for(const width of [1280,800]) {
    window.setContentSize(width,800);await new Promise(resolve=>setTimeout(resolve,200));
    assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1 && document.querySelector('.app-content').scrollWidth<=document.querySelector('.app-content').clientWidth+1"),true);
    assert.equal(await evaluate("[...document.querySelectorAll('button')].filter(e=>e.checkVisibility()).every(e=>e.getBoundingClientRect().height>=44)"),true);
    window.webContents.invalidate();await new Promise(resolve=>setTimeout(resolve,150));
    fs.writeFileSync(path.join(directory,`desktop-${width}.png`),(await window.webContents.capturePage()).toPNG());
  }
  const security=JSON.parse(fs.readFileSync(path.join(directory,"preload-security.json"),"utf8"));assert.equal(security.sandboxed,true);assert.equal(security.contextIsolated,true);
  assert.equal(await evaluate("Object.keys(window.launcherClient).length"),3);
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(directory,"native-accounts-desktop.json"),JSON.stringify({status:"PASS",runtimeRevision:initial.runtimeRevision,threeViews:true,sharedOwner:true,savedChatMetadata:true,deleteSelectedAndLast:true,extensionOnlyAdd:true,isolatedPreload:security,realGoogleRequests:0,browser:"SYNTHETIC",widths:[1280,800],rendererErrors:errors.length},null,2));
}
