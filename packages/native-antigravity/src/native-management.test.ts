import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NativeManagementSnapshotSchema,type NativeManagementSnapshot } from "@antigravity-gemini-web/contracts";
import { AccountRegistry } from "./account-registry.js";
import { NativeBrowserBackendPool } from "./browser-backend-pool.js";
import { startNativeProxy } from "./native-proxy.js";
import { NativeRouteError,sha256,WEB_MODEL } from "./native-protocol.js";
import { buildManagementSnapshot } from "./management-snapshot.js";
import { NativeAccountRouter } from "./account-router.js";

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function fixture(t:test.TestContext){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"ag-management-")),registry=new AccountRegistry(path.join(root,"accounts.json"));
  const accounts=["A","B"].map((displayName,index)=>registry.add({displayName,profilePath:path.join(root,"profile"+index),statePath:path.join(root,"state"+index),debugPort:16001+index,identityFingerprint:index===0?sha256("a@fixture.invalid"):undefined}));
  const calls={opens:0,checks:0,generations:0};let checkGate:ReturnType<typeof deferred>|undefined,generationGate:ReturnType<typeof deferred>|undefined,identityError:NativeRouteError|undefined;
  const pool=new NativeBrowserBackendPool(registry,"unused",account=>({close:async()=>{},prepare:async()=>{},openBrowser:async()=>{calls.opens++;return {opened:true};},inspectIdentity:async()=>{calls.checks++;await checkGate?.promise;if(identityError)throw identityError;return {accountIdentity:account.displayName.toLowerCase()+"@fixture.invalid"};},generate:async(_id,_prompt,signal,options)=>{calls.generations++;options?.onSubmissionStarted?.();await generationGate?.promise;signal.throwIfAborted();return JSON.stringify({nonce:options!.responseNonce,type:"final",text:"synthetic"});}}));
  const token="f".repeat(64),proxy=await startNativeProxy({backend:pool,accountRegistry:registry,stateDirectory:path.join(root,"native"),port:0,controlToken:token});
  const base="http://127.0.0.1:"+proxy.port;
  const post=async(value:unknown,authorized=true)=>{const response=await fetch(base+"/__native/manage",{method:"POST",headers:{"content-type":"application/json",...(authorized?{"x-native-control-token":token}:{})},body:JSON.stringify(value),signal:AbortSignal.timeout(10000)});return {status:response.status,data:await response.json() as any};};
  const status=async()=>{const response=await post({action:"status"});assert.equal(response.status,200);return NativeManagementSnapshotSchema.parse(response.data);};
  const command=async(value:Record<string,unknown>,snapshot?:NativeManagementSnapshot)=>{const current=snapshot??await status();return post({expectedOwnerId:current.ownerId,expectedRevision:current.revision,...value});};
  t.after(async()=>{checkGate?.resolve();generationGate?.resolve();await proxy.close();const resolved=fs.realpathSync(root);assert.equal(path.dirname(resolved).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(resolved).startsWith("ag-management-"));fs.rmSync(resolved,{recursive:true,force:true});});
  return {root,registry,accounts,calls,post,status,command,base,holdCheck:()=>checkGate=deferred(),holdGeneration:()=>generationGate=deferred(),setIdentityError:(error:NativeRouteError)=>{identityError=error;}};
}

test("Management status is owner-authenticated, redacted and does not start a browser",async t=>{
  const f=await fixture(t);assert.equal((await f.post({action:"status"},false)).status,401);
  const malformed=await fetch(f.base+"/__native/manage",{method:"POST",headers:{"x-native-control-token":"é".repeat(64),"content-type":"application/json"},body:'{"action":"status"}'});assert.equal(malformed.status,401);
  const status=await f.status();assert.equal(status.accounts.length,2);assert.equal(status.canMutate,true);assert.equal(status.accounts[0].state,"unverified");assert.equal(status.accounts[0].identityVerified,false);
  assert.ok(!/profilePath|statePath|identityFingerprint|debugPort|controlToken|prompt|cookie/i.test(JSON.stringify(status)));
  assert.deepEqual(f.calls,{opens:0,checks:0,generations:0});
});

