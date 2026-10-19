import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AccountRegistry } from "./account-registry.js";
import { NativeBrowserBackendPool } from "./browser-backend-pool.js";
import { NativeRouteError,sha256,WEB_MODEL } from "./native-protocol.js";
import { startNativeProxy } from "./native-proxy.js";
import type { NativeGenerationOptions } from "./browser-backend.js";
import type { AccountRecord } from "@antigravity-gemini-web/contracts";
const signal=()=>new AbortController().signal;
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
function fixture(t:test.TestContext){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"ag-pool-lifecycle-")),registry=new AccountRegistry(path.join(root,"accounts.json")),events:{account:string;key:string;preserve?:boolean}[]=[],sends:string[]=[];
  const accounts=["A","B"].map((name,index)=>registry.add({displayName:name,profilePath:path.join(root,"p"+name),statePath:path.join(root,"s"+name),debugPort:15801+index,identityFingerprint:index===0?sha256("a@fixture.invalid"):undefined}));
  const control={busy:false,factoryCalls:0,closes:0,releaseError:undefined as unknown,releaseHook:undefined as undefined|(()=>Promise<void>),identityHook:undefined as undefined|(()=>Promise<void>),closeHook:undefined as undefined|((accountId:string)=>Promise<void>),beforeCleanup:undefined as undefined|(()=>Promise<void>),generateHook:undefined as undefined|((accountId:string,options?:NativeGenerationOptions)=>Promise<string>)};
  const factory=(account:AccountRecord)=>{control.factoryCalls++;return {prepare:async()=>{},inspectIdentity:async()=>{await control.identityHook?.();return {accountIdentity:account.displayName.toLowerCase()+"@fixture.invalid"};},generate:async(id:string,_prompt:string,_signal:AbortSignal,options?:NativeGenerationOptions)=>{options?.onPhysicalSubmission?.(id);options?.onSubmissionStarted?.();sends.push(account.accountId);return control.generateHook?control.generateHook(account.accountId,options):JSON.stringify({nonce:options?.responseNonce,type:"final",text:"synthetic pool reply"});},releaseConversation:async(key:string,preserve?:boolean)=>{events.push({account:account.accountId,key,preserve});await control.releaseHook?.();if(control.releaseError)throw control.releaseError;if(control.busy)throw new NativeRouteError("BUSY","Synthetic busy worker",409);},close:async()=>{control.closes++;await control.closeHook?.(account.accountId);}};};
  const pool=new NativeBrowserBackendPool(registry,"unused",factory);
  t.after(async()=>{await control.beforeCleanup?.();await pool.close().catch(()=>{});const resolved=fs.realpathSync(root);assert.equal(path.dirname(resolved).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(resolved).startsWith("ag-pool-lifecycle-"));fs.rmSync(resolved,{recursive:true,force:true});});
  return {root,registry,accounts,pool,events,sends,control,factory};
}
const conversation=(key:string)=>({conversation:{key,revision:sha256(key)}});

