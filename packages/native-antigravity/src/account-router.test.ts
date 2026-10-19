import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NativeRoutingSettingsSchema } from "@antigravity-gemini-web/contracts";
import { AccountRegistry } from "./account-registry.js";
import { NativeAccountRouter } from "./account-router.js";
import { NativeRouteError,sha256 } from "./native-protocol.js";

const request=(value:string)=>"native_"+sha256(value),task=(value:string)=>sha256(value);
const settings=(mode:string,extra:Record<string,unknown>={})=>NativeRoutingSettingsSchema.parse({mode,modelSelection:mode==="manual"?undefined:{model:"Fixture Model",effort:"Low"},...extra});
function fixture(t:test.TestContext){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"ag-account-router-"));
  t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith("ag-account-router-"));fs.rmSync(root,{recursive:true,force:true});});
  const registry=new AccountRegistry(path.join(root,"accounts.json"));
  const accounts=["A","B"].map((name,i)=>registry.add({displayName:name,profilePath:path.join(root,"profile_"+name),statePath:path.join(root,"state_"+name),debugPort:13001+i,identityFingerprint:sha256(name)}));
  registry.setActive(accounts[0].accountId);return {root,registry,accounts,file:path.join(root,"routing.json")};
}

test("Manual routing preserves the Web model, reserves one account and refuses silent fallback or stale release",t=>{
  const f=fixture(t),router=new NativeAccountRouter(f.registry,f.file);
  const a=router.acquire(request("a"),task("a"));router.commit(a);assert.equal(a.account.accountId,f.accounts[0].accountId);assert.equal(a.modelSelection,undefined);
  assert.throws(()=>router.acquire(request("b"),task("b")),{code:"BUSY"});
  assert.throws(()=>router.configure(settings("priority"),0),{code:"BUSY"});router.release(a);
  const newer=router.acquire(request("new"),task("a"));assert.equal(router.release(a),false);assert.equal(router.activeCount,1);router.release(newer);
  assert.throws(()=>router.configure(settings("priority"),0),{code:"ROUTING_EXPERIMENT_DISABLED"});
  assert.ok(!NativeRoutingSettingsSchema.safeParse({mode:"priority"}).success);
  assert.ok(!NativeRoutingSettingsSchema.safeParse({mode:"round_robin",modelSelection:{model:"Fixture Model"}}).success);
  f.registry.update(f.accounts[0].accountId,{identityFingerprint:undefined});assert.throws(()=>router.acquire(request("unverified")),{code:"ACCOUNT_IDENTITY_UNVERIFIED"});
});

test("Sticky account-per-chat routing needs no fixed Web model or experimental router flag",t=>{
  const f=fixture(t),router=new NativeAccountRouter(f.registry,f.file);
  const configured=router.configure(NativeRoutingSettingsSchema.parse({mode:"sticky"}),0);
  assert.equal(configured.settings.modelSelection,undefined);assert.equal(configured.experimentalEnabled,false);assert.equal(configured.automaticRoutingEnabled,true);
  const first=router.acquire(request("first"),task("existing-chat"));assert.equal(first.account.accountId,f.accounts[0].accountId);router.commit(first);router.release(first);
  f.registry.setActive(f.accounts[1].accountId);
  const pinned=router.acquire(request("second"),task("existing-chat"));assert.equal(pinned.account.accountId,f.accounts[0].accountId);router.release(pinned);
  const nextChat=router.acquire(request("third"),task("new-chat"));assert.equal(nextChat.account.accountId,f.accounts[1].accountId);router.release(nextChat);
  assert.throws(()=>router.configure(settings("priority"),router.snapshot().revision),{code:"ROUTING_EXPERIMENT_DISABLED"});
});

test("Priority routes independent chats onto free accounts and keeps one fixed model without concurrent turns in a chat",t=>{
  const f=fixture(t),router=new NativeAccountRouter(f.registry,f.file,true);router.configure(settings("priority"),0);
  const a=router.acquire(request("a"),task("a"));router.commit(a);
  assert.throws(()=>router.acquire(request("same-chat"),task("a")),{code:"BUSY"});
  const b=router.acquire(request("b"),task("b"));router.commit(b);
  assert.equal(a.account.accountId,f.accounts[0].accountId);assert.equal(b.account.accountId,f.accounts[1].accountId);assert.deepEqual(a.modelSelection,b.modelSelection);
  assert.throws(()=>{a.account.accountId=f.accounts[1].accountId;},TypeError);
  assert.throws(()=>router.acquire(request("no-slot"),task("c")),{code:"NO_ELIGIBLE_ACCOUNT"});router.release(a);router.release(b);assert.equal(router.activeCount,0);
});