test("Management status surfaces the rejected model selector without leaking request content",async t=>{
  const f=await fixture(t);
  const rejected=await fetch(f.base+"/v1internal:generateContent",{method:"POST",headers:{authorization:"Bearer fixture","content-type":"application/json"},body:JSON.stringify({model:"wrong-web-model",sessionId:"model-selector-fixture",request:{contents:[{role:"user",parts:[{text:"private prompt text"}]}]}})});
  assert.equal(rejected.status,409);const status=await f.status();
  assert.equal(status.latestIssue?.code,"NATIVE_MODEL_NOT_SELECTED");assert.equal(status.latestIssue?.expectedModel,WEB_MODEL);
  assert.deepEqual(status.latestIssue?.receivedModelSelectors,{model:"wrong-web-model"});
  assert.ok(!JSON.stringify(status).includes("private prompt text"));assert.equal(f.calls.generations,0);
});

test("Sticky routing is configurable through revision-bound management without selecting a Web model",async t=>{
  const f=await fixture(t),before=await f.status();
  const stale=await f.command({action:"configure_routing",settings:{mode:"sticky"},expectedRoutingRevision:before.routing.revision+1},before);
  assert.equal(stale.status,409);assert.equal(stale.data.error.code,"STALE_ROUTING_REVISION");
  const configured=await f.command({action:"configure_routing",settings:{mode:"sticky"},expectedRoutingRevision:before.routing.revision},before);
  assert.equal(configured.status,200);assert.equal(configured.data.routing.mode,"sticky");assert.equal(configured.data.routing.automaticEnabled,true);
  assert.equal(configured.data.routing.experimentalEnabled,false);assert.equal(configured.data.routing.modelSelection,undefined);
  assert.deepEqual(f.calls,{opens:0,checks:0,generations:0});
});

test("Adding an account uses owner-generated paths and rejects stale owner/revision or caller paths",async t=>{
  const f=await fixture(t),before=await f.status();
  assert.equal((await f.command({action:"add",displayName:"New",profilePath:"C:/untrusted"},before)).status,400);
  assert.equal((await f.command({action:"add",displayName:"New",expectedOwnerId:randomUUID()},before)).status,409);
  const added=await f.command({action:"add",displayName:"Secondary"},before);assert.equal(added.status,200);assert.equal(added.data.accounts.length,3);
  const account=f.registry.list().find(row=>row.displayName==="Secondary")!;assert.ok(path.relative(path.join(f.root,"native","accounts"),account.profilePath).match(/^[^\\/]+[\\/]profile$/));assert.notEqual(account.profilePath,account.statePath);
  assert.equal((await f.command({action:"add",displayName:"Duplicate from stale UI"},before)).status,409);assert.equal(f.registry.list().length,3);assert.deepEqual(f.calls,{opens:0,checks:0,generations:0});
});

test("Profile opening, identity enrollment and selection share the native pool without sending prompts",async t=>{
  const f=await fixture(t),id=f.accounts[1].accountId;
  assert.equal((await f.command({action:"open",accountId:id})).status,200);assert.equal(f.calls.opens,1);
  const checked=await f.command({action:"verify",accountId:id});assert.equal(checked.status,200);assert.equal(checked.data.accounts[1].identityVerified,true);assert.equal(checked.data.accounts[1].identityEpoch,1);
  assert.equal((await f.command({action:"use",accountId:id})).status,200);assert.equal((await f.status()).selectedAccountId,id);
  await f.command({action:"open",accountId:id});assert.equal((await f.status()).accounts[1].identityVerified,false);
  await f.command({action:"disable",accountId:id});assert.equal((await f.status()).accounts[1].state,"disabled");assert.equal((await f.status()).selectedAccountId,f.accounts[0].accountId);
  await f.command({action:"enable",accountId:id});assert.equal((await f.status()).accounts[1].enabled,true);assert.equal(f.calls.generations,0);
});

