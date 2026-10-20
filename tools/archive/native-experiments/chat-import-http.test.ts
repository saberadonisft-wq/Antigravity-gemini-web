import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AccountRegistry } from "./account-registry.js";
import { startNativeProxy } from "./native-proxy.js";
import { sha256 } from "./native-protocol.js";
import { ChatImportSnapshotSchema } from "@antigravity-gemini-web/contracts";
import { writeSyntheticChatArchive } from "./testing/chat-import-archive.fixture.js";
import { NativeBrowserBackendPool } from "./browser-backend-pool.js";
import { ChatImportCapabilitySchema } from "@antigravity-gemini-web/contracts";

test("Import capability HTTP pins the account, blocks concurrent control and discards a stale result without Send",{timeout:15000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"ag-chat-import-http-test-")),registry=new AccountRegistry(path.join(root,"accounts.json"));
  const accounts=["A","B"].map(name=>registry.add({displayName:name,profilePath:path.join(root,"profile"+name),statePath:path.join(root,"state"+name),identityFingerprint:sha256(name)}));
  let finish!:(value:any)=>void,reads=0,sends=0;const pool=new NativeBrowserBackendPool(registry,"unused",()=>({generate:async()=>{sends++;return "unused";},close:async()=>{},inspectImportSurface:async()=>{reads++;return new Promise(resolve=>{finish=resolve;});}}));
  const proxy=await startNativeProxy({port:0,stateDirectory:root,accountRegistry:registry,backend:pool,importsExperimental:true,controlToken:"fixture-import-token"});
  t.after(async()=>{await proxy.close();const target=fs.realpathSync(root);assert.equal(path.dirname(target).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.match(path.basename(target),/^ag-chat-import-http-test-/);fs.rmSync(target,{recursive:true,force:true});});
  const endpoint=`http://127.0.0.1:${proxy.port}`,call=(resource:string,body:unknown)=>fetch(endpoint+"/__native/"+resource,{method:"POST",headers:{"content-type":"application/json","x-native-control-token":"fixture-import-token"},body:JSON.stringify(body)});
  const status=await(await call("manage",{action:"status"})).json(),request={action:"probe",expectedOwnerId:status.ownerId,expectedAccountRevision:status.revision,accountId:accounts[0]!.accountId,identityEpoch:accounts[0]!.identityEpoch};
  assert.equal((await call("imports",{...request,expectedOwnerId:randomUUID()})).status,409);assert.equal(reads,0);
  const observation={status:"not_observed",observedAt:new Date().toISOString(),identityVerified:false,chatUploadControlObserved:false,memoryControlsObserved:false,evidence:"visible_controls_only",googleSubmission:"not_submitted"};
  const pending=call("imports",request);while(!reads)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal((await call("manage",{action:"use",expectedOwnerId:status.ownerId,expectedRevision:status.revision,accountId:accounts[1]!.accountId})).status,409);
  finish(observation);const accepted=ChatImportCapabilitySchema.parse(await(await pending).json());assert.equal(accepted.accountId,accounts[0]!.accountId);assert.equal(sends,0);
  const stale=call("imports",request);while(reads<2)await new Promise(resolve=>setTimeout(resolve,5));registry.setActive(accounts[1]!.accountId);finish(observation);assert.equal((await stale).status,409);assert.equal(sends,0);
});

