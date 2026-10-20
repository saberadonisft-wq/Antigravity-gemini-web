import { BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { NativeManagementSnapshot } from "@antigravity-gemini-web/contracts";

/** Smoke-only UI driver. Its filesystem controller targets owned synthetic children. */
export async function runNativeLifecycleDesktop(window:BrowserWindow,root:string){
  const evaluate=(source:string)=>window.webContents.executeJavaScript(source,true);
  const options=JSON.parse(fs.readFileSync(path.join(root,"lifecycle-options.json"),"utf8"));
  async function wait(source:string,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(await evaluate(source))return;await new Promise(resolve=>setTimeout(resolve,35));}throw Error("Lifecycle UI deadline: "+source);}
  async function control(action:string,extra:Record<string,unknown>={},timeout=20000){
    const id=randomUUID(),file=path.join(root,"lifecycle-control",id+".request.json"),temporary=file+".tmp";
    const fd=fs.openSync(temporary,"wx",0o600);try{fs.writeFileSync(fd,JSON.stringify({id,action,...extra})+"\n");fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,file);
    const end=Date.now()+timeout;while(Date.now()<end){const reply=path.join(root,"lifecycle-control",id+".reply.json");if(fs.existsSync(reply)){const value=JSON.parse(fs.readFileSync(reply,"utf8"));if(value.id===id){if(!value.ok)throw Error(value.error);return value.value;}}await new Promise(resolve=>setTimeout(resolve,35));}throw Error("Lifecycle fixture control deadline: "+action);
  }
  const read=()=>evaluate("window.launcherClient.getNativeAccounts()") as Promise<NativeManagementSnapshot>;
  const click=async(action:string,id?:string)=>{
    const selector=JSON.stringify((id?`[data-native-account="${id}"] `:"")+`[data-native-action="${action}"]`);
    await wait(`document.querySelector(${selector}) && !document.querySelector(${selector}).disabled`);await evaluate(`document.querySelector(${selector}).click()`);
  };
  const selected=async(id:string)=>wait(`!!document.querySelector('[data-native-account="${id}"] .badge')`);
  const refresh=async()=>{await click("refresh");await wait("!document.querySelector('[data-native-action=refresh]').disabled");};
  const capture=async(name:string,accountId?:string)=>{if(accountId)await evaluate(`document.querySelector('[data-native-account="${accountId}"]').scrollIntoView({block:'center'})`);await evaluate("document.getAnimations().forEach(animation=>animation.finish())");let frames=0;for(let attempt=0;attempt<5;attempt++){await new Promise(resolve=>setTimeout(resolve,150));try{const picture=await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});if(picture.isEmpty())continue;if(++frames>=2){fs.writeFileSync(path.join(root,name),picture.toPNG());return;}}catch{}}throw Error("Lifecycle capture failed: "+name);};
  await wait("!!document.querySelector('[data-native-nav]')");await evaluate("document.querySelector('[data-native-nav]').click()");await wait("document.querySelectorAll('[data-native-account]').length===3");
  const initial=await read(),a=initial.accounts[0].accountId,b=initial.accounts[1].accountId,c=initial.accounts[2].accountId;
  const cliStatus=await control("cli_status");assert.equal(cliStatus.exitCode,0);assert.equal(cliStatus.ownerId,initial.ownerId);
  assert.equal((await control("cli_verify",{accountId:a})).identityVerified,true);
  await control("cli_use",{accountId:b});
  const staleRevision={action:"use",accountId:c,expectedOwnerId:initial.ownerId,expectedRevision:initial.revision};
  assert.equal(await evaluate(`window.launcherClient.executeNativeAccount(${JSON.stringify(staleRevision)}).then(()=> 'unexpected',error=>error.code)`),"CONFIG_CONFLICT");assert.equal((await read()).selectedAccountId,b);
  await refresh();await selected(b);await click("use",c);await selected(c);
  assert.equal((await control("cli_add")).accountCount,4);await refresh();await wait("document.querySelectorAll('[data-native-account]').length===4");
  await control("cli_use",{accountId:a});await refresh();await selected(a);
  const baseline=await control("baseline"),beforeCrash=await read();assert.equal(beforeCrash.lastOutcome?.phase,"completed");
  const crashed=await control("crash_owner");
  await wait("document.querySelector('[data-native-accounts]').textContent.includes('RUNTIME_DISCONNECTED')");
  assert.equal(await evaluate("[...document.querySelectorAll('[data-native-account] button')].every(button=>button.disabled)"),true);
  const offlineCli=await control("cli_status");assert.notEqual(offlineCli.exitCode,0);await capture("lifecycle-owner-disconnected.png");
  const restarted=await control("restart_owner");assert.notEqual(restarted.newPid,crashed.oldPid);assert.notEqual(restarted.ownerId,beforeCrash.ownerId);
  const fresh=await read(),staleOwner={action:"use",accountId:b,expectedOwnerId:beforeCrash.ownerId,expectedRevision:fresh.revision};
  assert.equal(await evaluate(`window.launcherClient.executeNativeAccount(${JSON.stringify(staleOwner)}).then(()=> 'unexpected',error=>error.code)`),"STALE_AUTHORITY");
  await refresh();await control("cli_use",{accountId:b});await refresh();await selected(b);
  const recovered=await control("retry_baseline");assert.equal(recovered.code,"OUTCOME_UNKNOWN");assert.equal(recovered.syntheticSends,1);assert.deepEqual(recovered.ownerAccountIds,[a]);assert.equal(recovered.replayAllowed,false);
  await control("scenario",{accountId:b,mode:"login_required"});const expired=await control("cli_verify",{accountId:b});assert.notEqual(expired.exitCode,0);assert.equal(expired.code,"BROWSER_LOGIN_REQUIRED");await refresh();
  await wait(`document.querySelector('[data-native-account="${b}"]').textContent.includes('Cần đăng nhập')`);await click("verify",b);await wait("document.querySelector('[data-native-accounts]').textContent.includes('LOGIN_REQUIRED')");await capture("lifecycle-login-required.png",b);
  await control("scenario",{accountId:b,mode:"ready"});await refresh();await click("verify",b);await wait(`document.querySelector('[data-native-account="${b}"] [data-native-account-state]').textContent.includes('vừa được kiểm tra')`);
  await control("scenario",{accountId:b,mode:"model_unavailable"});assert.equal((await control("model_failure")).code,"MODEL_UNAVAILABLE");await refresh();await wait("document.querySelector('[data-native-accounts]').textContent.includes('MODEL_UNAVAILABLE')");await capture("lifecycle-model-unavailable.png",b);
  await control("scenario",{accountId:b,mode:"ready"});await control("cli_use",{accountId:c});assert.equal((await control("cli_verify",{accountId:c})).identityVerified,true);await refresh();await selected(c);
  const ttlStart=await control("start_ttl");assert.equal(ttlStart.resultTtlMs,600000);
  let identityExpired=false,ttl;
  if(options.quick)ttl=await control("await_ttl");
  else{
    const expiredResult=control("await_ttl",{},650000);
    await wait(`document.querySelector('[data-native-account="${c}"] [data-native-account-state]').textContent.includes('Chưa kiểm tra phiên')`,45000);identityExpired=true;assert.equal((await read()).accounts.find(account=>account.accountId===c)!.identityVerified,false);
    await capture("lifecycle-identity-expired.png",c);ttl=await expiredResult;assert.equal(ttl.status,"PASS");assert.ok(ttl.elapsedMonotonicMs>=600000);assert.ok(ttl.elapsedWallMs>=600000);
  }
  fs.writeFileSync(path.join(root,"native-lifecycle-desktop.json"),JSON.stringify({checkedAt:new Date().toISOString(),runtimeRevision:initial.runtimeRevision,status:options.quick?"PASS_OTHER_CONTROLS_TTL_NOT_TESTED":"PASS_REAL_PROCESS_CLI_ELECTRON_TTL_FIXTURE",browser:"SYNTHETIC",ideExecutor:"NOT_TESTED",staleRevisionRejected:true,actualOwnerCrash:true,ownerPidChanged:true,staleOwnerRejected:true,disconnectedUiLocked:true,cliDidNotStartMissingOwner:true,baselineRequestId:baseline.requestId,retryAfterRestartNoSend:true,originalAccountReceiptAfterSelectionChange:true,expiredLogin:true,modelUnavailableNoSend:true,identityObservationExpired:identityExpired,ttl},null,2)+"\n");
}
