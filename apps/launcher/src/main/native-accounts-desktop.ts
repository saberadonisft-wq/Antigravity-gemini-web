import { BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import type { RuntimeFacade } from "@antigravity-gemini-web/runtime";
import type { NativeManagementSnapshot } from "@antigravity-gemini-web/contracts";

/** Owned Electron fixture only; all Native browser operations are synthetic. */
export async function runNativeAccountsDesktop(window:BrowserWindow,runtime:RuntimeFacade,directory:string){
  const evaluate=(script:string)=>window.webContents.executeJavaScript(script,true);
  async function wait(script:string){
    const deadline=Date.now()+12000;while(Date.now()<deadline){if(await evaluate(script))return;await new Promise(resolve=>setTimeout(resolve,25));}throw Error("Native account UI condition timed out: "+script);
  }
  const read=()=>evaluate("window.launcherClient.getNativeAccounts()") as Promise<NativeManagementSnapshot>;
  const selector=(action:string,id?:string)=>(id?`[data-native-account="${id}"] `:"")+`[data-native-action="${action}"]`;
  const click=async(action:string,id?:string)=>{const value=JSON.stringify(selector(action,id));await wait(`document.querySelector(${value}) && !document.querySelector(${value}).disabled`);await evaluate(`document.querySelector(${value}).click()`);};
  const fill=(id:string,value:string)=>evaluate(`(()=>{const input=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const capture=async(file:string)=>{
    await evaluate("document.getAnimations().forEach(animation=>animation.finish())");window.webContents.invalidate();
    let last:unknown,frames=0;
    for(let attempt=0;attempt<5;attempt++){
      await new Promise(resolve=>setTimeout(resolve,150));
      try{const picture=await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});if(picture.isEmpty())throw Error("Empty native account capture");if(++frames<2){window.webContents.invalidate();continue;}fs.writeFileSync(path.join(directory,file),picture.toPNG());return;}catch(error){last=error;}
    }
    throw Error("Native account capture failed ("+file+"): "+String(last));
  };
  const contrast=()=>evaluate(`(()=>{const luminance=rgb=>rgb.slice(0,3).map(value=>value/255).map(value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4).reduce((total,value,index)=>total+value*[0.2126,0.7152,0.0722][index],0);return Math.min(...[...document.querySelectorAll('.native-accounts button:not(:disabled)')].filter(button=>button.getBoundingClientRect().height>0&&button.checkVisibility()).map(button=>{const style=getComputedStyle(button),fg=luminance(style.color.match(/[\\d.]+/g).map(Number)),bg=luminance(style.backgroundColor.match(/[\\d.]+/g).map(Number));return (Math.max(fg,bg)+0.05)/(Math.min(fg,bg)+0.05);}));})()`) as Promise<number>;
  const errors:string[]=[];window.webContents.on("console-message",(_event,level,message)=>{if(level>=3)errors.push(message);});
  await wait("!!document.querySelector('[data-native-nav]')");await evaluate("document.querySelector('[data-native-nav]').click()");
  await wait("document.querySelectorAll('[data-native-account]').length===2");const initial=await read(),a=initial.accounts[0].accountId,b=initial.accounts[1].accountId;
  await evaluate("(()=>{const select=document.querySelector('[data-native-action=routing]');select.value='sticky';select.dispatchEvent(new Event('change',{bubbles:true}));})()");await wait("document.querySelector('[data-native-action=routing]').value==='sticky'");assert.equal((await read()).routing.automaticEnabled,true);
  await evaluate("(()=>{const select=document.querySelector('[data-native-action=routing]');select.value='manual';select.dispatchEvent(new Event('change',{bubbles:true}));})()");await wait("document.querySelector('[data-native-action=routing]').value==='manual'");assert.equal((await read()).routing.automaticEnabled,false);
  await click("verify",a);await wait(`document.querySelector('[data-native-account="${a}"] [data-native-account-state]').textContent.includes('vừa được kiểm tra')`);
  await click("use",b);await wait(`!!document.querySelector('[data-native-account="${b}"] .badge')`);assert.equal((await read()).selectedAccountId,b);
  await click("open",b);await wait("!document.querySelector('[data-native-action=refresh]').disabled");
  await click("verify",b);await wait("document.querySelector('[data-native-accounts]').textContent.includes('BROWSER_USER_ACTION_REQUIRED')");
  await capture("accounts-verification-required.png");await click("refresh");await wait(`!document.querySelector('[data-native-account="${b}"] [data-native-action=verify]').disabled`);
  await click("verify",b);await wait(`document.querySelector('[data-native-account="${b}"] [data-native-account-state]').textContent.includes('vừa được kiểm tra')`);assert.equal((await read()).accounts[1].identityRegistered,true);
  await click("disable",b);await wait(`!!document.querySelector('[data-native-account="${a}"] .badge')`);await click("enable",b);await wait(`!document.querySelector('[data-native-account="${b}"] [data-native-action=verify]').disabled`);
  await fill("native-account-name","Secondary fixture");await click("add");await wait("document.querySelectorAll('[data-native-account]').length===3");
  const added=(await read()).accounts.find(account=>account.displayName==="Secondary fixture")!;assert.equal(added.identityRegistered,false);
  let chromeProfileAccount=false,pairingCodeCopied=false,accountRemoval=false;
  if(initial.runtimeRevision>=41){
    await fill("native-account-name","Chrome profile fixture");
    await evaluate("(()=>{const select=document.querySelector('.native-account-add select');select.value='extension';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await click("add");await wait("document.querySelectorAll('[data-native-account]').length===4");
    const extension=(await read()).accounts.find(account=>account.displayName==="Chrome profile fixture")!;
    assert.equal(extension.browserTransport,"extension");assert.equal(extension.identityRegistered,false);
    assert.ok((await evaluate(`document.querySelector('[data-native-account="${extension.accountId}"] [data-native-action=open]').textContent`) as string).includes("connector"));
    await click("pair",extension.accountId);await wait("document.querySelector('[data-native-accounts]').textContent.includes('Đã sao chép mã ghép nối')||!!document.querySelector('[data-native-accounts] .native-account-error')");
    const pairingFeedback=await evaluate("document.querySelector('[data-native-accounts]').textContent");if(!(pairingFeedback as string).includes("Đã sao chép mã ghép nối"))throw Error("Extension pairing UI failed: "+String(pairingFeedback));
    const copyState=JSON.parse(fs.readFileSync(path.join(directory,"native-pairing-copy-count.json"),"utf8"));assert.equal(copyState.copies,1);pairingCodeCopied=true;
    chromeProfileAccount=true;
  }
  await click("remove",added.accountId);await wait(`document.querySelector('[data-native-account="${added.accountId}"] [role="alertdialog"]')`);await click("confirm-remove",added.accountId);await wait("document.querySelectorAll('[data-native-account]').length===3");
  assert.ok(!(await read()).accounts.some(account=>account.accountId===added.accountId));accountRemoval=true;
  await evaluate("document.querySelector('.native-account-recovery').open=true");await fill("native-resume-url","https://gemini.google.com/app/owned_fixture");await click("resume");await wait("document.querySelector('.native-account-recovery').textContent.includes('Đang chờ một lượt IDE mới')");assert.equal((await read()).resumeArmed,true);
  await click("clear_resume");await wait("document.querySelector('[data-native-action=clear_resume]').disabled");assert.equal((await read()).resumeArmed,false);
  const descriptor=JSON.parse(fs.readFileSync(path.join(directory,"native-owner.json"),"utf8"));
  assert.ok(!JSON.stringify(await read()).includes(descriptor.controlToken));
  const generated=fetch(descriptor.endpoint+"/v1internal:generateContent",{method:"POST",headers:{authorization:"Bearer fixture-native-ui","content-type":"application/json"},body:JSON.stringify({model:"antigravity-gemini-web",sessionId:"p5-desktop-fixture",conversationId:"p5-desktop-fixture",request:{contents:[{role:"user",parts:[{text:"synthetic cancellation fixture"}]}]}})});
  await wait("!!document.querySelector('[data-native-action=cancel]')");assert.equal(await evaluate(`document.querySelector('[data-native-account="${b}"] [data-native-action=use]').disabled`),true);
  await click("cancel");assert.equal((await generated).status,499);await wait(`!document.querySelector('[data-native-action=cancel]') && !document.querySelector('[data-native-account="${a}"] [data-native-action=verify]').disabled`);
  assert.equal((await read()).lastOutcome?.code,"CANCELLED");
  await evaluate("document.querySelector('.native-account-recovery').open=false;document.querySelector('.app-content').scrollTop=0");
  const light=await runtime.getSnapshot();assert.equal((await runtime.execute({requestId:"p5-account-vietnamese-light",type:"settings.update",payload:{expectedRevision:light.settings.revision,patch:{language:"vi",theme:"light"}}})).accepted,true);
  await wait("document.documentElement.getAttribute('data-theme')==='light'");
  window.setContentSize(1280,900);await new Promise(resolve=>setTimeout(resolve,180));await evaluate("document.getAnimations().forEach(animation=>animation.finish())");const lightContrast=await contrast();assert.ok(lightContrast>=4.5,"light contrast="+lightContrast+" "+JSON.stringify(await evaluate("[...document.querySelectorAll('.native-accounts button:not(:disabled)')].slice(0,3).map(button=>({text:button.textContent,color:getComputedStyle(button).color,background:getComputedStyle(button).backgroundColor}))")));await capture("accounts-light.png");
  const current=await runtime.getSnapshot();const ack=await runtime.execute({requestId:"p5-account-english-dark",type:"settings.update",payload:{expectedRevision:current.settings.revision,patch:{language:"en",theme:"dark"}}});assert.equal(ack.accepted,true);
  await wait("document.getElementById('native-accounts-title').textContent==='Gemini Web accounts' && document.documentElement.getAttribute('data-theme')==='dark'");await new Promise(resolve=>setTimeout(resolve,180));await evaluate("document.getAnimations().forEach(animation=>animation.finish())");const darkContrast=await contrast();assert.ok(darkContrast>=4.5,"dark contrast="+darkContrast);await capture("accounts-dark-english.png");
  window.setContentSize(800,900);await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1 && document.querySelector('.app-content').scrollWidth<=document.querySelector('.app-content').clientWidth+1"),true);
  assert.equal(await evaluate("[...document.querySelectorAll('.native-accounts button,.native-accounts select')].filter(button=>button.offsetParent!==null).every(button=>button.getBoundingClientRect().height>=44)"),true);
  await evaluate("document.querySelector('[data-native-action=refresh]').focus()");window.webContents.sendInputEvent({type:"keyDown",keyCode:"Tab"});window.webContents.sendInputEvent({type:"keyUp",keyCode:"Tab"});await wait("document.activeElement.id==='native-account-routing'");window.webContents.sendInputEvent({type:"keyDown",keyCode:"Tab"});window.webContents.sendInputEvent({type:"keyUp",keyCode:"Tab"});await wait("document.activeElement.id==='native-account-name'");await capture("accounts-800px.png");
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(directory,"native-accounts-desktop.json"),JSON.stringify({checkedAt:new Date().toISOString(),status:"PASS_ELECTRON_NATIVE_ACCOUNT_CONTROLS",runtimeRevision:initial.runtimeRevision,desktop:"real_electron",ipc:"real_sandboxed_preload",owner:"real_loopback_http",browser:"SYNTHETIC",ideExecutor:"NOT_TESTED",accountSelection:true,identityEnrollment:true,chromeProfileAccount,pairingCodeCopied,accountRemoval,trafficVerificationError:true,addEnableDisable:true,resumeWithoutReplay:true,busyControlsLocked:true,cancel:true,tokenInRenderer:false,englishDarkMode:true,widths:[1280,800],horizontalOverflow:false,minimumTarget44px:true,contrast:{light:lightContrast,dark:darkContrast},captureWarmupFrames:2,keyboard:true,rendererErrors:errors.length},null,2)+"\n");
}
