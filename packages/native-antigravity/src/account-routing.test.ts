import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountRegistry } from "./account-registry.js";
import { NativeBrowserBackendPool } from "./browser-backend-pool.js";
import type { NativeBrowserBackend,NativeGenerationOptions } from "./browser-backend.js";
import { startNativeProxy } from "./native-proxy.js";
import { NativeRequestLedger } from "./request-ledger.js";
import { compileNativeTurn,sha256,WEB_MODEL,NativeRouteError } from "./native-protocol.js";
import type { AccountRecord } from "@antigravity-gemini-web/contracts";

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const policy={model:"Fixture Model",effort:"Low"};
const body=(chat:string,text=chat)=>({model:WEB_MODEL,sessionId:chat,conversationId:chat,request:{contents:[{role:"user",parts:[{text}]}]}});
const authorization="Bearer routing-fixture",token="owned-routing-fixture";
function unsent(code="MODEL_UNAVAILABLE"){const error=new NativeRouteError(code,"Trusted synthetic pre-Send failure",412);error.delivery="not_sent";error.phase="model_selection";return error;}
const final=(options:NativeGenerationOptions|undefined,text:string)=>JSON.stringify({nonce:options!.responseNonce,type:"final",text});
async function fixture(t:test.TestContext,factory:(account:AccountRecord)=>NativeBrowserBackend,experimental=true,cleanup=()=>{}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"ag-account-routing-")),state=path.join(root,"native"),registry=new AccountRegistry(path.join(root,"accounts.json"));
  const accounts=["A","B"].map((name,i)=>registry.add({displayName:name,profilePath:path.join(root,"profile"+name),statePath:path.join(root,"state"+name),debugPort:14001+i,identityFingerprint:sha256(name)}));registry.setActive(accounts[0].accountId);
  const pool=new NativeBrowserBackendPool(registry,"unused",factory),proxy=await startNativeProxy({backend:pool,accountRegistry:registry,stateDirectory:state,port:0,controlToken:token,routingExperimental:experimental,control:async()=>{throw Error("No external requests");}});
  const endpoint="http://127.0.0.1:"+proxy.port;
  t.after(async()=>{cleanup();await proxy.close();await tick();assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith("ag-account-routing-"));fs.rmSync(root,{recursive:true,force:true});});
  const post=async(route:string,value:unknown,authorized=true)=>{const response=await fetch(endpoint+route,{method:"POST",headers:{"content-type":"application/json",authorization,...(authorized?{"x-native-control-token":token}:{})},body:JSON.stringify(value),signal:AbortSignal.timeout(12000)});return {status:response.status,data:await response.json() as any};};
  const health=async()=>fetch(endpoint+"/__native/health").then(response=>response.json() as Promise<any>);
  const configure=async(mode:string,modelSelection:typeof policy|undefined=policy,failover?:{enabled:boolean;maxAttempts?:number;deadlineMs?:number})=>post("/__native/router",{action:"configure",expectedRevision:(await post("/__native/router",{action:"status"})).data.revision,settings:{mode,modelSelection,...(failover?{failover}:{})}});
  return {root,state,registry,accounts,pool,proxy,post,health,configure};
}

test("HTTP priority routing runs two independent chats on separate accounts, coalesces retries and serializes one chat",{timeout:20000},async t=>{
  const started=new Map(["A","B"].map(name=>[name,deferred()])),finish=new Map(["A","B"].map(name=>[name,deferred()])),sends:string[]=[];
  const f=await fixture(t,account=>({prepare:async()=>{},generate:async(_id,_prompt,_signal,options)=>{assert.deepEqual(options?.modelSelection,policy);assert.equal(options?.parallelAccountRouting,true);options?.onSubmissionStarted?.();sends.push(account.displayName);started.get(account.displayName)!.resolve();await finish.get(account.displayName)!.promise;return final(options,account.displayName);},close:async()=>{}}),true,()=>{for(const value of finish.values())value.resolve();});
  assert.equal((await f.configure("priority")).status,200);
  const a=f.post("/v1internal:generateContent",body("chat-a"));await started.get("A")!.promise;
  const duplicate=f.post("/v1internal:generateContent",body("chat-a"));
  const b=f.post("/v1internal:generateContent",body("chat-b"));await started.get("B")!.promise;
  assert.equal((await f.health()).counters.active,2);const status=await f.post("/__native/router",{action:"status"});assert.equal(status.data.activeLeases.length,2);
  assert.equal((await f.post("/v1internal:generateContent",body("chat-a","later context"))).status,409);
  assert.equal((await f.configure("manual",undefined)).status,409);
  finish.get("A")!.resolve();finish.get("B")!.resolve();
  const results=await Promise.all([a,duplicate,b]);assert.ok(results.every(result=>result.status===200));assert.deepEqual(results[0].data,results[1].data);assert.deepEqual(sends.sort(),["A","B"]);
  assert.equal((await f.health()).routing.activeLeases.length,0);
});