test("Existing Chrome accounts retain their extension transport through owner admission and sanitized snapshots",async t=>{
  const f=await fixture(t),before=await f.status();
  assert.equal((await f.command({action:"add",displayName:"Invalid",browserTransport:"unknown"},before)).status,400);
  const added=await f.command({action:"add",displayName:"Chrome profile",browserTransport:"extension"},before);
  assert.equal(added.status,200);
  const account=f.registry.list().find(row=>row.displayName==="Chrome profile")!;
  assert.equal(account.browserTransport,"extension");
  assert.equal(added.data.accounts.find((row:{accountId:string})=>row.accountId===account.accountId).browserTransport,"extension");
  assert.equal((await f.command({action:"open",accountId:account.accountId})).status,200);
  assert.equal(f.calls.opens,1);assert.equal(f.calls.generations,0);
  assert.ok(!/profilePath|statePath|identityFingerprint|token/i.test(JSON.stringify(added.data)));
});

test("Extension pairing is owner- and revision-bound and never appears in status",async t=>{
  const f=await fixture(t),added=await f.command({action:"add",displayName:"Pair target",browserTransport:"extension"});assert.equal(added.status,200);
  const account=f.registry.list().find(row=>row.displayName==="Pair target")!;
  const before=await f.status();
  const send=async(body:unknown)=>{const response=await fetch(f.base+"/__native/pairing",{method:"POST",headers:{"content-type":"application/json","x-native-control-token":"f".repeat(64)},body:JSON.stringify(body)});return {status:response.status,data:await response.json() as any};};
  assert.equal((await send({action:"create",accountId:account.accountId,expectedOwnerId:randomUUID(),expectedRevision:before.revision})).status,409);
  assert.equal((await send({action:"create",accountId:account.accountId,expectedOwnerId:before.ownerId,expectedRevision:before.revision-1})).status,409);
  const result=await send({action:"create",accountId:account.accountId,expectedOwnerId:before.ownerId,expectedRevision:before.revision});assert.equal(result.status,200);
  assert.match(result.data.pairingCode,/^agc1\.[A-Za-z0-9_-]+$/);
  const decoded=JSON.parse(Buffer.from(result.data.pairingCode.slice(5),"base64url").toString("utf8"));
  assert.equal(decoded.port,account.debugPort);assert.equal(decoded.name,"Pair target");assert.equal(decoded.version,1);assert.equal(decoded.profileId.length,36);assert.equal(decoded.token.length,64);
  assert.ok(!JSON.stringify(await f.status()).includes(result.data.pairingCode));
  const cdp=await send({action:"create",accountId:f.accounts[0].accountId,expectedOwnerId:before.ownerId,expectedRevision:before.revision});assert.equal(cdp.status,400);
});

test("Removing an account requires it to be unselected and unbound and preserves its profile files",async t=>{
  const f=await fixture(t),selected=await f.status(),a=f.accounts[0],b=f.accounts[1];
  const rejected=await f.command({action:"remove",accountId:a.accountId,expectedRoutingRevision:selected.routing.revision},selected);
  assert.equal(rejected.status,409);assert.equal(rejected.data.error.code,"ACCOUNT_SELECTED");
  fs.mkdirSync(b.profilePath,{recursive:true});const marker=path.join(b.profilePath,"keep.txt");fs.writeFileSync(marker,"preserve profile data");
  const removed=await f.command({action:"remove",accountId:b.accountId,expectedRoutingRevision:selected.routing.revision},selected);
  assert.equal(removed.status,200);assert.deepEqual(removed.data.accounts.map((row:{accountId:string})=>row.accountId),[a.accountId]);assert.ok(fs.existsSync(marker));
  const only=await f.status(),last=await f.command({action:"remove",accountId:a.accountId,expectedRoutingRevision:only.routing.revision},only);
  assert.equal(last.status,409);assert.equal(last.data.error.code,"LAST_ACCOUNT");
});

test("Account removal refuses to orphan project knowledge bindings",async t=>{
  const f=await fixture(t),snapshot=await f.status(),account=f.accounts[1]!,now=new Date().toISOString(),sourceId=randomUUID();
  const knowledge={version:1,revision:1,sources:[{sourceId,kind:"gem",label:"Reference",url:"https://gemini.google.com/gem/fixture",instructionVersion:"native_knowledge_reference_v1",createdAt:now,updatedAt:now,revision:1}],bindings:[{taskScope:"a".repeat(64),accountId:account.accountId,identityEpoch:0,sourceIds:[sourceId],updatedAt:now}]};
  fs.mkdirSync(path.join(f.root,"native"),{recursive:true});fs.writeFileSync(path.join(f.root,"native","knowledge.json"),JSON.stringify(knowledge));
  const result=await f.command({action:"remove",accountId:account.accountId,expectedRoutingRevision:snapshot.routing.revision},snapshot);
  assert.equal(result.status,409);assert.equal(result.data.error.code,"ACCOUNT_BOUND");assert.ok(f.registry.get(account.accountId));
});