test("Sticky selection is committed only after source reservation, survives restart and rejects changed identity epochs",t=>{
  const f=fixture(t),router=new NativeAccountRouter(f.registry,f.file,true);router.configure(settings("sticky"),0);
  const provisional=router.acquire(request("invalid-source"),task("invalid"));assert.equal(router.snapshot().bindings.length,0);router.release(provisional);assert.equal(router.snapshot().bindings.length,0);
  const a=router.acquire(request("a"),task("a"));router.commit(a);router.release(a);f.registry.setActive(f.accounts[1].accountId);
  const restarted=new NativeAccountRouter(f.registry,f.file,true),again=restarted.acquire(request("again"),task("a"));assert.equal(again.account.accountId,f.accounts[0].accountId);restarted.release(again);
  const b=restarted.acquire(request("b"),task("b"));restarted.commit(b);assert.equal(b.account.accountId,f.accounts[1].accountId);restarted.release(b);
  f.registry.update(f.accounts[0].accountId,{identityFingerprint:sha256("new A")});assert.throws(()=>restarted.acquire(request("stale"),task("a")),{code:"STALE_AUTHORITY"});
  const current=restarted.snapshot();restarted.unbind(task("a"),current.revision);const rebound=restarted.acquire(request("rebound"),task("a"));restarted.commit(rebound);assert.equal(rebound.account.accountId,f.accounts[1].accountId);restarted.release(rebound);
});

test("Round robin requires opt-in, persists its cursor and does not silently downgrade when the runtime flag is removed",t=>{
  const f=fixture(t),router=new NativeAccountRouter(f.registry,f.file,true);router.configure(settings("round_robin",{roundRobinOptIn:true}),0);
  for(let i=0;i<3;i++){const lease=router.acquire(request("round"+i),task("round"+i));router.commit(lease);assert.equal(lease.account.accountId,f.accounts[i%2].accountId);router.release(lease);if(i===0)f.registry.setActive(f.accounts[1].accountId);}
  const restarted=new NativeAccountRouter(f.registry,f.file,true),next=restarted.acquire(request("next"),task("next"));restarted.commit(next);assert.equal(next.account.accountId,f.accounts[1].accountId);restarted.release(next);
  assert.throws(()=>new NativeAccountRouter(f.registry,f.file).acquire(request("flag-off")),{code:"ROUTING_EXPERIMENT_DISABLED"});
  f.registry.disable(f.accounts[0].accountId);const remaining=restarted.acquire(request("remaining"),task("remaining"));restarted.commit(remaining);assert.equal(remaining.account.accountId,f.accounts[1].accountId);restarted.release(remaining);
});

test("Routing revisions, writer contention and corrupt files fail closed",t=>{
  const f=fixture(t),first=new NativeAccountRouter(f.registry,f.file,true),second=new NativeAccountRouter(f.registry,f.file,true);
  first.configure(settings("priority"),0);assert.throws(()=>second.configure(settings("manual"),0),{code:"STALE_ROUTING_REVISION"});
  fs.writeFileSync(f.file+".lock","another writer");assert.throws(()=>first.configure(settings("manual"),1),{code:"ROUTER_STATE_BUSY"});fs.unlinkSync(f.file+".lock");
  fs.writeFileSync(f.file,"{partial");assert.throws(()=>new NativeAccountRouter(f.registry,f.file,true),{code:"INVALID_ROUTING_STATE"});
});

