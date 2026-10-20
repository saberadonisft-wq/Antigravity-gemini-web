import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { LauncherClient,KnowledgeSnapshot,KnowledgeUiCommand } from "@antigravity-gemini-web/contracts";
import { MockLauncherClient } from "./client/mock-client.js";
import { NativeKnowledgeStore } from "./client/native-knowledge-store.js";
import { nativeAccountFixture } from "../testing/native-account-fixture.js";
import { nativeKnowledgeFixture } from "../testing/native-knowledge-fixture.js";
const deferred=<T>()=>{let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(){
  const accounts=nativeAccountFixture(),snapshot=nativeKnowledgeFixture(accounts),commands:KnowledgeUiCommand[]=[],client:LauncherClient=new MockLauncherClient();
  client.getNativeAccounts=async()=>structuredClone(accounts);client.getNativeKnowledge=async()=>structuredClone(snapshot);
  client.executeNativeKnowledge=async command=>{commands.push(command);snapshot.revision++;return structuredClone(snapshot);};
  return {accounts,snapshot,client,commands,store:new NativeKnowledgeStore(client)};
}
test("Knowledge mutations capture owner/revision and a late poll cannot overwrite their result or duplicate them",async()=>{
  const f=fixture();await f.store.refresh();const old=deferred<KnowledgeSnapshot>(),operation=deferred<KnowledgeSnapshot>();let reads=0;
  f.client.getNativeKnowledge=async()=>++reads===1?old.promise:structuredClone(f.snapshot);f.client.executeNativeKnowledge=async command=>{f.commands.push(command);return operation.promise;};
  const polling=f.store.refresh(),intent={action:"bind" as const,taskScope:"a".repeat(64),accountId:f.accounts.accounts[0]!.accountId,identityEpoch:1,sourceIds:[f.snapshot.sources[0]!.sourceId]};
  const mutation=f.store.execute(intent);assert.equal(await f.store.execute(intent),false);assert.equal(f.commands.length,1);assert.equal(f.commands[0]!.expectedOwnerId,f.snapshot.ownerId);assert.equal(f.commands[0]!.expectedRevision,0);
  old.resolve(structuredClone(f.snapshot));await polling;f.snapshot.revision=2;operation.resolve(structuredClone(f.snapshot));assert.equal(await mutation,true);assert.equal(f.store.current.snapshot!.revision,2);assert.equal(f.store.current.fresh,true);f.store.dispose();
});
test("Disabled, busy, mixed-owner, expired and changed-epoch states cannot mutate or import",async t=>{
  const f=fixture();let imports=0;f.client.importNativeKnowledge=async()=>{imports++;return f.snapshot;};await f.store.refresh();
  f.snapshot.experimentalEnabled=false;await f.store.refresh();assert.equal(await f.store.importFiles("Docs"),false);
  f.snapshot.experimentalEnabled=true;f.snapshot.canMutate=false;await f.store.refresh();assert.equal(await f.store.execute({action:"check",sourceId:f.snapshot.sources[0]!.sourceId}),false);
  f.snapshot.canMutate=true;f.accounts.ownerId=randomUUID();await f.store.refresh();assert.equal(f.store.current.fresh,false);assert.equal(await f.store.importFiles("Docs"),false);
  f.accounts.ownerId=f.snapshot.ownerId;await f.store.refresh();assert.equal(await f.store.execute({action:"bind",taskScope:"a".repeat(64),accountId:f.accounts.accounts[0]!.accountId,identityEpoch:2,sourceIds:[]}),false);assert.equal(f.commands.length,0);
  await f.store.refresh();const now=Date.now();t.mock.method(Date,"now",()=>now+11000);assert.equal(await f.store.importFiles("Docs"),false);assert.equal(imports,0);f.store.dispose();
});
test("A failed action is sanitized, invalidates authority and is never retried by status reads",async()=>{
  const f=fixture();await f.store.refresh();f.client.executeNativeKnowledge=async command=>{f.commands.push(command);throw {code:"CONFIG_CONFLICT",message:"token=private; contents=secret"};};
  assert.equal(await f.store.execute({action:"check",sourceId:f.snapshot.sources[0]!.sourceId}),false);assert.equal(f.store.current.fresh,false);assert.ok(!f.store.current.error!.message.includes("private"));
  assert.equal(await f.store.execute({action:"check",sourceId:f.snapshot.sources[0]!.sourceId}),false);await f.store.refresh();await f.store.refresh();assert.equal(f.commands.length,1);f.store.dispose();
});
test("An open chooser is single-flight; cancellation creates no source and refreshes current authority",async()=>{
  const f=fixture(),choice=deferred<KnowledgeSnapshot>();await f.store.refresh();let imports=0;
  f.client.importNativeKnowledge=async intent=>{imports++;assert.deepEqual(Object.keys(intent).sort(),["expectedOwnerId","expectedRevision","label"]);return choice.promise;};
  const pending=f.store.importFiles("Docs");assert.equal(await f.store.importFiles("Duplicate"),false);assert.equal(imports,1);choice.reject({code:"CANCELLED"});assert.equal(await pending,false);assert.equal(f.store.current.notice,"cancelled");assert.equal(f.store.current.error,undefined);assert.equal(f.store.current.fresh,true);assert.equal(f.store.current.snapshot!.sources.length,1);f.store.dispose();
});
test("Owner changes after a completed operation clear old feedback; disposed views ignore late responses",async()=>{
  const f=fixture();await f.store.refresh();assert.equal(await f.store.execute({action:"check",sourceId:f.snapshot.sources[0]!.sourceId}),true);assert.equal(f.store.current.notice,"check");
  f.snapshot.ownerId=f.accounts.ownerId=randomUUID();await f.store.refresh();assert.equal(f.store.current.notice,undefined);
  const pending=deferred<KnowledgeSnapshot>();f.client.executeNativeKnowledge=()=>pending.promise;let events=0;f.store.listen(()=>events++);const mutation=f.store.execute({action:"check",sourceId:f.snapshot.sources[0]!.sourceId});f.store.dispose();const count=events;pending.resolve(f.snapshot);await mutation;assert.equal(events,count);
});
