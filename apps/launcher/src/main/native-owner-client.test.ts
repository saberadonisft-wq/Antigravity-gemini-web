import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { NativeOwnerClient } from "./native-owner-client.js";
import { nativeAccountFixture } from "../testing/native-account-fixture.js";
import { nativeKnowledgeFixture } from "../testing/native-knowledge-fixture.js";

async function fixture(t:test.TestContext){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"launcher-native-owner-")),file=path.join(root,"owner.json"),token="a".repeat(64),snapshot=nativeAccountFixture(),pairingCode="agc1.fixtureabcdefghijklmnop";
  const imports={service:"gemini-native-chat-import",version:1,ownerId:snapshot.ownerId,revision:0,accountRevision:snapshot.revision,experimentalEnabled:true,canInspect:true,inspectionActive:false,jobs:[],googleSubmission:"not_submitted"};
  const knowledge=nativeKnowledgeFixture(snapshot),config={pid:process.pid,supported:true,runtimeRevision:45,knowledgeEnabled:true,importsEnabled:true,leakRoot:false,redirect:false,rewriteDescriptor:false,errorCode:"",oversized:false,delayAction:"",delayMs:0},commands:any[]=[];
  const server=http.createServer(async(request,response)=>{
    response.setHeader("content-type","application/json");
    if(request.url==="/__native/health"){
      if(config.rewriteDescriptor)fs.writeFileSync(file,JSON.stringify({version:1,pid:process.pid,endpoint,controlToken:"b".repeat(64)}));
      response.end(JSON.stringify({service:"gemini-native-proxy",version:1,pid:config.pid,accountManagementSupported:config.supported,runtimeRevision:config.runtimeRevision,knowledgeExperimental:config.knowledgeEnabled,importInspectionExperimental:config.importsEnabled}));return;
    }
    if(config.redirect){response.writeHead(302,{location:"http://127.0.0.1:1/forbidden"});response.end();return;}
    assert.equal(request.headers["x-native-control-token"],token);let body="";for await(const chunk of request)body+=chunk;commands.push(JSON.parse(body));
    if(commands.at(-1).action===config.delayAction)await new Promise(resolve=>setTimeout(resolve,config.delayMs));
    if(config.errorCode){response.writeHead(409);response.end(JSON.stringify({error:{code:config.errorCode,message:"cookie=private; token="+token}}));return;}
    if(config.oversized){response.end(JSON.stringify({padding:"x".repeat(270000)}));return;}
    response.end(JSON.stringify(request.url==="/__native/imports"?{...imports,...(config.leakRoot?{file:"C:/private.zip"}:{})}:request.url==="/__native/knowledge"?{...knowledge,...(config.leakRoot?{root:"C:/private"}:{})}:request.url==="/__native/pairing"?{pairingCode}:snapshot));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const endpoint="http://127.0.0.1:"+(server.address() as {port:number}).port;
  fs.writeFileSync(file,JSON.stringify({version:1,pid:process.pid,endpoint,controlToken:token}));
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));const resolved=fs.realpathSync(root);assert.equal(path.dirname(resolved).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(resolved).startsWith("launcher-native-owner-"));fs.rmSync(resolved,{recursive:true,force:true});});
  return {root,client:new NativeOwnerClient(file,endpoint),config,commands,snapshot,knowledge,token,pairingCode};
}
test("Launcher main authenticates the real HTTP owner without exposing its descriptor/token",async t=>{
  const f=await fixture(t),result=await f.client.getNativeAccounts();assert.equal(result.ownerId,f.snapshot.ownerId);assert.deepEqual(f.commands,[{action:"status"}]);assert.ok(!JSON.stringify(result).includes(f.token));
});

test("Account deletion can finish past the short status deadline without a false disconnection",async t=>{
  const f=await fixture(t);f.config.delayAction="remove";f.config.delayMs=5500;
  const command={action:"remove" as const,accountId:"acc_fixture_B",expectedOwnerId:f.snapshot.ownerId,expectedRevision:f.snapshot.revision,expectedRoutingRevision:f.snapshot.routing.revision,retireNativeConversations:true};
  const result=await f.client.executeNativeAccount(command);
  assert.equal(result.ownerId,f.snapshot.ownerId);assert.deepEqual(f.commands,[command]);
});

test("Owner mismatch, old runtime and descriptor replacement prevent management POST",async t=>{
  const f=await fixture(t);f.config.pid=process.pid+100;await assert.rejects(f.client.getNativeAccounts(),{code:"OWNER_MISMATCH"});assert.equal(f.commands.length,0);
  f.config.pid=process.pid;f.config.supported=false;await assert.rejects(f.client.getNativeAccounts(),{code:"NATIVE_RUNTIME_UPDATE_REQUIRED"});assert.equal(f.commands.length,0);
  f.config.supported=true;f.config.runtimeRevision=41;await assert.rejects(f.client.getNativeAccounts(),{code:"NATIVE_RUNTIME_UPDATE_REQUIRED"});assert.equal(f.commands.length,0);
  f.config.runtimeRevision=45;f.config.rewriteDescriptor=true;await assert.rejects(f.client.getNativeAccounts(),{code:"OWNER_MISMATCH"});assert.equal(f.commands.length,0);
});
test("Redirects, oversized responses and raw error messages never cross the owner client",async t=>{
  const f=await fixture(t);f.config.redirect=true;await assert.rejects(f.client.getNativeAccounts(),{code:"RUNTIME_DISCONNECTED"});
  f.config.redirect=false;f.config.oversized=true;await assert.rejects(f.client.getNativeAccounts(),{code:"CONTRACT_MISMATCH"});
  f.config.oversized=false;f.config.errorCode="STALE_ACCOUNT_SELECTION";await assert.rejects(f.client.getNativeAccounts(),(error:any)=>{assert.equal(error.code,"CONFIG_CONFLICT");assert.ok(!JSON.stringify(error).includes(f.token));assert.ok(!JSON.stringify(error).includes("private"));return true;});
  f.config.errorCode="MODEL_RESTORE_PENDING";await assert.rejects(f.client.getNativeAccounts(),{code:"MODEL_RESTORE_PENDING"});
});
