import { test } from "node:test";
import assert from "node:assert/strict";
import { NativeAccountStore } from "./client/native-account-store.js";
import { nativeAccountFixture } from "../testing/native-account-fixture.js";
import type { NativeManagementSnapshot,LauncherClient } from "@antigravity-gemini-web/contracts";

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
test("A late status poll cannot undo a completed account selection",async()=>{
  const before=nativeAccountFixture(),after=nativeAccountFixture({...before,revision:2,selectedAccountId:"acc_fixture_B"}),late=deferred<NativeManagementSnapshot>();let reads=0,mutations=0;
  const client:Pick<LauncherClient,"getNativeAccounts"|"executeNativeAccount"|"copyNativeExtensionPairingCode">={};client.getNativeAccounts=async()=>++reads===1?before:late.promise;client.executeNativeAccount=async command=>{mutations++;assert.equal(command.expectedOwnerId,before.ownerId);assert.equal(command.expectedRevision,1);return after;};
  const store=new NativeAccountStore(client);await store.refresh();const poll=store.refresh();assert.equal(await store.execute({action:"use",accountId:"acc_fixture_B"}),true);late.resolve(before);await poll;
  assert.equal(store.current.snapshot!.selectedAccountId,"acc_fixture_B");assert.equal(store.current.snapshot!.revision,2);assert.equal(mutations,1);store.dispose();
});
test("Disconnected, stale or busy UI state cannot mutate accounts or silently retry an action",async()=>{
  const snapshot=nativeAccountFixture();const client:Pick<LauncherClient,"getNativeAccounts"|"executeNativeAccount"|"copyNativeExtensionPairingCode">={};let calls=0,offline=false;
  client.getNativeAccounts=async()=>{if(offline)throw {code:"RUNTIME_DISCONNECTED"};return snapshot;};client.executeNativeAccount=async()=>{calls++;throw {code:"CONFIG_CONFLICT",message:"private"};};
  const store=new NativeAccountStore(client);await store.refresh();offline=true;await store.refresh();assert.equal(store.current.fresh,false);assert.equal(await store.execute({action:"use",accountId:"acc_fixture_B"}),false);assert.equal(calls,0);
  offline=false;snapshot.observedAt=new Date(Date.now()-11000).toISOString();await store.refresh();assert.equal(await store.execute({action:"use",accountId:"acc_fixture_B"}),false);assert.equal(calls,0);
  snapshot.observedAt=new Date().toISOString();snapshot.canMutate=false;await store.refresh();assert.equal(await store.execute({action:"use",accountId:"acc_fixture_B"}),false);assert.equal(calls,0);
  snapshot.canMutate=true;await store.refresh();assert.equal(await store.execute({action:"use",accountId:"acc_fixture_B"}),false);assert.equal(calls,1);assert.equal(store.current.error!.code,"CONFIG_CONFLICT");assert.ok(!store.current.error!.message.includes("private"));store.dispose();
});
test("Duplicate clicks coalesce locally and disposed views ignore late operation results",async()=>{
  const snapshot=nativeAccountFixture(),pending=deferred<NativeManagementSnapshot>();const client:Pick<LauncherClient,"getNativeAccounts"|"executeNativeAccount"|"copyNativeExtensionPairingCode">={};let mutations=0;
  client.getNativeAccounts=async()=>snapshot;client.executeNativeAccount=async()=>{mutations++;return pending.promise;};const store=new NativeAccountStore(client);await store.refresh();let updates=0;store.listen(()=>updates++);
  const first=store.execute({action:"open",accountId:"acc_fixture_A"});assert.equal(await store.execute({action:"open",accountId:"acc_fixture_A"}),false);assert.equal(mutations,1);
  store.dispose();const count=updates;pending.resolve(snapshot);await first;assert.equal(updates,count);
});

