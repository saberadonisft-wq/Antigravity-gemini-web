// Actual CLI/Electron/Native/MCP/SQLite, owned child restart, synthetic browser.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fork,spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath,pathToFileURL } from "node:url";
import { atomicPrivateFile } from "../../../packages/native-antigravity/dist/installation.js";
import { WEB_MODEL } from "../../../packages/native-antigravity/dist/native-protocol.js";

const launcher=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),repository=path.resolve(launcher,"../..");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"launcher-smoke-native-lifecycle-")),quick=process.argv.includes("--quick");
atomicPrivateFile(path.join(root,"lifecycle-options.json"),JSON.stringify({quick})+"\n");
const controlDirectory=path.join(root,"lifecycle-control");fs.mkdirSync(controlDirectory);
let owner,port,oldPid,cliCalls=0,baseline,baselineId,ttlRequest,ttlId,ttlStarted,ttlWallStart,interval,working=false,electron,timer;
const completedIds=new Set();
const modes=[],requests=new Map();let output="",ownerErrors="";
const events=()=>fs.existsSync(path.join(root,"events.jsonl"))?fs.readFileSync(path.join(root,"events.jsonl"),"utf8").trim().split("\n").filter(Boolean).map(JSON.parse):[];
const sends=()=>events().filter(event=>event.type==="synthetic_send");
const descriptor=()=>JSON.parse(fs.readFileSync(path.join(root,"native-owner.json"),"utf8"));
async function post(route,value){
  const info=descriptor(),response=await fetch(info.endpoint+route,{method:"POST",headers:{"content-type":"application/json","x-native-control-token":info.controlToken,authorization:"Bearer lifecycle-fixture"},body:JSON.stringify(value),signal:AbortSignal.timeout(15000)});
  return {status:response.status,data:await response.json()};
}
const status=async()=>{const result=await post("/__native/manage",{action:"status"});assert.equal(result.status,200);return result.data;};
const health=()=>fetch(descriptor().endpoint+"/__native/health",{signal:AbortSignal.timeout(3000)}).then(response=>response.json());
const reason=result=>result.data?.error?.details?.[0]?.reason??result.data?.error?.code;
const body=name=>({model:WEB_MODEL,sessionId:name,conversationId:name,request:{contents:[{role:"user",parts:[{text:"Synthetic lifecycle "+name}]}]}});
async function startOwner(){
  const child=fork(path.join(repository,"tools/probes/fixtures/native-lifecycle-owner.mjs"),[root,String(port??0)],{cwd:repository,execArgv:[],stdio:["ignore","pipe","pipe","ipc"],windowsHide:true});owner=child;
  child.stderr.on("data",chunk=>{ownerErrors=(ownerErrors+chunk).slice(-12000);});child.stdout.resume();
  child.on("message",message=>{const pending=requests.get(message?.id);if(pending){requests.delete(message.id);message.ok?pending.resolve(message):pending.reject(Error("Owner fixture control refused"));}});
  const ready=await new Promise((resolve,reject)=>{const deadline=setTimeout(()=>reject(Error("Owner fixture startup deadline")),12000);const received=message=>{if(message?.ready){clearTimeout(deadline);child.off("message",received);resolve(message);}};child.on("message",received);child.once("exit",code=>{clearTimeout(deadline);reject(Error("Owner fixture exited before ready: "+code));});child.once("error",reject);});
  assert.equal(ready.pid,child.pid);if(port)assert.equal(ready.port,port);port=ready.port;return ready;
}
async function rpc(action,extra={}){
  assert.ok(owner?.connected);const id=randomUUID();
  return new Promise((resolve,reject)=>{const deadline=setTimeout(()=>{requests.delete(id);reject(Error("Owner control deadline"));},10000);requests.set(id,{resolve:value=>{clearTimeout(deadline);resolve(value);},reject:error=>{clearTimeout(deadline);reject(error);}});owner.send({id,action,...extra});});
}
async function stopOwner(crash=false){
  const child=owner;if(!child)return;const exited=new Promise(resolve=>child.once("exit",resolve));
  if(crash){oldPid=child.pid;assert.equal(child.kill("SIGKILL"),true);}else await rpc("stop");
  let deadline;try{await Promise.race([exited,new Promise((_resolve,reject)=>{deadline=setTimeout(()=>reject(Error("Owner exit deadline")),10000);})]);}finally{clearTimeout(deadline);}owner=undefined;
}
async function cli(args){
  cliCalls++;const environment={...process.env,AG_NATIVE_CLI_FIXTURE_ROOT:root};delete environment.NODE_OPTIONS;delete environment.ELECTRON_RUN_AS_NODE;
  const child=spawn(process.execPath,["--import",pathToFileURL(path.join(repository,"tools/probes/fixtures/native-cli-loopback.mjs")).href,path.join(repository,"packages/native-antigravity/dist/native-cli.js"),...args],{cwd:repository,env:environment,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let stdout="",stderr="";child.stdout.on("data",chunk=>{stdout+=chunk;});child.stderr.on("data",chunk=>{stderr=(stderr+chunk).slice(-2000);});
  const code=await new Promise((resolve,reject)=>{child.once("exit",resolve);child.once("error",reject);});
  let data;try{data=stdout.trim()?JSON.parse(stdout):stderr.split("\n").filter(line=>line.startsWith("{")).map(line=>JSON.parse(line)).at(-1);if(!data)throw Error("missing");}catch{throw Error("CLI did not return JSON (exit "+code+")");}
  return {exitCode:code,data,code:data.code??data.error?.code};
}
function receiptSummary(data){
  return {physicalCount:data.physical.length,allOwnersVerified:data.physical.every(row=>row.correlation==="verified"),ownerAccountIds:data.physical.map(row=>row.accountId),resultsAvailable:data.physical.map(row=>row.resultAvailable),replayAllowed:data.replayAllowed};
}
async function dispatch(command){
  if(command.action==="cli_status"){const result=await cli(["accounts:status"]);return {exitCode:result.exitCode,code:result.code,ownerId:result.data.ownerId,accountCount:result.data.accounts?.length};}
  if(command.action==="cli_add"){const result=await cli(["account:add","CLI Added"]);assert.equal(result.exitCode,0);return {accountCount:(await status()).accounts.length};}
  if(command.action==="cli_use"||command.action==="cli_verify"){
    const account=(await status()).accounts.find(account=>account.accountId===command.accountId);assert.ok(account);
    const result=await cli([command.action==="cli_use"?"account:use":"account:verify",account.accountId]);
    return {exitCode:result.exitCode,code:result.code,selectedAccountId:(await status()).selectedAccountId,identityVerified:result.data.identityVerified===true};
  }
  if(command.action==="scenario"){await rpc("scenario",{accountId:command.accountId,mode:command.mode});modes.push(command.mode);return {ok:true};}
  if(command.action==="baseline"){
    baseline=body("baseline-"+randomUUID());const result=await post("/v1internal:generateContent",baseline);assert.equal(result.status,200);baselineId=(await health()).lastTurn.requestId;assert.equal(sends().length,1);return {requestId:baselineId};
  }
  if(command.action==="crash_owner"){await stopOwner(true);return {oldPid};}
  if(command.action==="restart_owner"){const ready=await startOwner();assert.notEqual(ready.pid,oldPid);return {newPid:ready.pid,ownerId:(await status()).ownerId};}
  if(command.action==="retry_baseline"){
    const retry=await post("/v1internal:generateContent",baseline);assert.equal(retry.status,409);assert.equal(reason(retry),"OUTCOME_UNKNOWN");assert.equal(sends().length,1);
    const receipt=await cli(["receipt",baselineId]);assert.equal(receipt.exitCode,0);const summary=receiptSummary(receipt.data);assert.ok(summary.allOwnersVerified);assert.ok(summary.resultsAvailable.every(value=>value===false));return {code:reason(retry),syntheticSends:sends().length,...summary};
  }
  if(command.action==="model_failure"){
    const result=await post("/v1internal:generateContent",body("model-failure-"+randomUUID()));assert.equal(reason(result),"MODEL_UNAVAILABLE");assert.equal(sends().length,1);return {code:reason(result),syntheticSends:sends().length};
  }
  if(command.action==="start_ttl"){
    ttlRequest=body("ttl-"+randomUUID());const result=await post("/v1internal:generateContent",ttlRequest);assert.equal(result.status,200);ttlStarted=performance.now();ttlWallStart=Date.now();const observed=await health();ttlId=observed.lastTurn.requestId;assert.equal(observed.requestCache.resultTtlMs,600000);assert.equal(sends().length,2);return {requestId:ttlId,resultTtlMs:600000};
  }
  if(command.action==="await_ttl"){
    if(quick)return {status:"NOT_RUN",reason:"quick_fixture"};
    const remaining=()=>Math.max(0,601000-(performance.now()-ttlStarted));
    while(remaining()>0){assert.ok(owner&&owner.exitCode===null);await health();console.log(JSON.stringify({phase:"waiting_actual_ttl",remainingSeconds:Math.ceil(remaining()/1000)}));await new Promise(resolve=>setTimeout(resolve,Math.min(45000,remaining())));}
    const retry=await post("/v1internal:generateContent",ttlRequest);assert.equal(retry.status,409);assert.equal(reason(retry),"OUTCOME_UNKNOWN");assert.equal(sends().length,2);
    const receipt=await cli(["receipt",ttlId]);assert.equal(receipt.exitCode,0);const summary=receiptSummary(receipt.data);assert.ok(summary.allOwnersVerified);assert.ok(summary.resultsAvailable.every(value=>value===false));
    return {status:"PASS",elapsedMonotonicMs:Math.round(performance.now()-ttlStarted),elapsedWallMs:Date.now()-ttlWallStart,syntheticSends:sends().length,...summary};
  }
  throw Error("Unknown lifecycle fixture command");
}
await startOwner();
interval=setInterval(()=>{
  if(working)return;
  const file=fs.readdirSync(controlDirectory).find(name=>name.endsWith(".request.json")&&!completedIds.has(name.slice(0,-13)));if(!file)return;
  const request=JSON.parse(fs.readFileSync(path.join(controlDirectory,file),"utf8"));working=true;
  const reply=path.join(controlDirectory,request.id+".reply.json");
  void dispatch(request).then(value=>atomicPrivateFile(reply,JSON.stringify({id:request.id,ok:true,value})+"\n"),error=>atomicPrivateFile(reply,JSON.stringify({id:request.id,ok:false,error:String(error.message).slice(0,500)})+"\n")).finally(()=>{completedIds.add(request.id);working=false;});
},25);
const require=createRequire(import.meta.url),environment={...process.env,AG_LAUNCHER_SMOKE:"1",AG_NATIVE_ACCOUNTS_SMOKE:"1",AG_NATIVE_LIFECYCLE_SMOKE:"1",AG_LAUNCHER_DATA_DIR:root,ELECTRON_ENABLE_LOGGING:"0"};delete environment.ELECTRON_RUN_AS_NODE;delete environment.NODE_OPTIONS;
electron=spawn(require("electron"),[launcher],{cwd:launcher,env:environment,windowsHide:true,stdio:["ignore","pipe","pipe"]});electron.stdout.on("data",chunk=>{output=(output+chunk).slice(-12000);});electron.stderr.on("data",chunk=>{output=(output+chunk).slice(-12000);});
try{
  const code=await Promise.race([new Promise((resolve,reject)=>{electron.once("exit",resolve);electron.once("error",reject);}),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error("Lifecycle Electron deadline")),quick?90000:760000);})]);
  const file=path.join(root,"native-lifecycle-desktop.json");if(code!==0||!fs.existsSync(file)){console.error(output);throw Error("Lifecycle desktop failed: "+code);}
  const result={...JSON.parse(fs.readFileSync(file,"utf8")),cliCalls,cliSource:"production_dist",cliTransport:"owned_loopback_redirect_test_preloader",nativeProcessesRestarted:true,realMcpService:true,store:"real_sqlite_wal",syntheticSends:sends().length,syntheticOpens:events().filter(row=>row.type==="synthetic_open").length,realGoogleRequests:0,scenarios:modes};assert.equal(result.syntheticSends,2);
  const evidence=path.join(repository,"docs/evidence/p5-native-lifecycle"+(quick?"-quick":""));fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,"native-lifecycle.json"),JSON.stringify(result,null,2)+"\n");
  for(const file of fs.readdirSync(root).filter(name=>/^lifecycle-[a-z0-9-]+\.png$/.test(name)))fs.copyFileSync(path.join(root,file),path.join(evidence,file));
  console.log(JSON.stringify(result));
}finally{
  clearTimeout(timer);clearInterval(interval);
  if(electron.exitCode===null){electron.kill();await new Promise(resolve=>{electron.once("exit",resolve);setTimeout(resolve,3000);});}
  if(owner)await stopOwner().catch(async()=>{if(owner?.exitCode===null)await stopOwner(true);});
  const resolved=fs.realpathSync(root);if(path.dirname(resolved).toLowerCase()!==fs.realpathSync(os.tmpdir()).toLowerCase()||!path.basename(resolved).startsWith("launcher-smoke-native-lifecycle-"))throw Error("Invalid fixture cleanup target");fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
