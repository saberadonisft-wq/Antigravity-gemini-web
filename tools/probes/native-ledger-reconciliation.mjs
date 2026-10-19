// Real loopback HTTP + MCP service + SQLite; browser/executor are synthetic.
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

const root=fs.mkdtempSync(path.join(process.cwd(),".tmp/native-ledger-reconcile-")),registry=new AccountRegistry(path.join(root,"accounts.json"));
const emails=["a@example.test","b@example.test"],accounts=emails.map((email,i)=>registry.add({displayName:"Fixture "+i,profilePath:path.join(root,"profile-"+i),statePath:path.join(root,"state-"+i),debugPort:12001+i,identityFingerprint:sha256(email)}));
registry.setActive(accounts[0].accountId);
const services=new Map(),sends=new Map(accounts.map(account=>[account.accountId,0])),inspections=[];
const makeServices=()=>{
  for(const [i,account] of accounts.entries()){
    const prompts=new Map();
    const browser={supportsRetainedConversations:true,supportsProgressStreaming:true,supportsAccountIdentityVerification:true,supportsConversationUrlCheckpoint:true,
      checkStatus:async()=>({browserState:"ready",accountState:"signed_in",accountIdentity:emails[i],checkedAt:new Date().toISOString()}),openBrowser:async()=>{throw Error("Must not open a real browser");},
      openFreshConversation:async()=>({close:async()=>{},suspend:async()=>{},resume:async()=>{},preserve:async()=>{}}),
      submitPrompt:async(id,prompt,options)=>{assert.equal(options.expectedAccountFingerprint,account.identityFingerprint);sends.set(account.accountId,sends.get(account.accountId)+1);prompts.set(id,prompt);return {turnId:id,status:"accepted",submittedAt:new Date().toISOString()};},
      pollResponse:async id=>{const nonce=/"nonce":"([a-f0-9]{48})"/.exec(prompts.get(id))?.[1];assert.ok(nonce);return {turnId:id,status:"completed",text:JSON.stringify({nonce,type:"final",text:"SYNTHETIC_RECONCILIATION_REPLY"}),completedAt:new Date().toISOString()};},
      cancelPrompt:async id=>({turnId:id,cancelled:false}),cleanup:async()=>{},sendPrompt:async()=>{throw Error("unused");},
    };
    services.set(account.accountId,new GeminiMcpService(browser,path.join(account.statePath,"receipts.json")));
  }
};
makeServices();
const pool=()=>new NativeBrowserBackendPool(registry,"unused",account=>{
  const backend=new McpNativeBrowserBackend("unused",undefined,account.identityFingerprint);
  Object.assign(backend,{connect:async()=>{},call:async(name,args)=>{
    const service=services.get(account.accountId);
    if(name==="gemini_status")return service.status();
    if(name==="gemini_submit")return service.submit(args.request_id,args.prompt,{nativeOwner:args.native_owner,expectedAccountFingerprint:args.expected_account_fingerprint,conversation:args.conversation?{key:args.conversation.key,revision:args.conversation.revision,baseRevision:args.conversation.base_revision}:undefined,freshConversation:args.fresh_conversation});
    if(name==="gemini_result")return service.result(args.request_id,args.wait_ms,args.after_revision);
    if(name==="gemini_receipt"){inspections.push(account.accountId);return service.inspectReceipt(args.request_id);}
    if(name==="gemini_release_conversation")return service.releaseConversation(args.key,args.preserve_tab);
    throw Error("Unexpected broker operation");
  }});return backend;
});
let proxy;
const token="fixture-owner-token",evidence={checkedAt:new Date().toISOString(),browser:"SYNTHETIC",ideExecutor:"NOT_TESTED",http:"real_loopback",physicalStore:"real_sqlite_wal",status:"RUNNING"};
const start=async()=>{proxy=await startNativeProxy({backend:pool(),stateDirectory:path.join(root,"native"),accountRegistry:registry,controlToken:token,port:0,control:async()=>{throw Error("No external control requests allowed");}});};
const post=async(route,body,authorized=true)=>{const response=await fetch("http://127.0.0.1:"+proxy.port+route,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer fixture-reconcile",...(authorized?{"x-native-control-token":token}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});return {status:response.status,body:await response.json()};};
try {
  await start();
  const task=randomUUID(),request={model:WEB_MODEL,sessionId:task,conversationId:task,request:{contents:[{role:"user",parts:[{text:"Return the synthetic fixture reply."}]}]}};
  const first=await post("/v1internal:generateContent",request);assert.equal(first.status,200);assert.equal(first.body.response.candidates[0].content.parts[0].text,"SYNTHETIC_RECONCILIATION_REPLY");
  const health=await fetch("http://127.0.0.1:"+proxy.port+"/__native/health").then(response=>response.json()),requestId=health.lastTurn.requestId;
  await proxy.close();proxy=undefined;for(const service of services.values())await service.close();services.clear();makeServices();
  registry.setActive(accounts[1].accountId);await start();
  assert.equal((await post("/__native/reconcile",{requestId},false)).status,401);
  const reconciled=await post("/__native/reconcile",{requestId});assert.equal(reconciled.status,200);
  assert.equal(reconciled.body.logical.accountId,accounts[0].accountId);assert.equal(reconciled.body.physical.length,1);
  assert.equal(reconciled.body.physical[0].correlation,"verified");assert.equal(reconciled.body.physical[0].receipt.phase,"terminal");
  assert.equal(reconciled.body.physical[0].resultAvailable,false);assert.equal(reconciled.body.persistedResultAvailable,false);assert.equal(reconciled.body.replayAllowed,false);
  assert.deepEqual(inspections,[accounts[0].accountId]);
  const replay=await post("/v1internal:generateContent",request);assert.equal(replay.status,409);assert.equal(replay.body.error.details[0].reason,"OUTCOME_UNKNOWN");
  const service=services.get(accounts[0].accountId),inspect=service.inspectReceipt.bind(service);
  service.inspectReceipt=async id=>{const result=await inspect(id);return {...result,receipt:{...result.receipt,owner:{...result.receipt.owner,logicalAttemptId:randomUUID()}}};};
  assert.equal((await post("/__native/reconcile",{requestId})).status,409);service.inspectReceipt=inspect;
  service.inspectReceipt=async id=>{const result=await inspect(id);const {owner,...receipt}=result.receipt;return {...result,receipt};};
  const uncorrelated=await post("/__native/reconcile",{requestId});assert.equal(uncorrelated.status,200);assert.equal(uncorrelated.body.physical[0].correlation,"uncorrelated");assert.equal(uncorrelated.body.replayAllowed,false);service.inspectReceipt=inspect;
  service.inspectReceipt=async id=>({requestId:id,found:false,replayAllowed:false,resultAvailable:false});
  const missing=await post("/__native/reconcile",{requestId});assert.equal(missing.status,200);assert.equal(missing.body.physical[0].correlation,"missing");assert.equal(missing.body.replayAllowed,false);service.inspectReceipt=inspect;
  registry.update(accounts[0].accountId,{identityFingerprint:sha256("changed@example.test")});assert.equal((await post("/__native/reconcile",{requestId})).status,409);
  assert.equal(sends.get(accounts[0].accountId),1);assert.equal(sends.get(accounts[1].accountId),0);
  Object.assign(evidence,{status:"PASS_HTTP_SQLITE_RECONCILIATION",runtimeRevision:health.runtimeRevision,accountSwitchAfterRestart:true,originalAccountOnly:true,missingReceiptCannotReplay:true,missingOwnerRemainsUncorrelated:true,mismatchedAttemptRejected:true,changedEpochRejected:true,sendCountA:1,sendCountB:0,reconciliation:reconciled.body});
} finally {if(proxy)await proxy.close();for(const service of services.values())await service.close();}
fs.writeFileSync("docs/evidence/mcp/native-p4-receipt-reconciliation.json",JSON.stringify(evidence,null,2)+"\n");console.log(JSON.stringify({status:evidence.status,sendCountA:evidence.sendCountA,sendCountB:evidence.sendCountB}));
