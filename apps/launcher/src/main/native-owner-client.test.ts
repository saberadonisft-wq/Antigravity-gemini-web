import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { NativeOwnerClient } from "./native-owner-client.js";
import { nativeAccountFixture } from "../testing/native-account-fixture.js";
import { IpcSecurityBridge } from "./ipc-bridge.js";
import { RuntimeFacade } from "@antigravity-gemini-web/runtime";
import { createPreloadClient } from "../preload/client.js";
import { nativeKnowledgeFixture } from "../testing/native-knowledge-fixture.js";

async function fixture(t:test.TestContext){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"launcher-native-owner-")),file=path.join(root,"owner.json"),token="a".repeat(64),snapshot=nativeAccountFixture();
  const knowledge=nativeKnowledgeFixture(snapshot),config={pid:process.pid,supported:true,runtimeRevision:35,knowledgeEnabled:true,leakRoot:false,redirect:false,rewriteDescriptor:false,errorCode:"",oversized:false},commands:any[]=[];
  const server=http.createServer(async(request,response)=>{
    response.setHeader("content-type","application/json");
    if(request.url==="/__native/health"){
      if(config.rewriteDescriptor)fs.writeFileSync(file,JSON.stringify({version:1,pid:process.pid,endpoint,controlToken:"b".repeat(64)}));
      response.end(JSON.stringify({service:"gemini-native-proxy",version:1,pid:config.pid,accountManagementSupported:config.supported,runtimeRevision:config.runtimeRevision,knowledgeExperimental:config.knowledgeEnabled}));return;
    }
    if(config.redirect){response.writeHead(302,{location:"http://127.0.0.1:1/forbidden"});response.end();return;}
    assert.equal(request.headers["x-native-control-token"],token);let body="";for await(const chunk of request)body+=chunk;commands.push(JSON.parse(body));
    if(config.errorCode){response.writeHead(409);response.end(JSON.stringify({error:{code:config.errorCode,message:"cookie=private; token="+token}}));return;}
    if(config.oversized){response.end(JSON.stringify({padding:"x".repeat(270000)}));return;}
    response.end(JSON.stringify(request.url==="/__native/knowledge"?{...knowledge,...(config.leakRoot?{root:"C:/private"}:{})}:snapshot));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const endpoint="http://127.0.0.1:"+(server.address() as {port:number}).port;
  fs.writeFileSync(file,JSON.stringify({version:1,pid:process.pid,endpoint,controlToken:token}));
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));const resolved=fs.realpathSync(root);assert.equal(path.dirname(resolved).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(resolved).startsWith("launcher-native-owner-"));fs.rmSync(resolved,{recursive:true,force:true});});
  return {root,client:new NativeOwnerClient(file,endpoint),config,commands,snapshot,knowledge,token};
}
test("Launcher main authenticates the real HTTP owner without exposing its descriptor/token",async t=>{
  const f=await fixture(t),result=await f.client.getNativeAccounts();assert.equal(result.ownerId,f.snapshot.ownerId);assert.deepEqual(f.commands,[{action:"status"}]);assert.ok(!JSON.stringify(result).includes(f.token));
});

test("Knowledge main requires current runtime, validates redacted snapshots and preserves safe source errors",async t=>{
  const f=await fixture(t);f.config.runtimeRevision=34;await assert.rejects(f.client.getNativeKnowledge(),{code:"NATIVE_RUNTIME_UPDATE_REQUIRED"});assert.equal(f.commands.length,0);
  f.config.runtimeRevision=35;assert.equal((await f.client.getNativeKnowledge()).ownerId,f.snapshot.ownerId);f.config.leakRoot=true;await assert.rejects(f.client.getNativeKnowledge(),{code:"CONTRACT_MISMATCH"});
  f.config.leakRoot=false;f.knowledge.sources[0]!.selectedFiles=["C:/private/absolute.md"];await assert.rejects(f.client.getNativeKnowledge(),{code:"CONTRACT_MISMATCH"});f.knowledge.sources[0]!.selectedFiles=["README.md"];
  f.config.leakRoot=false;f.config.errorCode="SOURCE_CONFIG_CONFLICT";await assert.rejects(f.client.getNativeKnowledge(),{code:"CONFIG_CONFLICT"});f.config.errorCode="SOURCE_FILE_EXCLUDED";await assert.rejects(f.client.getNativeKnowledge(),(error:any)=>error.code==="SOURCE_FILE_EXCLUDED"&&!JSON.stringify(error).includes(f.token));
});