test("Pre-Send failover A to B retains both receipt owners, coalesces retry and blocks stale A callbacks",{timeout:20000},async t=>{
  const started=deferred(),finish=deferred(),attempted:string[]=[],sends:string[]=[],owners=new Map<string,NonNullable<NativeGenerationOptions["receiptOwner"]>>();let old:NativeGenerationOptions|undefined;
  const f=await fixture(t,account=>({prepare:async()=>{},close:async()=>{},generate:async(id,_prompt,_signal,options)=>{
    attempted.push(account.displayName);assert.deepEqual(options?.modelSelection,policy);options!.onPhysicalSubmission!(id);options!.onSubmissionStarted!();owners.set(id,options!.receiptOwner!);
    if(account.displayName==="A"){old=options;throw unsent();}
    assert.equal(options?.conversation?.baseRevision,undefined);sends.push("B");started.resolve();await finish.promise;return final(options,"B");
  },inspectReceipt:async id=>({requestId:id,found:true,receipt:{requestId:id,hash:sha256(id),phase:"terminal",attemptId:owners.get(id)!.logicalAttemptId,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),owner:owners.get(id)},replayAllowed:false,resultAvailable:true})}),true,finish.resolve);
  assert.equal((await f.configure("priority",policy,{enabled:true,maxAttempts:2})).status,200);
  const request=body("failover-a-b"),pending=f.post("/v1internal:generateContent",request);await started.promise;
  const duplicate=f.post("/v1internal:generateContent",request);
  assert.throws(()=>old!.onPhysicalSubmission!("stale_A_physical"),{code:"STALE_AUTHORITY"});assert.throws(()=>old!.onSubmissionStarted!(),{code:"STALE_AUTHORITY"});
  old!.onProgress!({revision:100,text:'{"nonce":"obsolete","type":"final","text":"WRONG_ACCOUNT"}'});
  assert.equal((await f.post("/v1internal:generateContent",body("failover-a-b","concurrent same-chat turn"))).status,409);
  finish.resolve();const results=await Promise.all([pending,duplicate]);assert.ok(results.every(value=>value.status===200));assert.deepEqual(results[0].data,results[1].data);
  assert.deepEqual(attempted,["A","B"]);assert.deepEqual(sends,["B"]);
  const state=await f.health();assert.equal(state.routing.failoverEnabled,true);assert.equal(state.lastTurn.failoverCount,1);assert.equal(state.routing.activeLeases.length,0);
  const receipt=await f.post("/__native/reconcile",{requestId:state.lastTurn.requestId});assert.equal(receipt.status,200);assert.equal(receipt.data.logical.version,2);
  assert.deepEqual(receipt.data.physical.map((item:any)=>item.accountId),f.accounts.map(account=>account.accountId));assert.ok(receipt.data.physical.every((item:any)=>item.correlation==="verified"));assert.equal(receipt.data.replayAllowed,false);
});

test("Failover survives an A preparation failure and commits a sticky B binding only after reserving B",async t=>{
  const generated:string[]=[],bases:Array<string|undefined>=[];
  const f=await fixture(t,account=>({prepare:async()=>{if(account.displayName==="A")throw unsent();},close:async()=>{},generate:async(_id,_prompt,_signal,options)=>{generated.push(account.displayName);bases.push(options?.conversation?.baseRevision);options?.onSubmissionStarted?.();return final(options,"primary model B");}}));
  assert.equal((await f.configure("sticky",policy,{enabled:true})).status,200);
  assert.equal((await f.post("/v1internal:generateContent",body("sticky-failover"))).status,200);
  const routing=await f.post("/__native/router",{action:"status"});assert.equal(routing.data.bindings[0].accountId,f.accounts[1].accountId);
  assert.equal((await f.post("/v1internal:generateContent",body("sticky-failover","new follow-up"))).status,200);
  assert.deepEqual(generated,["B","B"]);assert.equal(bases[0],undefined);assert.ok(bases[1]);
});