test("Import inspection is disabled by default and shutdown still closes it if the backend fails", { timeout: 15000 }, async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"ag-chat-import-http-test-")),registry=new AccountRegistry(path.join(root,"accounts.json"));
  const account=registry.add({displayName:"Fixture",profilePath:path.join(root,"profile"),statePath:path.join(root,"state"),identityFingerprint:sha256("fixture")});
  const create=(enabled?:boolean,failClose=false)=>startNativeProxy({port:0,stateDirectory:root,accountRegistry:registry,importsExperimental:enabled,controlToken:"fixture-token",backend:{generate:async()=>{throw new Error("Unexpected Native generation");},close:async()=>{if(failClose)throw new Error("fixture close failure");}}});
  const proxies:Awaited<ReturnType<typeof create>>[]=[];
  t.after(async()=>{for(const proxy of proxies)await proxy.close().catch(()=>{});const target=fs.realpathSync(root);assert.equal(path.dirname(target).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.match(path.basename(target),/^ag-chat-import-http-test-/);fs.rmSync(target,{recursive:true,force:true});});
  const disabled=await create();proxies.push(disabled);
  const call=(proxy:typeof disabled,body:unknown)=>fetch(`http://127.0.0.1:${proxy.port}/__native/imports`,{method:"POST",headers:{"x-native-control-token":"fixture-token","content-type":"application/json"},body:JSON.stringify(body)});
  const status=ChatImportSnapshotSchema.parse(await(await call(disabled,{action:"status"})).json());assert.equal(status.experimentalEnabled,false);assert.equal(status.canInspect,false);assert.equal(status.jobs.length,0);
  const file=await writeSyntheticChatArchive(root),intent={action:"inspect",expectedOwnerId:status.ownerId,expectedRevision:0,expectedAccountRevision:status.accountRevision,accountId:account.accountId,identityEpoch:account.identityEpoch,provider:"chatgpt",file};
  assert.equal((await call(disabled,intent)).status,412);await disabled.close();
  const active=await create(true,true);proxies.push(active);
  const enabled=ChatImportSnapshotSchema.parse(await(await call(active,{action:"status"})).json());
  const started=ChatImportSnapshotSchema.parse(await(await call(active,{...intent,expectedOwnerId:enabled.ownerId})).json());assert.equal(started.inspectionActive,true);
  await assert.rejects(active.close(),/fixture close failure/);
  assert.equal(fs.existsSync(file),true); // Shutdown is bounded and never deletes the selected archive.
});

test("Authenticated HTTP inspection is asynchronous, epoch-bound and never enters Native generation", { timeout: 20000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ag-chat-import-http-test-")), registry = new AccountRegistry(path.join(root, "accounts.json"));
  const account = registry.add({ displayName: "Import fixture", profilePath: path.join(root, "profile"), statePath: path.join(root, "state"), identityFingerprint: sha256("fixture") });
  let sends = 0, closed = false;
  const proxy = await startNativeProxy({ port: 0, stateDirectory: root, accountRegistry: registry, importsExperimental: true, controlToken: "fixture-import-token", backend: { generate: async () => { sends++; return "unused"; }, close: async () => { closed = true; } } });
  t.after(async () => { await proxy.close(); const target = fs.realpathSync(root); assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase()); assert.match(path.basename(target), /^ag-chat-import-http-test-/); fs.rmSync(target, { recursive: true, force: true }); });
  const file = await writeSyntheticChatArchive(root), endpoint = `http://127.0.0.1:${proxy.port}`;
  const call = async (body: unknown, token = "fixture-import-token") => fetch(endpoint + "/__native/imports", { method: "POST", headers: { "x-native-control-token": token, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await call({ action: "status" }, "wrong")).status, 401);
  const initial = ChatImportSnapshotSchema.parse(await (await call({ action: "status" })).json());
  const intent = { action: "inspect", expectedOwnerId: initial.ownerId, expectedRevision: initial.revision, expectedAccountRevision: initial.accountRevision, accountId: account.accountId, identityEpoch: account.identityEpoch, provider: "chatgpt", file };
  assert.equal((await call({ ...intent, expectedOwnerId: randomUUID() })).status, 409);
  const accepted = await call(intent); assert.equal(accepted.status, 200);
  let snapshot = ChatImportSnapshotSchema.parse(await accepted.json()); assert.equal(snapshot.jobs[0]!.state, "checking");
  const deadline = performance.now() + 10000;
  while (snapshot.inspectionActive) { assert.ok(performance.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); snapshot = ChatImportSnapshotSchema.parse(await (await call({ action: "status" })).json()); }
  assert.equal(snapshot.jobs[0]!.state, "ready"); assert.equal(sends, 0); assert.equal(fs.existsSync(path.join(root, "native-turn-ledger")), false);
  assert.ok(!JSON.stringify(snapshot).includes(root));
  await proxy.close(); assert.equal(closed, true);
});
