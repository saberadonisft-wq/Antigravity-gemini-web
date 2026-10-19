// Opt-in synthetic acceptance on a temporary proxy; restore the idle main owner.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { AccountRegistry } from "../../packages/native-antigravity/dist/account-registry.js";
import { NativeBrowserBackendPool } from "../../packages/native-antigravity/dist/browser-backend-pool.js";
import { McpNativeBrowserBackend } from "../../packages/native-antigravity/dist/browser-backend.js";
import { CdpClient,getDomInspectionSnippet } from "../../packages/gemini-browser/dist/index.js";
import { sha256 } from "../../packages/native-antigravity/dist/native-protocol.js";
import { startNativeProxy } from "../../packages/native-antigravity/dist/native-proxy.js";

const root=process.cwd(), endpoint="http://127.0.0.1:9236";
const native=path.join(os.homedir(),".gemini/antigravity-gemini-web-live/app_data/native-route");
const health=()=>fetch(endpoint+"/__native/health",{signal:AbortSignal.timeout(2000)}).then(response=>response.json());
const initial=await health(); assert.equal(initial.counters.active,0);
if(!process.argv.includes("--live")) console.log(JSON.stringify({runtimeRevision:initial.runtimeRevision,livePromptsSent:0}));
else {
  const registry=new AccountRegistry(path.join(native,"accounts.json")), account=registry.getActive(); assert.ok(account?.identityFingerprint);
  const owner=JSON.parse(fs.readFileSync(path.join(native,"proxy-owner.json"),"utf8"));assert.equal(owner.pid,initial.pid);assert.equal(owner.endpoint,endpoint);
  const state=fs.mkdtempSync(path.join(root,".tmp/native-snapshot-probe-"));
  const report={checkedAt:new Date().toISOString(),accountId:account.accountId,experimental:true,stateDirectory:path.relative(root,state),status:"RUNNING",nativeRestored:false};
  let proxy, stopped=false;
  try {
    const response=await fetch(endpoint+"/__native/stop",{method:"POST",headers:{"x-native-control-token":owner.controlToken},signal:AbortSignal.timeout(5000)});assert.ok(response.ok);stopped=true;
    const deadline=performance.now()+15000;
    while(await health().catch(()=>undefined)) {assert.ok(performance.now()<deadline,"Main owner did not stop.");await new Promise(resolve=>setTimeout(resolve,100));}
    const cliPath=path.join(root,"packages/mcp-server/dist/cli.js"), replies=[],modelObservations=[];
    const backend=new NativeBrowserBackendPool(registry,cliPath,record=>{
      const worker=new McpNativeBrowserBackend(cliPath,{AG_MCP_BROWSER_PROFILE:record.profilePath,AG_MCP_STATE_DIR:record.statePath,AG_MCP_DEBUG_PORT:String(record.debugPort)},record.identityFingerprint??"");
      const generate=worker.generate.bind(worker);
      worker.generate=async(id,prompt,signal,options)=>{
        const reply=await generate(id,prompt,signal,options);
        // Local debug only, and only for the synthetic system used by this harness.
        if(process.argv.includes("--inspect-replies")&&prompt.includes("Synthetic transport integrity fixture.")){
          replies.push({promptChars:prompt.length,reply});fs.writeFileSync(path.join(state,"synthetic-replies.local.json"),JSON.stringify(replies,null,2)+"\n");
        }
        if(process.argv.includes("--inspect-controls")&&prompt.length>28000){
          try{
            const targets=await fetch("http://127.0.0.1:"+record.debugPort+"/json/list",{signal:AbortSignal.timeout(2000)}).then(response=>response.json());
            const fileName="ag-native-context-"+sha256(prompt)+".txt";
            for(const target of targets.filter(row=>row.type==="page"&&/^https:\/\/gemini\.google\.com\/app\//.test(row.url)).slice(0,12)){
              const cdp=new CdpClient(target.webSocketDebuggerUrl);
              try{
                await cdp.connect(2000);
                if(!await cdp.evaluate(`(()=>{const text=[...document.querySelectorAll('user-query,.user-query')].map(e=>e.textContent||'').join('\\n');return text.includes(${JSON.stringify(fileName)});})()`))continue;
                const observation=await cdp.evaluate(`(()=>{
                  const dom=${getDomInspectionSnippet({fixtureMode:false,allowedOrigins:[]})};
                  const visible=e=>e.getBoundingClientRect().height>0&&getComputedStyle(e).visibility!=='hidden';
                  const controls=[...document.querySelectorAll('button,[role=combobox]')].filter(e=>visible(e)&&!e.closest('model-response,.model-response,user-query,.user-query')&&!/@|Google Account/i.test(e.getAttribute('aria-label')||'')).map(e=>{
                    const clone=e.cloneNode(true);clone.querySelectorAll('mat-icon,[aria-hidden=true],.google-symbols,.material-symbols-outlined').forEach(node=>node.remove());
                    return {text:(clone.textContent||'').trim().replace(/\\s+/g,' ').slice(0,100),testId:e.getAttribute('data-test-id'),cls:typeof e.className==='string'?e.className.slice(0,200):'',popup:e.getAttribute('aria-haspopup')};
                  }).filter(row=>/model|mode/i.test((row.testId||'')+' '+row.cls)||(row.popup==='menu'&&/^(Flash|Thinking|Fast|Pro|Argon|[0-9]+ Argon)/i.test(row.text)));
                  return {reportedModel:dom.modelDetected,controls};
                })()`);
                modelObservations.push({promptChars:prompt.length,...observation});break;
              }finally{cdp.close();}
            }
            fs.writeFileSync(path.join(state,"model-observations.local.json"),JSON.stringify(modelObservations,null,2)+"\n");
          }catch{report.modelObservationUnavailable=true;}
        }
        return reply;
      };
      return worker;
    });
    proxy=await startNativeProxy({backend,accountRegistry:registry,stateDirectory:state,port:0,snapshotAttachment:true,contextModelSelection:initial.contextModelSelection??undefined,generationTimeoutMs:600000,stallTimeoutMs:180000});
    const sizes=process.argv.find(arg=>arg.startsWith("--sizes="))??"--sizes=78642,145000,261000";
    const output=process.argv.find(arg=>arg.startsWith("--output="))??"--output=docs/evidence/mcp/native-r25-snapshot-matrix-live.json";
    report.exitCode=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(root,"tools/probes/native-context-matrix.mjs"),"--live",sizes,output,"--endpoint=http://127.0.0.1:"+proxy.port],{cwd:root,windowsHide:true,stdio:"inherit"});child.on("error",reject);child.on("exit",code=>resolve(code));});
    report.status=report.exitCode===0?"PASS_SYNTHETIC_NATIVE_SNAPSHOT_MATRIX":"FAILED_OR_INCOMPLETE";
    if(report.exitCode!==0)process.exitCode=1;
  } catch(error) {report.status="FAILED";report.code=typeof error.code==="string"?error.code:"PROBE_FAILED";process.exitCode=1;}
  finally {
    try { if(proxy)await proxy.close(); } catch { report.proxyCloseFailed=true; process.exitCode=1; }
    if(stopped&&!await health().catch(()=>undefined)) {
      const child=spawn(process.execPath,[path.join(root,"packages/native-antigravity/dist/native-cli.js"),"start"],{cwd:root,env:{...process.env,AG_NATIVE_ATTACHMENT_TRANSPORT:initial.snapshotAttachmentExperimental?"1":"0"},detached:true,windowsHide:true,stdio:"ignore"});child.on("error",()=>{});child.unref();
      const deadline=performance.now()+15000;
      while(performance.now()<deadline) {const ready=await health().catch(()=>undefined);if(ready?.service==="gemini-native-proxy"&&ready.snapshotAttachmentExperimental===!!initial.snapshotAttachmentExperimental){report.nativeRestored=true;report.restoredRevision=ready.runtimeRevision;break;}await new Promise(resolve=>setTimeout(resolve,100));}
    } else report.nativeRestored=!!await health().catch(()=>undefined);
    if(!report.nativeRestored){report.status="FAILED_NATIVE_RESTORE";process.exitCode=1;}
    fs.writeFileSync(".tmp/native-snapshot-probe-owner.json",JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report));
  }
}