test("Bound cleanup retires ownership and defers BUSY only on its captured account, preserving the stronger request",async t=>{
  const f=fixture(t),a=f.pool.bindAccount(f.accounts[0]!.accountId),b=f.pool.bindAccount(f.accounts[1]!.accountId);await b.generate("old","synthetic",signal(),conversation("B-old"));f.control.busy=true;
  await b.releaseConversation!("B-old",false);await b.releaseConversation!("B-old",true);assert.equal(f.pool.resourceStatus().pendingConversationReleases,1);assert.equal(f.pool.resourceStatus().conversationOwners,1);
  await a.generate("a","synthetic",signal());assert.equal(f.events.length,2);f.control.busy=false;await b.prepare!(signal());assert.equal(f.events.length,3);assert.equal(f.events[2]!.account,f.accounts[1]!.accountId);assert.equal(f.events[2]!.preserve,true);assert.equal(f.pool.resourceStatus().pendingConversationReleases,0);assert.equal(f.pool.resourceStatus().conversationOwners,0);
  await b.generate("preserve","synthetic",signal(),conversation("B-preserve"));f.control.busy=true;await b.releaseConversation!("B-preserve",true);f.control.busy=false;await b.releaseConversation!("B-preserve",false);assert.equal(f.events.at(-1)!.preserve,true);assert.equal(f.pool.resourceStatus().pendingConversationReleases,0);
  for(let index=0;index<300;index++){const key="retired-"+index;await a.generate(key,"synthetic",signal(),conversation(key));await a.releaseConversation!(key,true);}assert.equal(f.pool.resourceStatus().conversationOwners,0);
});
test("A bound cleanup cannot route to another account or a replacement worker after identity enrollment",async t=>{
  const f=fixture(t),a=f.pool.bindAccount(f.accounts[0]!.accountId),b=f.pool.bindAccount(f.accounts[1]!.accountId);await b.generate("b","synthetic",signal(),conversation("owned-B"));
  await assert.rejects(a.releaseConversation!("owned-B",true),{code:"CONVERSATION_CHANGED"});assert.equal(f.events.length,0);
  await f.pool.verifyAccount(f.accounts[1]!.accountId,signal());f.pool.bindAccount(f.accounts[1]!.accountId);await assert.rejects(b.releaseConversation!("owned-B",true),{code:"ACCOUNT_RUNTIME_STALE"});assert.equal(f.events.length,0);
});
test("Ownership capacity rejects a new conversation before generation while existing conversations and freed slots remain usable",async t=>{
  const f=fixture(t),a=f.pool.bindAccount(f.accounts[0]!.accountId),limit=f.pool.resourceStatus().limits.conversationOwners;
  for(let index=0;index<limit;index++)await a.generate("held-"+index,"synthetic",signal(),conversation("held-"+index));
  await assert.rejects(a.generate("overflow","synthetic",signal(),conversation("overflow")),(error:NativeRouteError)=>error.code==="RESOURCE_LIMIT"&&error.delivery==="not_sent"&&error.phase==="checkpoint");assert.equal(f.sends.length,limit);
  await a.generate("same-conversation","synthetic",signal(),conversation("held-0"));await a.releaseConversation!("held-0",true);await a.generate("new-slot","synthetic",signal(),conversation("new-slot"));assert.equal(f.sends.length,limit+2);assert.equal(f.pool.resourceStatus().conversationOwners,limit);
});
test("A cleanup failure after Send can never be labeled not_sent, and untrusted BUSY-like errors are not queued",async t=>{
  const f=fixture(t),a=f.pool.bindAccount(f.accounts[0]!.accountId);await a.generate("first","synthetic",signal(),conversation("first"));f.control.releaseError={code:"BUSY"};await assert.rejects(a.releaseConversation!("first",true));assert.equal(f.pool.resourceStatus().pendingConversationReleases,0);assert.equal(f.pool.resourceStatus().conversationOwners,1);
  f.control.releaseError=undefined;f.control.busy=true;const limit=f.pool.resourceStatus().limits.deferredReleasesPerAccount;
  for(let index=0;index<limit;index++)await a.releaseConversation!("pending-"+index,true);
  f.control.generateHook=async()=>{await a.releaseConversation!("overflow-after-Send",true);return "unreachable";};
  await assert.rejects(a.generate("accepted","synthetic",signal(),conversation("accepted")),(error:NativeRouteError)=>error.code==="CLEANUP_QUEUE_FULL"&&error.delivery!=="not_sent");assert.equal(f.sends.length,2);assert.equal(f.pool.resourceStatus().pendingConversationReleases,limit);
});
test("Shutdown is terminal and idempotent; late bindings, generation and cleanup cannot reopen a worker",async t=>{
  const f=fixture(t),a=f.pool.bindAccount(f.accounts[0]!.accountId),finish=deferred();await a.generate("first","synthetic",signal(),conversation("first"));f.control.closeHook=()=>finish.promise;
  try{const closing=f.pool.close();assert.equal(f.pool.resourceStatus().lifecycle,"closing");assert.throws(()=>f.pool.bindAccount(f.accounts[0]!.accountId),{code:"SERVICE_UNAVAILABLE"});await assert.rejects(a.generate("late","synthetic",signal()),{code:"SERVICE_UNAVAILABLE"});await assert.rejects(a.releaseConversation!("first",true),{code:"SERVICE_UNAVAILABLE"});finish.resolve();await closing;await f.pool.close();assert.equal(f.control.closes,1);assert.equal(f.control.factoryCalls,1);assert.equal(f.events.length,0);assert.equal(f.sends.length,1);assert.equal(f.pool.resourceStatus().lifecycle,"closed");assert.equal(f.pool.resourceStatus().cachedWorkers,0);assert.equal(f.pool.resourceStatus().conversationOwners,0);}finally{finish.resolve();}
});
test("A failed worker close is not hidden by a second close and cannot create a replacement",async t=>{
  const f=fixture(t);f.pool.bindAccount(f.accounts[0]!.accountId);f.control.closeHook=async()=>{throw Error("Synthetic close failure");};await assert.rejects(f.pool.close(),/Synthetic close failure/);await assert.rejects(f.pool.close(),/Synthetic close failure/);assert.equal(f.control.closes,1);assert.throws(()=>f.pool.bindAccount(f.accounts[0]!.accountId),{code:"SERVICE_UNAVAILABLE"});
});
test("One failed worker close does not report the pool closed while another worker is still closing",async t=>{
  const f=fixture(t),finish=deferred();for(const account of f.accounts)f.pool.bindAccount(account.accountId);f.control.closeHook=async accountId=>{if(accountId===f.accounts[0]!.accountId)throw Error("First worker close failed");await finish.promise;};let settled=false;
  try{const closing=f.pool.close().finally(()=>{settled=true;}),checked=assert.rejects(closing,/First worker close failed/);await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);assert.equal(f.pool.resourceStatus().lifecycle,"closing");assert.equal(f.pool.resourceStatus().cachedWorkers,2);finish.resolve();await checked;assert.equal(f.control.closes,2);assert.equal(f.pool.resourceStatus().lifecycle,"closed");}finally{finish.resolve();}
});
test("Cached worker handles stay bounded even if an external registry rotates account IDs",t=>{
  const f=fixture(t),base=f.accounts[0]!,limit=f.pool.resourceStatus().limits.cachedWorkers;f.registry.get=id=>({...base,accountId:id!,profilePath:path.join(f.root,"profile-"+id),statePath:path.join(f.root,"state-"+id)});
  for(let index=0;index<limit;index++)f.pool.bindAccount("acc_rotated_"+index);
  assert.throws(()=>f.pool.bindAccount("acc_overflow"),{code:"RESOURCE_LIMIT"});assert.equal(f.control.factoryCalls,limit);assert.equal(f.pool.resourceStatus().cachedWorkers,limit);
});
test("A late BUSY cleanup cannot repopulate queues after the pool has closed",async t=>{
  const f=fixture(t),a=f.pool.bindAccount(f.accounts[0]!.accountId),finish=deferred();await a.generate("owned","synthetic",signal(),conversation("owned"));f.control.busy=true;f.control.releaseHook=()=>finish.promise;
  const pending=assert.rejects(a.releaseConversation!("owned",true),{code:"SERVICE_UNAVAILABLE"});await f.pool.close();finish.resolve();await pending;assert.equal(f.pool.resourceStatus().pendingConversationReleases,0);assert.equal(f.pool.resourceStatus().conversationOwners,0);assert.equal(f.pool.resourceStatus().lifecycle,"closed");
});
test("Identity results arriving after shutdown cannot enroll a new epoch or close a replacement",async t=>{
  const f=fixture(t),finish=deferred();f.control.identityHook=()=>finish.promise;const pending=assert.rejects(f.pool.verifyAccount(f.accounts[1]!.accountId,signal()),{code:"SERVICE_UNAVAILABLE"});await f.pool.close();finish.resolve();await pending;assert.equal(f.registry.get(f.accounts[1]!.accountId)!.identityFingerprint,undefined);assert.equal(f.registry.get(f.accounts[1]!.accountId)!.identityEpoch,0);assert.equal(f.control.closes,1);
});
test("A response completed after shutdown is rejected as unknown after its single Send",async t=>{
  const f=fixture(t),a=f.pool.bindAccount(f.accounts[0]!.accountId),finish=deferred();f.control.generateHook=async()=>{await finish.promise;return "late response";};const pending=assert.rejects(a.generate("late","synthetic",signal(),conversation("late")),(error:NativeRouteError)=>error.code==="SERVICE_UNAVAILABLE"&&error.delivery==="unknown");await f.pool.close();finish.resolve();await pending;assert.equal(f.sends.length,1);assert.equal(f.pool.resourceStatus().conversationOwners,0);
});
test("Real Native HTTP retains the failed request fence while cleanup drains only on the original owner",async t=>{
  const f=fixture(t);await f.pool.verifyAccount(f.accounts[1]!.accountId,signal());const proxy=await startNativeProxy({backend:f.pool,accountRegistry:f.registry,stateDirectory:path.join(f.root,"native"),port:0});f.control.beforeCleanup=()=>proxy.close();
  const post=async(task:string,port=proxy.port)=>{const response=await fetch("http://127.0.0.1:"+port+"/v1internal:generateContent",{method:"POST",headers:{authorization:"Bearer pool-http","content-type":"application/json"},body:JSON.stringify({model:WEB_MODEL,sessionId:task,request:{contents:[{role:"user",parts:[{text:task}]}]}})});await response.text();return response.status;};
  let fail=true;f.control.busy=true;f.control.generateHook=async(_account,options)=>{if(fail)throw new NativeRouteError("SYNTHETIC_POST_SEND_FAILURE","Synthetic accepted turn failed",502);return JSON.stringify({nonce:options!.responseNonce,type:"final",text:"synthetic HTTP reply"});};
  assert.equal(await post("failed-task-A"),502);const deadline=performance.now()+2000;while(!f.pool.resourceStatus().pendingConversationReleases&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.pool.resourceStatus().pendingConversationReleases,1);assert.equal(f.events.length,1);
  fail=false;f.registry.setActive(f.accounts[1]!.accountId);assert.equal(await post("new-task-B"),200);assert.equal(f.events.length,1);f.control.busy=false;f.registry.setActive(f.accounts[0]!.accountId);assert.equal(await post("new-task-A"),200);assert.equal(f.pool.resourceStatus().pendingConversationReleases,0);assert.equal(f.events.length,2);assert.ok(f.events.every(event=>event.account===f.accounts[0]!.accountId));assert.equal(await post("failed-task-A"),502);assert.equal(f.sends.length,3);
  const health=await fetch("http://127.0.0.1:"+proxy.port+"/__native/health").then(response=>response.json());assert.equal(health.backendResources.conversationOwners,2);assert.equal(health.backendResources.pendingConversationReleases,0);assert.ok(!JSON.stringify(health.backendResources).includes(f.root));
  await proxy.close();const restarted=await startNativeProxy({backend:new NativeBrowserBackendPool(f.registry,"unused",f.factory),accountRegistry:f.registry,stateDirectory:path.join(f.root,"native"),port:0});f.control.beforeCleanup=()=>restarted.close();assert.equal(await post("failed-task-A",restarted.port),409);assert.equal(f.sends.length,3);
});