test("Pairing sends only account authority to preload, and removal binds both account and routing revisions",async()=>{
  const base=nativeAccountFixture(),snapshot=nativeAccountFixture({...base,runtimeRevision:41,accounts:base.accounts.map(row=>row.accountId==="acc_fixture_B"?{...row,browserTransport:"extension" as const}:row)});
  const client:Pick<LauncherClient,"getNativeAccounts"|"executeNativeAccount"|"copyNativeExtensionPairingCode">={};client.getNativeAccounts=async()=>snapshot;
  let paired:unknown,removed:unknown;
  client.copyNativeExtensionPairingCode=async intent=>{paired=intent;};
  client.executeNativeAccount=async command=>{removed=command;return nativeAccountFixture({...snapshot,revision:2,accounts:[snapshot.accounts[0]!],selectedAccountId:snapshot.accounts[0]!.accountId});};
  const store=new NativeAccountStore(client);await store.refresh();
  assert.equal(await store.copyPairingCode("acc_fixture_B"),true);assert.equal(store.current.notice,"pair");
  assert.deepEqual(paired,{accountId:"acc_fixture_B",expectedOwnerId:snapshot.ownerId,expectedRevision:snapshot.revision});
  assert.equal(await store.execute({action:"remove",accountId:"acc_fixture_B"}),true);
  assert.equal((removed as any).expectedRevision,snapshot.revision);assert.equal((removed as any).expectedRoutingRevision,snapshot.routing.revision);assert.equal(store.current.snapshot?.accounts.length,1);store.dispose();
});

test("Routing changes include both owner revision and the current routing revision",async()=>{
  const snapshot=nativeAccountFixture();const client:Pick<LauncherClient,"getNativeAccounts"|"executeNativeAccount"|"copyNativeExtensionPairingCode">={};client.getNativeAccounts=async()=>snapshot;
  let received:unknown;client.executeNativeAccount=async command=>{received=command;return nativeAccountFixture({...snapshot,revision:2,routing:{...snapshot.routing,mode:"sticky",revision:1,automaticEnabled:true}});};
  const store=new NativeAccountStore(client);await store.refresh();
  assert.equal(await store.execute({action:"configure_routing",settings:{mode:"sticky",priority:[],roundRobinOptIn:false}}),true);
  assert.deepEqual(received,{action:"configure_routing",settings:{mode:"sticky",priority:[],roundRobinOptIn:false},expectedOwnerId:snapshot.ownerId,expectedRevision:snapshot.revision,expectedRoutingRevision:snapshot.routing.revision});
  assert.equal(store.current.snapshot?.routing.mode,"sticky");store.dispose();
});

test("Old success feedback is cleared after disconnection or a newer owner operation",async()=>{
  let snapshot=nativeAccountFixture(),offline=false;const client:Pick<LauncherClient,"getNativeAccounts"|"executeNativeAccount"|"copyNativeExtensionPairingCode">={};
  client.getNativeAccounts=async()=>{if(offline)throw {code:"RUNTIME_DISCONNECTED"};return snapshot;};client.executeNativeAccount=async()=>snapshot;
  const store=new NativeAccountStore(client);await store.refresh();await store.execute({action:"open",accountId:"acc_fixture_A"});assert.equal(store.current.notice,"open");
  offline=true;await store.refresh();assert.equal(store.current.notice,undefined);assert.equal(store.current.fresh,false);
  offline=false;await store.refresh();await store.execute({action:"verify",accountId:"acc_fixture_A"});assert.equal(store.current.notice,"verify");
  snapshot=nativeAccountFixture({...snapshot,revision:snapshot.revision+1});await store.refresh();assert.equal(store.current.notice,undefined);
  await store.execute({action:"cancel"});snapshot=nativeAccountFixture({...snapshot,lastOutcome:{requestId:"native_"+"a".repeat(64),phase:"failed",code:"CANCELLED",browserStopConfirmed:true}});await store.refresh();assert.equal(store.current.notice,undefined);
  snapshot=nativeAccountFixture({...snapshot,lastOutcome:{requestId:"native_"+"b".repeat(64),phase:"generating"}});await store.refresh();await store.execute({action:"cancel"});
  snapshot=nativeAccountFixture({...snapshot,lastOutcome:{requestId:"native_"+"b".repeat(64),phase:"failed",code:"CANCELLED",browserStopConfirmed:true}});await store.refresh();assert.equal(store.current.notice,"cancel");
  store.dispose();
});