test("Knowledge IPC refuses caller paths and unsupported integration commands before a chooser or owner POST",async t=>{
  const f=await fixture(t);let choices=0;const bridge=new IpcSecurityBridge({backend:new RuntimeFacade({mode:"demo"}),nativeKnowledge:f.client,onImportKnowledge:async()=>{choices++;return f.knowledge;},trustedSender:sender=>sender.id===7}),context={sender:{id:7,send:()=>{}},isMainFrame:true,origin:"app://local/index.html"},authority={expectedOwnerId:f.snapshot.ownerId,expectedRevision:0};
  await assert.rejects(bridge.handleInvoke("launcher:getNativeKnowledge",{...context,isMainFrame:false}),{code:"UNAUTHORIZED_FRAME"});await assert.rejects(bridge.handleInvoke("launcher:getNativeKnowledge",context,"extra"),{code:"INVALID_ARGUMENT"});
  await assert.rejects(bridge.handleInvoke("launcher:importNativeKnowledge",context,{...authority,label:"Docs",root:"C:/caller",files:["private"]}),{code:"CONTRACT_MISMATCH"});
  await assert.rejects(bridge.handleInvoke("launcher:executeNativeKnowledge",context,{...authority,action:"import_code",source:{kind:"local_folder",label:"Docs",root:"C:/caller",files:["private"]}}),{code:"CONTRACT_MISMATCH"});assert.equal(choices,0);assert.equal(f.commands.length,0);
  const preload=createPreloadClient({invoke:(channel,...args)=>bridge.invoke(channel,context,...args),on:()=>{},removeListener:()=>{}});await preload.importNativeKnowledge!({...authority,label:"Docs"});assert.equal(choices,1);assert.equal((await preload.getNativeKnowledge!()).sources[0]!.selectedFiles![0],"README.md");
});

test("Main-only file grants derive relative selected files; renderer commands cannot supply an import source",async t=>{
  const f=await fixture(t),project=path.join(f.root,"project");fs.mkdirSync(path.join(project,"docs"),{recursive:true});const files=[path.join(project,"README.md"),path.join(project,"docs","guide.md")];for(const file of files)fs.writeFileSync(file,"synthetic");
  const authority={expectedOwnerId:f.snapshot.ownerId,expectedRevision:0};await f.client.importSelectedKnowledgeFiles({...authority,label:"Docs"},files);assert.equal(f.commands.length,1);assert.equal(f.commands[0].source.root,project);assert.deepEqual(f.commands[0].source.files,["README.md","docs/guide.md"]);
  assert.throws(()=>f.client.executeNativeKnowledge({...authority,action:"import_code",source:{root:"C:/untrusted"}} as any));assert.equal(f.commands.length,1);
});
test("Owner mismatch, old runtime and descriptor replacement prevent management POST",async t=>{
  const f=await fixture(t);f.config.pid=process.pid+100;await assert.rejects(f.client.getNativeAccounts(),{code:"OWNER_MISMATCH"});assert.equal(f.commands.length,0);
  f.config.pid=process.pid;f.config.supported=false;await assert.rejects(f.client.getNativeAccounts(),{code:"NATIVE_RUNTIME_UPDATE_REQUIRED"});assert.equal(f.commands.length,0);
  f.config.supported=true;f.config.rewriteDescriptor=true;await assert.rejects(f.client.getNativeAccounts(),{code:"OWNER_MISMATCH"});assert.equal(f.commands.length,0);
});
test("Redirects, oversized responses and raw error messages never cross the owner client",async t=>{
  const f=await fixture(t);f.config.redirect=true;await assert.rejects(f.client.getNativeAccounts(),{code:"RUNTIME_DISCONNECTED"});
  f.config.redirect=false;f.config.oversized=true;await assert.rejects(f.client.getNativeAccounts(),{code:"CONTRACT_MISMATCH"});
  f.config.oversized=false;f.config.errorCode="STALE_ACCOUNT_SELECTION";await assert.rejects(f.client.getNativeAccounts(),(error:any)=>{assert.equal(error.code,"CONFIG_CONFLICT");assert.ok(!JSON.stringify(error).includes(f.token));assert.ok(!JSON.stringify(error).includes("private"));return true;});
  f.config.errorCode="MODEL_RESTORE_PENDING";await assert.rejects(f.client.getNativeAccounts(),{code:"MODEL_RESTORE_PENDING"});
});
test("Native IPC validates frame, sender, arity and payload before reaching its owner client",async t=>{
  const f=await fixture(t),backend=new RuntimeFacade({mode:"demo"}),bridge=new IpcSecurityBridge({backend,nativeAccounts:f.client,trustedSender:sender=>sender.id===7});
  const context={sender:{id:7,send:()=>{}},isMainFrame:true,origin:"app://local/index.html"};
  await assert.rejects(bridge.handleInvoke("launcher:getNativeAccounts",{...context,isMainFrame:false}),{code:"UNAUTHORIZED_FRAME"});
  await assert.rejects(bridge.handleInvoke("launcher:getNativeAccounts",{...context,sender:{id:8,send:()=>{}}}),{code:"UNAUTHORIZED_SENDER"});
  await assert.rejects(bridge.handleInvoke("launcher:getNativeAccounts",context,"unexpected"),{code:"INVALID_ARGUMENT"});
  await assert.rejects(bridge.handleInvoke("launcher:executeNativeAccount",context,{action:"add",displayName:"Name",profilePath:"C:/untrusted"}),{code:"CONTRACT_MISMATCH"});assert.equal(f.commands.length,0);
  const preload=createPreloadClient({invoke:(channel,...args)=>bridge.invoke(channel,context,...args),on:()=>{},removeListener:()=>{}});
  assert.equal((await preload.getNativeAccounts!()).ownerId,f.snapshot.ownerId);
  await preload.executeNativeAccount!({action:"use",accountId:"acc_fixture_B",expectedOwnerId:f.snapshot.ownerId,expectedRevision:1});assert.equal(f.commands.length,2);
});