test("An attempted Send vetoes a conflicting not_sent error, and verification/generic errors never switch accounts",async t=>{
  for(const kind of ["send_attempted","captcha","generic_error"]){
    const calls:string[]=[];const f=await fixture(t,account=>({prepare:async()=>{},close:async()=>{},generate:async(_id,_prompt,_signal,options)=>{
      calls.push(account.displayName);if(kind==="generic_error")throw {code:"MODEL_UNAVAILABLE",delivery:"not_sent",phase:"model_selection"};
      if(kind==="send_attempted")options?.onTransportTrace?.({messageIndex:1,messageCount:1,kind:"text",stage:"failed",promptChars:8,promptBytes:8,promptSha256:sha256("fixture"),elapsedMs:1,submission:{inputChars:8,readbackVerified:true,sendClickAttempted:true,acceptanceObserved:false}});
      throw unsent(kind==="captcha"?"BROWSER_USER_ACTION_REQUIRED":"MODEL_UNAVAILABLE");
    }}));
    await f.configure("priority",policy,{enabled:true});const result=await f.post("/v1internal:generateContent",body("veto-"+kind));assert.notEqual(result.status,200);assert.deepEqual(calls,["A"]);
    const receipt=new NativeRequestLedger(path.join(f.state,"native-turn-ledger")).inspect((await f.health()).lastTurn.requestId)!;
    assert.equal(receipt.version,2);assert.equal(receipt.state,kind==="captcha"?"not_sent":"unknown");assert.equal(receipt.version===2&&receipt.previousAttempts.length,0);
  }
});

test("An exhausted failover request keeps its budget across retries and native restart",async t=>{
  let generated=0;const factory=()=>({prepare:async()=>{},close:async()=>{},generate:async()=>{generated++;throw unsent();}});
  const f=await fixture(t,factory);await f.configure("priority",policy,{enabled:true,maxAttempts:2});const request=body("finite-failover");
  assert.equal((await f.post("/v1internal:generateContent",request)).status,412);assert.equal(generated,2);
  assert.equal((await f.post("/v1internal:generateContent",request)).status,412);assert.equal(generated,2);
  const health=await f.health();assert.equal(health.lastTurn.failoverStopped,"attempt_budget");
  const ledger=new NativeRequestLedger(path.join(f.state,"native-turn-ledger")),saved=ledger.inspect(health.lastTurn.requestId)!;assert.equal(saved.version===2&&saved.terminal,true);
  await f.proxy.close();
  const pool=new NativeBrowserBackendPool(f.registry,"unused",factory),restarted=await startNativeProxy({backend:pool,accountRegistry:f.registry,stateDirectory:f.state,port:0,routingExperimental:true});t.after(()=>restarted.close());
  const response=await fetch("http://127.0.0.1:"+restarted.port+"/v1internal:generateContent",{method:"POST",headers:{authorization,"content-type":"application/json"},body:JSON.stringify(request)});
  assert.equal(response.status,409);assert.equal((await response.json()).error.details[0].reason,"OUTCOME_UNKNOWN");assert.equal(generated,2);
});

test("The monotonic failover deadline prevents a late second account, even with proven not_sent",async t=>{
  const calls:string[]=[];const f=await fixture(t,account=>({prepare:async()=>{},close:async()=>{},generate:async()=>{calls.push(account.displayName);await new Promise(resolve=>setTimeout(resolve,1100));throw unsent();}}));
  await f.configure("priority",policy,{enabled:true,deadlineMs:1000});assert.equal((await f.post("/v1internal:generateContent",body("late-no-send"))).status,412);
  assert.deepEqual(calls,["A"]);assert.equal((await f.health()).lastTurn.failoverStopped,"deadline");
});

test("Cancellation retains a preparing account lease until its real operation settles, without starting failover",{timeout:20000},async t=>{
  const started=deferred(),finish=deferred(),sends:string[]=[];
  const f=await fixture(t,account=>({prepare:async()=>{if(account.displayName==="A"){started.resolve();await finish.promise;}},close:async()=>{},generate:async(_id,_prompt,_signal,options)=>{sends.push(account.displayName);return final(options,account.displayName);}}),true,finish.resolve);
  await f.configure("priority",policy,{enabled:true});const pending=f.post("/v1internal:generateContent",body("cancel-preparation"));await started.promise;
  await f.post("/__native/cancel",{});assert.equal((await pending).status,499);assert.equal((await f.health()).routing.activeLeases.length,1);
  assert.equal((await f.post("/v1internal:generateContent",body("cancel-preparation","same chat while prepare is still live"))).status,409);
  assert.equal((await f.post("/v1internal:generateContent",body("independent-B"))).status,200);assert.deepEqual(sends,["B"]);
  finish.resolve();for(let i=0;i<30&&(await f.health()).routing.activeLeases.length;i++)await tick();assert.equal((await f.health()).routing.activeLeases.length,0);assert.deepEqual(sends,["B"]);
});

