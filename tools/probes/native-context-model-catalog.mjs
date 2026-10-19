// No prompt is sent. Inspect/select/restore models only on a disposable owned tab.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { acquireOwnership } from "../../packages/mcp-server/dist/ownership.js";
import { LiveGeminiBrowserAdapter, inspectBrowserModels, assertBrowserAccountIdentity } from "../../packages/gemini-browser/dist/index.js";
import { AccountRegistry } from "../../packages/native-antigravity/dist/account-registry.js";
import { ensureNativeBrowserReady } from "../../packages/native-antigravity/dist/browser-readiness.js";
import { GeminiMcpService } from "../../packages/mcp-server/dist/service.js";

const root=process.cwd(), endpoint="http://127.0.0.1:9236";
const native=path.join(os.homedir(),".gemini/antigravity-gemini-web-live/app_data/native-route");
const health=()=>fetch(endpoint+"/__native/health",{signal:AbortSignal.timeout(2000)}).then(r=>r.json());
const initial=await health();assert.equal(initial.counters.active,0);
if(!process.argv.includes("--live")) console.log(JSON.stringify({runtimeRevision:initial.runtimeRevision,promptsSent:0}));
else {
  const account=new AccountRegistry(path.join(native,"accounts.json")).getActive();assert.ok(account?.identityFingerprint);
  const owner=JSON.parse(fs.readFileSync(path.join(native,"proxy-owner.json"),"utf8"));assert.equal(owner.pid,initial.pid);assert.equal(owner.endpoint,endpoint);
  const result={checkedAt:new Date().toISOString(),accountId:account.accountId,runtimeRevision:initial.runtimeRevision,promptsSent:0,status:"RUNNING"};
  let mutex,browser,lease,primary,stopped=false;
  try {
    result.stage="stop_owner";
    const response=await fetch(endpoint+"/__native/stop",{method:"POST",headers:{"x-native-control-token":owner.controlToken},signal:AbortSignal.timeout(5000)});assert.ok(response.ok);stopped=true;
    const deadline=performance.now()+15000;
    while(performance.now()<deadline){try{mutex=await acquireOwnership("browser:"+account.profilePath);break;}catch(error){if(error.code!=="EADDRINUSE")throw error;await new Promise(resolve=>setTimeout(resolve,100));}}
    assert.ok(mutex,"The browser owner must be released before model inspection.");
    result.stage="open_browser";
    browser=new LiveGeminiBrowserAdapter({userDataDir:account.profilePath,debugPort:account.debugPort,headless:false,requireProfileIdentity:true});
    assert.equal((await browser.openBrowser()).opened,true);
    const ready=await ensureNativeBrowserReady(async name=>({...name==="gemini_open_browser"?await browser.openBrowser():{},...await browser.checkStatus()}),new AbortController().signal,30000,account.identityFingerprint);
    assertBrowserAccountIdentity(ready.accountIdentity,account.identityFingerprint);
    result.stage="open_owned_tab";
    lease=await browser.openFreshConversation();
    const surface={fixtureMode:false,allowedOrigins:[]};
    result.stage="capture_primary";
    await browser.checkStatus();
    const catalog=await inspectBrowserModels(browser.driver.cdp,surface);primary=catalog.selected;result.catalog=catalog;
    const matches=catalog.options.filter(option=>/^3\.8(?:\s|$)/.test(option.model)&&!option.disabled);
    assert.equal(matches.length,1,"Exactly one enabled 3.8 model must be observed; no alias is guessed.");
    result.contextModel={model:matches[0].model};
    result.stage="select_context_model";
    await browser.selectModel(result.contextModel);
    assert.equal((await inspectBrowserModels(browser.driver.cdp,surface)).selected.model,matches[0].model);
    await browser.selectModel(primary);
    assert.deepEqual((await inspectBrowserModels(browser.driver.cdp,surface)).selected,primary);
    result.primaryRestored=true;result.status="PASS_CONTEXT_MODEL_SELECTION_AND_RESTORE_NO_SEND";
    if(process.argv.includes("--service")){
      await lease.close();lease=undefined;
      const state=fs.mkdtempSync(path.join(root,".tmp/context-model-no-send-"));
      const submit=browser.submitPrompt.bind(browser),capture=browser.captureModelSelection.bind(browser);
      const openFresh=browser.openFreshConversation.bind(browser);
      browser.openFreshConversation=async()=>{const owned=await openFresh();return {...owned,preserve:()=>owned.close()};};
      browser.submitPrompt=async()=>{throw {code:"NO_SEND_PROBE",delivery:"not_sent"};};
      browser.captureModelSelection=async()=>{try{const observed=await capture();result.servicePrimary=observed;return observed;}catch(error){result.captureDiagnostic=error.modelSelection;result.captureObservation=error.modelCaptureObservation;throw error;}};
      const service=new GeminiMcpService(browser,path.join(state,"receipts.json"));
      try{
        await service.submit("no_send_context_model","Never submitted by this probe",{conversation:{key:"no_send_model_chat",revision:"a".repeat(64)},modelSelection:result.contextModel,temporaryModelSelection:true,expectedAccountFingerprint:account.identityFingerprint});
        const turn=await service.result("no_send_context_model",15000);result.serviceResult={status:turn.status,code:turn.error?.code,diagnostic:turn.error?.modelSelection,restoredModel:turn.restoredModel,delivery:turn.delivery};
        assert.equal(turn.error?.code,"NO_SEND_PROBE");assert.equal(turn.delivery,"not_sent");assert.deepEqual(turn.restoredModel,result.servicePrimary);
        result.status="PASS_SERVICE_CONTEXT_MODEL_RESTORE_NO_SEND";
      }finally{browser.submitPrompt=submit;browser.captureModelSelection=capture;await service.close();browser=undefined;}
    }
  }catch(error){
    result.status="FAILED";result.code=typeof error.code==="string"?error.code:"MODEL_CATALOG_FAILED";result.modelSelectionDiagnostic=error.modelSelection;result.captureObservation??=error.modelCaptureObservation;process.exitCode=1;
    if(lease&&browser?.driver.cdp)try{result.failureUi=await browser.driver.cdp.evaluate(`(()=>{
      const visible=e=>e.getBoundingClientRect().height>0&&getComputedStyle(e).visibility!=='hidden';
      const rows=[...document.querySelectorAll('[data-test-id^="bard-mode-option-"],[data-model-option],[value="thinking_level"],[role=menuitemradio],[role=option]')];
      const labels=rows.slice(0,25).map(e=>({label:(e.querySelector('.label')?.textContent||e.textContent||'').trim().replace(/\\s+/g,' ').slice(0,100),visible:visible(e),selected:e.classList.contains('selected'),checked:e.getAttribute('aria-checked'),ariaSelected:e.getAttribute('aria-selected'),expanded:e.getAttribute('aria-expanded')}));
      return {labels,buttons:[...document.querySelectorAll('[data-test-id="bard-mode-menu-button"]')].map(e=>({text:(e.textContent||'').trim().slice(0,100),expanded:e.getAttribute('aria-expanded'),visible:visible(e)}))};
    })()`);}catch{}
  }
  finally {
    if(primary&&browser){try{await browser.selectModel(primary);result.primaryRestored=true;}catch{result.primaryRestored=false;process.exitCode=1;}}
    try{await lease?.close();await browser?.cleanup();}catch{result.cleanupFailed=true;process.exitCode=1;}
    if(mutex)await new Promise(resolve=>mutex.close(resolve));
    if(stopped&&!await health().catch(()=>undefined)){
      const child=spawn(process.execPath,[path.join(root,"packages/native-antigravity/dist/native-cli.js"),"start"],{cwd:root,env:{...process.env,AG_NATIVE_ATTACHMENT_TRANSPORT:initial.snapshotAttachmentExperimental?"1":"0"},detached:true,windowsHide:true,stdio:"ignore"});child.on("error",()=>{});child.unref();
      const deadline=performance.now()+15000;
      while(performance.now()<deadline){const ready=await health().catch(()=>undefined);if(ready?.service==="gemini-native-proxy"&&ready.snapshotAttachmentExperimental===!!initial.snapshotAttachmentExperimental){result.nativeRestored=true;break;}await new Promise(resolve=>setTimeout(resolve,100));}
    }else result.nativeRestored=!!await health().catch(()=>undefined);
    if(!result.nativeRestored){result.status="FAILED_NATIVE_RESTORE";process.exitCode=1;}
    const output=process.argv.find(value=>value.startsWith("--output="))?.slice(9)??"docs/evidence/mcp/native-context-model-catalog-live.json";
    fs.writeFileSync(output,JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify(result));
  }
}
