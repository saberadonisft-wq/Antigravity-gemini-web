// Loopback native routing + actual MCP services/SQLite; synthetic browser only.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AccountRegistry } from "../../packages/native-antigravity/dist/account-registry.js";
import { NativeBrowserBackendPool } from "../../packages/native-antigravity/dist/browser-backend-pool.js";
import { McpNativeBrowserBackend } from "../../packages/native-antigravity/dist/browser-backend.js";
import { startNativeProxy } from "../../packages/native-antigravity/dist/native-proxy.js";
import { sha256,WEB_MODEL } from "../../packages/native-antigravity/dist/native-protocol.js";
import { GeminiMcpService } from "../../packages/mcp-server/dist/service.js";

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const root=fs.mkdtempSync(path.join(process.cwd(),".tmp/native-router-smoke-")),registry=new AccountRegistry(path.join(root,"accounts.json"));
const emails=["a@example.test","b@example.test"],accounts=emails.map((email,i)=>registry.add({displayName:"Fixture "+i,profilePath:path.join(root,"profile"+i),statePath:path.join(root,"state"+i),debugPort:16001+i,identityFingerprint:sha256(email)}));registry.setActive(accounts[0].accountId);
const services=new Map(),sends=[0,0],started=[deferred(),deferred()],finish=[deferred(),deferred()],policy={model:"Fixture Model",effort:"Low"};
function makeServices(){
  for(const [i,account] of accounts.entries()){
    const prompts=new Map();
    const browser={supportsRetainedConversations:true,supportsProgressStreaming:true,supportsAccountIdentityVerification:true,supportsConversationUrlCheckpoint:true,
      checkStatus:async()=>({browserState:"ready",accountState:"signed_in",accountIdentity:emails[i],checkedAt:new Date().toISOString()}),openBrowser:async()=>{throw Error("No real browser may open");},
      selectModel:async selection=>{if(selection.model!==policy.model||selection.effort!==policy.effort)throw {code:"MODEL_UNAVAILABLE",message:"Synthetic model unavailable"};return {...selection};},
      openFreshConversation:async()=>({close:async()=>{},suspend:async()=>{},resume:async()=>{},preserve:async()=>{}}),
      submitPrompt:async(id,prompt,options)=>{assert.equal(options.expectedAccountFingerprint,account.identityFingerprint);assert.deepEqual(options.modelSelection,policy);sends[i]++;prompts.set(id,prompt);started[i].resolve();return {turnId:id,status:"accepted",submittedAt:new Date().toISOString()};},
      pollResponse:async id=>{await finish[i].promise;const nonce=/"nonce":"([a-f0-9]{48})"/.exec(prompts.get(id))?.[1];assert.ok(nonce);return {turnId:id,status:"completed",text:JSON.stringify({nonce,type:"final",text:"FIXTURE_ACCOUNT_"+i}),completedAt:new Date().toISOString()};},
      cancelPrompt:async id=>({turnId:id,cancelled:false}),cleanup:async()=>{},sendPrompt:async()=>{throw Error("unused");},
    };services.set(account.accountId,new GeminiMcpService(browser,path.join(account.statePath,"receipts.json")));
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
let proxy;const token="fixture-router-token";
const start=async()=>{proxy=await startNativeProxy({backend:pool(),accountRegistry:registry,stateDirectory:path.join(root,"native"),routingExperimental:true,controlToken:token,port:0,control:async()=>{throw Error("No external control");}});};
const post=async(route,value)=>{const response=await fetch("http://127.0.0.1:"+proxy.port+route,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer fixture-router","x-native-control-token":token},body:JSON.stringify(value),signal:AbortSignal.timeout(15000)});return {status:response.status,body:await response.json()};};
const request=(id,text=id)=>({model:WEB_MODEL,sessionId:id,conversationId:id,request:{contents:[{role:"user",parts:[{text}]}]}});
const evidence={checkedAt:new Date().toISOString(),http:"real_loopback",mcpService:"actual_service",store:"real_sqlite_wal",browser:"SYNTHETIC",ideExecutor:"NOT_TESTED",mode:"priority",modelPolicy:policy,status:"RUNNING"};
makeServices();
try{
  await start();assert.equal((await post("/__native/router",{action:"configure",expectedRevision:0,settings:{mode:"priority",modelSelection:policy}})).status,200);
  const id=randomUUID(),bodyA=request(id+"_A"),bodyB=request(id+"_B");
  const a=post("/v1internal:generateContent",bodyA);await started[0].promise;
  const duplicate=post("/v1internal:generateContent",bodyA),b=post("/v1internal:generateContent",bodyB);await started[1].promise;
  const active=await post("/__native/router",{action:"status"});assert.equal(active.body.activeLeases.length,2);assert.equal((await post("/v1internal:generateContent",request(id+"_A","must not overlap"))).status,409);
  const logicalA=active.body.activeLeases.find(lease=>lease.accountId===accounts[0].accountId).requestId;
  assert.equal((await services.get(accounts[0].accountId).status()).requestIdentities,1);assert.equal((await services.get(accounts[1].accountId).status()).requestIdentities,1);
  finish[0].resolve();finish[1].resolve();const responses=await Promise.all([a,duplicate,b]);assert.ok(responses.every(response=>response.status===200));assert.deepEqual(responses[0],responses[1]);assert.deepEqual(sends,[1,1]);
  await proxy.close();proxy=undefined;for(const service of services.values())await service.close();services.clear();makeServices();registry.setActive(accounts[1].accountId);await start();
  const replay=await post("/v1internal:generateContent",bodyA);assert.equal(replay.status,409);assert.equal(replay.body.error.details[0].reason,"OUTCOME_UNKNOWN");
  const receipt=await post("/__native/reconcile",{requestId:logicalA});assert.equal(receipt.status,200);assert.equal(receipt.body.physical[0].correlation,"verified");assert.equal(receipt.body.physical[0].receipt.owner.accountId,accounts[0].accountId);assert.equal(receipt.body.replayAllowed,false);
  const status=await post("/__native/router",{action:"status"});assert.equal(status.body.settings.mode,"priority");
  assert.equal((await post("/__native/router",{action:"configure",expectedRevision:status.body.revision,settings:{mode:"priority",priority:[accounts[1].accountId],modelSelection:{model:"Unavailable",effort:"Low"}}})).status,200);
  const modelFailure=await post("/v1internal:generateContent",request(id+"_model"));assert.equal(modelFailure.status,502);assert.equal(modelFailure.body.error.details[0].reason,"MODEL_UNAVAILABLE");assert.deepEqual(sends,[1,1]);
  Object.assign(evidence,{status:"PASS_PRIORITY_HTTP_MCP_SQLITE_FIXTURE",sameChatSerialized:true,duplicateCoalesced:true,twoAccountsConcurrent:true,routingConfigSurvivedRestart:true,oldRequestFencedAfterSwitch:true,originalReceiptOwnerVerified:true,unavailableModelRejectedBeforeSend:true,failoverEnabled:false,sendCountA:sends[0],sendCountB:sends[1]});
}finally{for(const gate of finish)gate.resolve();if(proxy)await proxy.close();for(const service of services.values())await service.close();}
fs.writeFileSync("docs/evidence/mcp/native-p4-priority-routing-fixture.json",JSON.stringify(evidence,null,2)+"\n");console.log(JSON.stringify(evidence));