test("Only observed not_sent failures affect eligibility; generic Web errors never become quota/cooldown evidence",t=>{
  const f=fixture(t),router=new NativeAccountRouter(f.registry,f.file,true);router.configure(settings("priority"),0);
  const a=router.acquire(request("a"),task("a"));router.commit(a);
  const web=new NativeRouteError("BROWSER_TURN_FAILED","generic Web error",502);web.delivery="unknown";router.observeNotSent(a,web);router.release(a);assert.equal(router.snapshot().observations.length,0);
  const retry=router.acquire(request("new-chat"),task("new-chat"));assert.equal(retry.account.accountId,f.accounts[0].accountId);
  const unavailable=new NativeRouteError("MODEL_UNAVAILABLE","model missing",412);unavailable.delivery="not_sent";router.observeNotSent(retry,unavailable);router.release(retry);
  const b=router.acquire(request("b"),task("b"));assert.equal(b.account.accountId,f.accounts[1].accountId);router.release(b);
  router.configure(settings("manual",{modelSelection:{model:"Fixture Model",effort:"Low"}}),router.snapshot().revision);
  const explicit=router.acquire(request("manual"),task("manual"));assert.equal(explicit.account.accountId,f.accounts[0].accountId);router.release(explicit);
  assert.equal(router.snapshot().failoverEnabled,false);
});

test("Finite handoff retains the task lock and refuses an externally changed model policy",t=>{
  const f=fixture(t),router=new NativeAccountRouter(f.registry,f.file,true);
  router.configure(settings("priority",{failover:{enabled:true}}),0);
  const a=router.acquire(request("handoff"),task("handoff"));router.commit(a);
  const b=router.next(a)!;assert.equal(b.account.accountId,f.accounts[1].accountId);
  assert.equal(router.release(a),false);assert.equal(router.activeCount,1);
  assert.throws(()=>router.acquire(request("racing"),task("handoff")),{code:"BUSY"});
  assert.equal(router.next(b),undefined);router.release(b);
  const pending=router.acquire(request("policy-drift"),task("policy-drift"));
  const disk=JSON.parse(fs.readFileSync(f.file,"utf8"));disk.settings.modelSelection.model="Different Model";disk.revision++;
  fs.writeFileSync(f.file,JSON.stringify(disk));
  assert.throws(()=>router.next(pending),{code:"STALE_ROUTING_REVISION"});
  assert.equal(router.activeCount,1);router.release(pending);
});

test("Sticky admission can move an unavailable binding, while explicit resume stays pinned",t=>{
  const f=fixture(t),router=new NativeAccountRouter(f.registry,f.file,true);
  router.configure(settings("sticky",{failover:{enabled:true}}),0);
  const a=router.acquire(request("bind"),task("sticky"));router.commit(a);router.release(a);
  const unavailable=new NativeRouteError("MODEL_UNAVAILABLE","missing",412);unavailable.delivery="not_sent";
  const observe=router.acquire(request("observe"),task("observe"));router.commit(observe);router.observeNotSent(observe,unavailable);router.release(observe);
  assert.throws(()=>router.acquire(request("pinned"),task("sticky"),f.accounts[0].accountId),{code:"MODEL_UNAVAILABLE"});
  const b=router.acquire(request("admit"),task("sticky"));assert.equal(b.account.accountId,f.accounts[1].accountId);
  assert.equal(router.snapshot().bindings.find(row=>row.taskScope===task("sticky"))!.accountId,f.accounts[0].accountId);
  router.commit(b);router.release(b);
  assert.equal(router.snapshot().bindings.find(row=>row.taskScope===task("sticky"))!.accountId,f.accounts[1].accountId);
  const pinned=router.acquire(request("pinned-b"),task("sticky"),f.accounts[1].accountId);
  assert.equal(pinned.failoverPolicy,undefined);assert.equal(router.next(pinned),undefined);router.release(pinned);
});

test("An unavailable staging model does not mark the primary model unavailable",t=>{
  const f=fixture(t),router=new NativeAccountRouter(f.registry,f.file,true);router.configure(settings("priority"),0);
  const a=router.acquire(request("staging"),task("staging"));
  const error=new NativeRouteError("MODEL_UNAVAILABLE","staging missing",412);error.delivery="not_sent";
  router.observeNotSent(a,error,{model:"Fixture Context 3.8"});router.release(a);
  const primary=router.acquire(request("primary"),task("primary"));assert.equal(primary.account.accountId,f.accounts[0].accountId);router.release(primary);
  router.configure(settings("priority",{modelSelection:{model:"Fixture Context 3.8"}}),router.snapshot().revision);
  const context=router.acquire(request("context"),task("context"));assert.equal(context.account.accountId,f.accounts[1].accountId);router.release(context);
});