test("A cancelled HTTP turn retains its account lease until backend settlement and stale callbacks cannot submit again",{timeout:20000},async t=>{
  const started=deferred(),finish=deferred();let oldOptions:NativeGenerationOptions|undefined;const sends:string[]=[];
  const f=await fixture(t,account=>({prepare:async()=>{},generate:async(_id,_prompt,_signal,options)=>{options?.onSubmissionStarted?.();sends.push(account.displayName);if(account.displayName==="A"){oldOptions=options;started.resolve();await finish.promise;}return final(options,account.displayName);},close:async()=>{}}),true,finish.resolve);
  assert.equal((await f.configure("priority")).status,200);
  const pending=f.post("/v1internal:generateContent",body("cancel-a"));await started.promise;
  await f.post("/__native/cancel",{});assert.equal((await pending).status,499);
  assert.equal((await f.health()).counters.active,0);assert.equal((await f.health()).routing.activeLeases.length,1);
  assert.throws(()=>oldOptions!.onPhysicalSubmission!("late_physical_request"),{code:"STALE_AUTHORITY"});assert.throws(()=>oldOptions!.onSubmissionStarted!(),{code:"STALE_AUTHORITY"});
  assert.equal((await f.post("/__native/account",{action:"disable",accountId:f.accounts[0].accountId})).status,409);
  assert.equal((await f.post("/v1internal:generateContent",body("independent-b"))).status,200);
  finish.resolve();for(let i=0;i<30&&(await f.health()).routing.activeLeases.length;i++)await tick();
  assert.equal((await f.health()).routing.activeLeases.length,0);
  const unresolved=await f.post("/v1internal:generateContent",body("cancel-a","new follow-up while outcome is unknown"));assert.equal(unresolved.status,409);assert.equal(unresolved.data.error.details[0].reason,"OUTCOME_UNKNOWN");assert.deepEqual(sends,["A","B"]);
});

test("Router owner controls validate authorization, runtime opt-in, fixed model, round-robin consent and revision",async t=>{
  const f=await fixture(t,()=>({generate:async()=>{throw Error("No generation allowed");},close:async()=>{}}),false);
  assert.equal((await f.post("/__native/router",{action:"status"},false)).status,401);
  assert.equal((await f.configure("priority")).status,412);
  assert.equal((await f.post("/__native/router",{action:"configure",expectedRevision:0,settings:{mode:"priority"}})).status,400);
  assert.equal((await f.post("/__native/router",{action:"configure",expectedRevision:0,settings:{mode:"round_robin",modelSelection:policy}})).status,400);
  assert.equal((await f.configure("manual",undefined)).status,200);
  assert.equal((await f.post("/__native/router",{action:"configure",expectedRevision:0,settings:{mode:"manual"}})).status,409);
  assert.equal((await f.health()).routing.failoverEnabled,false);
});

test("Owner controls reject invalid failover budgets and manual failover without backend calls",async t=>{
  let calls=0;const f=await fixture(t,()=>({generate:async()=>{calls++;throw Error("No Send allowed");},close:async()=>{}}));
  for(const settings of [
    {mode:"manual",failover:{enabled:true}},
    {mode:"priority",modelSelection:policy,failover:{enabled:true,maxAttempts:5}},
    {mode:"priority",modelSelection:policy,failover:{enabled:true,deadlineMs:120001}},
    {mode:"priority",modelSelection:policy,failover:{enabled:true,deadlineMs:999}},
  ])assert.equal((await f.post("/__native/router",{action:"configure",expectedRevision:0,settings})).status,400);
  assert.equal(calls,0);assert.equal((await f.post("/__native/router",{action:"status"})).data.revision,0);
});

