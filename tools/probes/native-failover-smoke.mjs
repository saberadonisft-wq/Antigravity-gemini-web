// Real loopback native/MCP/SQLite; every browser operation is synthetic.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AccountRegistry } from "../../packages/native-antigravity/dist/account-registry.js";
import { NativeBrowserBackendPool } from "../../packages/native-antigravity/dist/browser-backend-pool.js";
import { McpNativeBrowserBackend } from "../../packages/native-antigravity/dist/browser-backend.js";
import { startNativeProxy,NATIVE_RUNTIME_REVISION } from "../../packages/native-antigravity/dist/native-proxy.js";
import { sha256,WEB_MODEL } from "../../packages/native-antigravity/dist/native-protocol.js";
import { GeminiMcpService } from "../../packages/mcp-server/dist/service.js";

const root=fs.mkdtempSync(path.join(process.cwd(),".tmp/native-failover-smoke-")),registry=new AccountRegistry(path.join(root,"accounts.json"));
const emails=["a@example.test","b@example.test"],accounts=emails.map((email,i)=>registry.add({displayName:"Fixture "+i,profilePath:path.join(root,"profile"+i),statePath:path.join(root,"state"+i),debugPort:18001+i,identityFingerprint:sha256(email)}));registry.setActive(accounts[0].accountId);
const services=new Map(),sends=[0,0],policy={model:"Fixture Primary",effort:"Low"};
function makeServices(){
  for(const [i,account] of accounts.entries()){
    const prompts=new Map();
    const browser={supportsRetainedConversations:true,supportsProgressStreaming:true,supportsAccountIdentityVerification:true,supportsConversationUrlCheckpoint:true,
      checkStatus:async()=>({browserState:"ready",accountState:"signed_in",accountIdentity:emails[i],checkedAt:new Date().toISOString()}),
      openBrowser:async()=>{throw Error("No real browser may open");},
      selectModel:async selected=>{if(i===0||selected.model!==policy.model||selected.effort!==policy.effort)throw {code:"MODEL_UNAVAILABLE"};return {...selected};},
      openFreshConversation:async()=>({close:async()=>{},suspend:async()=>{},resume:async()=>{},preserve:async()=>{}}),
      submitPrompt:async(id,prompt,options)=>{assert.equal(i,1);assert.deepEqual(options.modelSelection,policy);assert.equal(options.expectedAccountFingerprint,account.identityFingerprint);sends[i]++;prompts.set(id,prompt);return {turnId:id,status:"accepted",submittedAt:new Date().toISOString()};},
      pollResponse:async id=>{const nonce=/"nonce":"([a-f0-9]{48})"/.exec(prompts.get(id))?.[1];assert.ok(nonce);return {turnId:id,status:"completed",text:JSON.stringify({nonce,type:"final",text:"FIXTURE_PRIMARY_B"}),completedAt:new Date().toISOString()};},
      cancelPrompt:async id=>({turnId:id,cancelled:false}),cleanup:async()=>{},sendPrompt:async()=>{throw Error("unused");},
    };
    services.set(account.accountId,new GeminiMcpService(browser,path.join(account.statePath,"receipts.json")));
  }
}
const pool=()=>new NativeBrowserBackendPool(registry,"unused",account=>{
  const backend=new McpNativeBrowserBackend("unused",undefined,account.identityFingerprint);
  Object.assign(backend,{connect:async()=>{},call:async(name,args)=>{
    const service=services.get(account.accountId);
    if(name==="gemini_status")return service.status();
    if(name==="gemini_submit")return service.submit(args.request_id,args.prompt,{nativeOwner:args.native_owner,expectedAccountFingerprint:args.expected_account_fingerprint,modelSelection:args.model_selection,conversation:args.conversation?{key:args.conversation.key,revision:args.conversation.revision,baseRevision:args.conversation.base_revision}:undefined});
    if(name==="gemini_result")return service.result(args.request_id,args.wait_ms,args.after_revision);
    if(name==="gemini_receipt")return service.inspectReceipt(args.request_id);
    if(name==="gemini_release_conversation")return service.releaseConversation(args.key,args.preserve_tab);
    throw Error("Unexpected broker operation");
  }});return backend;
});
let proxy;const token="fixture-failover-token",authorization="Bearer fixture-failover";
const start=async()=>{proxy=await startNativeProxy({backend:pool(),accountRegistry:registry,stateDirectory:path.join(root,"native"),routingExperimental:true,controlToken:token,port:0,control:async()=>{throw Error("No external control");}});};
const post=async(route,value)=>{const response=await fetch("http://127.0.0.1:"+proxy.port+route,{method:"POST",headers:{"content-type":"application/json",authorization,"x-native-control-token":token},body:JSON.stringify(value),signal:AbortSignal.timeout(15000)});return {status:response.status,body:await response.json()};};
const health=()=>fetch("http://127.0.0.1:"+proxy.port+"/__native/health").then(response=>response.json());
const request=id=>({model:WEB_MODEL,sessionId:id,conversationId:id,request:{contents:[{role:"user",parts:[{text:"Synthetic finite failover fixture "+id}]}]}});
const restart=async()=>{await proxy.close();proxy=undefined;for(const service of services.values())await service.close();services.clear();makeServices();await start();};
const configure=async modelSelection=>{const status=await post("/__native/router",{action:"status"});assert.equal((await post("/__native/router",{action:"configure",expectedRevision:status.body.revision,settings:{mode:"priority",priority:accounts.map(account=>account.accountId),modelSelection,failover:{enabled:true,maxAttempts:2,deadlineMs:10000}}})).status,200);};
const evidence={checkedAt:new Date().toISOString(),runtimeRevision:NATIVE_RUNTIME_REVISION,http:"real_loopback",mcpService:"actual_service",store:"real_sqlite_wal",browser:"SYNTHETIC",ideExecutor:"NOT_TESTED",status:"RUNNING"};
makeServices();
try{
  await start();await configure(policy);const first=request(randomUUID());
  const response=await post("/v1internal:generateContent",first);assert.equal(response.status,200);assert.deepEqual(sends,[0,1]);
  const logical=(await health()).lastTurn.requestId,receipt=await post("/__native/reconcile",{requestId:logical});assert.equal(receipt.status,200);
  assert.equal(receipt.body.logical.version,2);assert.equal(receipt.body.logical.previousAttempts[0].notSentProof.delivery,"not_sent");
  assert.deepEqual(receipt.body.physical.map(row=>row.receipt.owner.accountId),accounts.map(account=>account.accountId));assert.ok(receipt.body.physical.every(row=>row.correlation==="verified"));
  assert.ok(receipt.body.physical.every(row=>row.receipt.phase==="terminal"));
  registry.setActive(accounts[1].accountId);await restart();
  assert.equal((await post("/v1internal:generateContent",first)).status,409);assert.deepEqual(sends,[0,1]);
  const recovered=await post("/__native/reconcile",{requestId:logical});assert.equal(recovered.status,200);assert.equal(recovered.body.physical.length,2);assert.ok(recovered.body.physical.every(row=>row.correlation==="verified"&&!row.resultAvailable));
  await configure({model:"Unavailable",effort:"Low"});const exhausted=request(randomUUID()),failed=await post("/v1internal:generateContent",exhausted);assert.ok(failed.status>=400);
  const exhaustedLogical=(await health()).lastTurn.requestId;assert.equal((await health()).lastTurn.failoverStopped,"attempt_budget");
  await post("/v1internal:generateContent",exhausted);assert.deepEqual(sends,[0,1]);
  await restart();assert.equal((await post("/v1internal:generateContent",exhausted)).status,409);assert.deepEqual(sends,[0,1]);
  const noSend=await post("/__native/reconcile",{requestId:exhaustedLogical});assert.equal(noSend.status,200);assert.equal(noSend.body.logical.terminal,true);assert.equal(noSend.body.logical.state,"not_sent");assert.equal(noSend.body.physical.length,2);
  Object.assign(evidence,{status:"PASS_FINITE_FAILOVER_HTTP_MCP_SQLITE_FIXTURE",modelPolicy:policy,sendCountA:sends[0],sendCountB:sends[1],attemptOwnersPreserved:true,noSecondSendAfterRestart:true,resultsExpiredWithoutReplay:true,attemptBudgetSurvivedRestart:true,primaryModelUnchanged:true,realGoogleRequests:0});
}catch(error){evidence.status="FAILED";evidence.code=error.code??"FIXTURE_ASSERTION_FAILED";process.exitCode=1;}
finally{if(proxy)await proxy.close();for(const service of services.values())await service.close();}
fs.writeFileSync("docs/evidence/mcp/native-p4-failover-fixture.json",JSON.stringify(evidence,null,2)+"\n");console.log(JSON.stringify(evidence));