test("Status remains readable during verification, while concurrent mutations fail closed",async t=>{
  const f=await fixture(t),gate=f.holdCheck(),snapshot=await f.status(),pending=f.command({action:"verify",accountId:f.accounts[0].accountId},snapshot);
  for(let i=0;i<30&&!f.calls.checks;i++)await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.calls.checks,1);
  const busy=await f.status();assert.equal(busy.accountControlActive,true);assert.equal(busy.canMutate,false);
  assert.equal((await f.command({action:"use",accountId:f.accounts[1].accountId},busy)).status,409);
  gate.resolve();assert.equal((await pending).status,200);assert.equal((await f.status()).canMutate,true);
});

test("Traffic verification is shown as user action, and resume is armed without replay",async t=>{
  const f=await fixture(t);f.setIdentityError(new NativeRouteError("BROWSER_USER_ACTION_REQUIRED","private DOM details must not enter status",412));
  assert.equal((await f.command({action:"verify",accountId:f.accounts[0].accountId})).status,412);
  assert.equal((await f.status()).accounts[0].state,"verification_required");assert.ok(!JSON.stringify(await f.status()).includes("private DOM"));
  assert.equal((await f.command({action:"resume",url:"https://gemini.google.com/app/owned?wrong=1"})).status,400);
  assert.equal((await f.command({action:"resume",url:"https://gemini.google.com/app/owned"})).status,200);assert.equal((await f.status()).resumeArmed,true);
  await f.command({action:"clear_resume"});assert.equal((await f.status()).resumeArmed,false);assert.equal(f.calls.generations,0);
});

test("A cancelled turn keeps its account busy until backend settlement; management never claims confirmed Stop",async t=>{
  const f=await fixture(t),gate=f.holdGeneration();
  const pending=fetch(f.base+"/v1internal:generateContent",{method:"POST",headers:{authorization:"Bearer fixture","content-type":"application/json"},body:JSON.stringify({model:WEB_MODEL,sessionId:"management-cancel",request:{contents:[{role:"user",parts:[{text:"synthetic"}]}]}})});
  for(let i=0;i<40&&!f.calls.generations;i++)await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.calls.generations,1);
  const busy=await f.status();assert.equal(busy.activeTurns.length,1);assert.equal(busy.canMutate,false);
  assert.equal((await f.command({action:"cancel"},busy)).status,200);assert.equal((await pending).status,499);
  const stopping=await f.status();assert.equal(stopping.activeTurns[0].phase,"stopping");assert.equal(stopping.canMutate,false);assert.notEqual(stopping.lastOutcome?.browserStopConfirmed,true);
  assert.notEqual(stopping.accounts[0].reasonCode,"CANCELLED");
  assert.equal((await f.command({action:"use",accountId:f.accounts[1].accountId},stopping)).status,409);
  gate.resolve();for(let i=0;i<30&&!(await f.status()).canMutate;i++)await new Promise<void>(resolve=>setImmediate(resolve));assert.equal((await f.status()).canMutate,true);
});

test("Identity observations expire and future-dated checks never become fresh ready state",async t=>{
  const f=await fixture(t),registry=f.registry.snapshot(),router=new NativeAccountRouter(f.registry,path.join(f.root,"status-routing.json")),id=f.accounts[0].accountId;
  for(const time of [Date.now()-31000,Date.now()+60000]){
    const result=buildManagementSnapshot({ownerId:randomUUID(),runtimeRevision:32,registry,router:router.snapshot(),canMutate:true,accountControlActive:false,resumeArmed:false,verified:new Map([[id,{epoch:1,observedAt:new Date(time).toISOString()}]]),failures:new Map(),turns:new Map(),lastTurn:undefined});
    assert.equal(result.accounts[0].identityVerified,false);assert.equal(result.accounts[0].state,"unverified");
  }
});