test("An explicitly resumed Web conversation cannot fail over to another account",async t=>{
  const calls:string[]=[];const f=await fixture(t,account=>({prepare:async()=>{},generate:async(_id,_prompt,_signal,options)=>{calls.push(account.displayName);assert.equal(options?.conversation?.resumeUrl,"https://gemini.google.com/app/fixtureResume");throw unsent();},close:async()=>{}}));
  await f.configure("priority",policy,{enabled:true});
  assert.equal((await f.post("/__native/resume",{url:"https://gemini.google.com/app/fixtureResume",nextTurn:true})).status,200);
  assert.equal((await f.post("/v1internal:generateContent",body("pinned-resume"))).status,412);
  assert.deepEqual(calls,["A"]);assert.equal((await f.health()).routing.activeLeases.length,0);
});

test("Manual HTTP routing rejects an unenrolled identity before calling any backend",async t=>{
  let calls=0;const f=await fixture(t,()=>({generate:async()=>{calls++;throw Error("No Send allowed");},close:async()=>{}}),false);
  f.registry.update(f.accounts[0].accountId,{identityFingerprint:undefined});
  const result=await f.post("/v1internal:generateContent",body("unverified"));assert.equal(result.status,412);assert.equal(result.data.error.details[0].reason,"ACCOUNT_IDENTITY_UNVERIFIED");assert.equal(calls,0);assert.equal((await f.health()).routing.activeLeases.length,0);
});

test("An existing logical fence cannot create a phantom sticky binding or strand an account lease",async t=>{
  const f=await fixture(t,()=>({generate:async()=>{throw Error("No generation allowed");},close:async()=>{}}));
  assert.equal((await f.configure("sticky")).status,200);
  const request=body("fenced-chat"),compiled=compileNativeTurn(request,sha256(authorization));
  new NativeRequestLedger(path.join(f.state,"native-turn-ledger")).reserve(compiled.requestId,f.accounts[0].accountId,f.accounts[0].identityEpoch);
  assert.equal((await f.post("/v1internal:generateContent",request)).status,409);
  const status=await f.post("/__native/router",{action:"status"});assert.equal(status.data.bindings.length,0);assert.equal(status.data.activeLeases.length,0);
});

test("A registry change between router selection and worker binding cannot associate a new identity with the old epoch",async t=>{
  let calls=0;const f=await fixture(t,()=>({prepare:async()=>{calls++;},generate:async()=>{calls++;throw Error("No Send allowed");},close:async()=>{}}));
  const bind=f.pool.bindAccount.bind(f.pool);let changed=false;
  f.pool.bindAccount=(id,expected)=>{if(!changed){changed=true;f.registry.update(id,{identityFingerprint:sha256("changed between snapshots")});}return bind(id,expected);};
  const response=await f.post("/v1internal:generateContent",body("identity-admission-race"));assert.equal(response.status,412);assert.equal(response.data.error.details[0].reason,"STALE_ACCOUNT_SELECTION");assert.equal(calls,0);assert.equal((await f.health()).routing.activeLeases.length,0);
});

test("Retiring an idle conversation defers only its busy owner and never disturbs another account",async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"ag-account-routing-")),registry=new AccountRegistry(path.join(root,"accounts.json")),events:string[]=[];let busy=false;
  t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith("ag-account-routing-"));fs.rmSync(root,{recursive:true,force:true});});
  const accounts=["A","B"].map((name,i)=>registry.add({displayName:name,profilePath:path.join(root,"p"+name),statePath:path.join(root,"s"+name),debugPort:15001+i,identityFingerprint:sha256(name)}));
  const pool=new NativeBrowserBackendPool(registry,"unused",account=>({prepare:async()=>{},generate:async()=>"done",releaseConversation:async key=>{events.push(account.displayName+":"+key);if(busy&&account.displayName==="B")throw new NativeRouteError("BUSY","B is still generating",409);},close:async()=>{}}));
  try {
    const b=pool.bindAccount(accounts[1].accountId),a=pool.bindAccount(accounts[0].accountId);
    await b.generate("old","prompt",new AbortController().signal,{conversation:{key:"owned_B_old",revision:sha256("old")}});
    busy=true;await pool.releaseConversation("owned_B_old");assert.deepEqual(events,["B:owned_B_old"]);
    await a.generate("a","prompt",new AbortController().signal);assert.deepEqual(events,["B:owned_B_old"]);
    busy=false;await b.prepare!(new AbortController().signal);assert.deepEqual(events,["B:owned_B_old","B:owned_B_old"]);
  }finally{await pool.close();}
});
