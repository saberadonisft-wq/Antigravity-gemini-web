// Production CLI + real child Native/MCP/SQLite, with a synthetic browser only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork,execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath,pathToFileURL } from "node:url";
import { sha256,canonical,compileNativeTurn,WEB_MODEL } from "../../packages/native-antigravity/dist/native-protocol.js";

const repo=fileURLToPath(new URL("../../",import.meta.url)),root=fs.mkdtempSync(path.join(os.tmpdir(),"launcher-smoke-native-lifecycle-knowledge-"));
const child=fork(path.join(repo,"tools/probes/fixtures/native-lifecycle-owner.mjs"),[root,"0","--knowledge"],{cwd:repo,windowsHide:true,stdio:["ignore","ignore","pipe","ipc"]});
let stderr="",owner,endpoint,cliCalls=0;child.stderr.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(-4096);});
const execFileAsync=promisify(execFile),commands=[];
const authorization="Bearer synthetic-knowledge-cli",request=text=>({model:WEB_MODEL,sessionId:"knowledge-cli-fixture",conversationId:"knowledge-cli-fixture",request:{systemInstruction:{parts:[{text:"Current synthetic native authority"}]},contents:[{role:"user",parts:[{text}]}]}});
async function cli(...args){cliCalls++;commands.push(args[0]);const result=await execFileAsync(process.execPath,["--import",pathToFileURL(path.join(repo,"tools/probes/fixtures/native-cli-loopback.mjs")).href,path.join(repo,"packages/native-antigravity/dist/native-cli.js"),...args],{cwd:repo,env:{...process.env,AG_NATIVE_CLI_FIXTURE_ROOT:root},windowsHide:true,timeout:30000,maxBuffer:1024*1024});return JSON.parse(result.stdout);}
async function native(text){const response=await fetch(endpoint+"/v1internal:generateContent",{method:"POST",headers:{authorization,"content-type":"application/json"},body:JSON.stringify(request(text)),signal:AbortSignal.timeout(15000)});return {status:response.status,data:await response.json()};}
async function health(){return fetch(endpoint+"/__native/health",{signal:AbortSignal.timeout(5000)}).then(response=>response.json());}
function sends(){return fs.readFileSync(path.join(root,"events.jsonl"),"utf8").trim().split("\n").filter(Boolean).map(line=>JSON.parse(line)).filter(event=>event.type==="synthetic_send");}
let evidence;
try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("Fixture readiness timeout")),20000);child.once("error",error=>{clearTimeout(timer);reject(error);});child.once("exit",()=>{clearTimeout(timer);reject(Error("Fixture exited before readiness"));});child.once("message",message=>{clearTimeout(timer);if(!message?.ready)reject(Error("Invalid fixture handshake"));else resolve();});});
  owner=JSON.parse(fs.readFileSync(path.join(root,"native-owner.json"),"utf8"));endpoint=owner.endpoint;
  const initial=await cli("knowledge");assert.equal(initial.experimentalEnabled,true);assert.equal(initial.sources.length,0);
  const accounts=(await cli("accounts")).accounts;assert.equal(accounts.length,3);const [a,b]=accounts;
  const project=path.join(root,"synthetic-project");fs.mkdirSync(project);const selected=path.join(project,"README.md");fs.writeFileSync(selected,"SYNTHETIC_KNOWLEDGE_CLI_REFERENCE\r\nTiếng Việt 😀\r\n");fs.writeFileSync(path.join(project,"not-selected.md"),"UNSELECTED_DATA");
  const imported=await cli("knowledge:import","--label","Synthetic fixture","--root",project,"--file","README.md"),source=imported.sources[0].sourceId;
  assert.ok(!JSON.stringify(imported).includes(project));assert.equal(imported.sources[0].fileCount,1);
  assert.equal((await cli("knowledge:check",source)).sources[0].state,"current");
  const task=sha256(compileNativeTurn(request("initial"),sha256(authorization)).taskKey+canonical({model:"4 Argon",effort:"Low"}));
  await cli("knowledge:bind","--account",a.accountId,"--task",task,"--source",source);
  assert.equal((await native("initial")).status,200);assert.equal((await health()).lastTurn.knowledge.used,true);assert.equal((await native("initial")).status,200);assert.equal(sends().length,1);
  fs.writeFileSync(selected,"SYNTHETIC_UPDATED_REFERENCE\n");assert.equal((await native("initial")).status,409);assert.equal(sends().length,1);
  assert.equal((await native("stale source excluded")).status,200);assert.deepEqual((await health()).lastTurn.knowledge.issues,["SOURCE_STALE"]);
  const refreshed=await cli("knowledge:refresh",source);assert.equal(refreshed.sources[0].revision,2);await cli("knowledge:check",source);assert.equal((await native("explicitly refreshed source")).status,200);assert.equal((await health()).lastTurn.knowledge.used,true);
  await cli("account:use",b.accountId);assert.equal((await native("different account")).status,200);assert.deepEqual((await health()).lastTurn.knowledge.issues,["SOURCE_ACCOUNT_NOT_BOUND"]);
  await cli("knowledge:bind","--account",b.accountId,"--task",task,"--source",source);assert.equal((await native("explicitly bound B")).status,200);assert.equal((await health()).lastTurn.knowledge.used,true);
  await cli("knowledge:clear","--account",b.accountId,"--task",task);assert.equal((await native("cleared source binding")).status,200);assert.equal((await health()).lastTurn.knowledge.used,false);assert.equal(sends().length,6);
  const external=await cli("knowledge:register","notebook","--label","Metadata only","--url","https://notebook.google.com/notebook/synthetic-fixture");assert.equal(external.sources.find(item=>item.kind==="notebook").state,"not_verified");
  const removed=await cli("knowledge:remove",external.sources.find(item=>item.kind==="notebook").sourceId);assert.equal(removed.sources.length,1);assert.equal(fs.existsSync(selected),true);
  const metadata=fs.readFileSync(path.join(root,"home/.gemini/antigravity-gemini-web-live/app_data/native-route/knowledge.json"),"utf8");assert.ok(!metadata.includes("SYNTHETIC_KNOWLEDGE_CLI_REFERENCE"));assert.ok(!metadata.includes("SYNTHETIC_UPDATED_REFERENCE"));
  const ledger=await cli("receipt",compileNativeTurn(request("initial"),sha256(authorization)).requestId);assert.ok(JSON.stringify(ledger).includes("completed"));assert.equal(sends().length,6);
  evidence={checkedAt:new Date().toISOString(),kind:"P6A_PRODUCTION_CLI_NATIVE_MCP_SQLITE_SYNTHETIC_BROWSER",status:"PASS",nativeRuntimeRevision:(await health()).runtimeRevision,cliCalls,commands,selectedFiles:1,sourceRevision:2,syntheticSends:6,duplicateSends:0,staleCachedReplyWithdrawn:true,staleSourceOmitted:true,accountBRequiresExplicitBinding:true,explicitClear:true,metadataRemovalKeepsFiles:true,registryContainsSourceContent:false,snapshotAttachmentExperimental:false,externalAdapter:"NOT_VERIFIED_METADATA_ONLY",realGoogleRequests:0,realIdeExecutor:"NOT_TESTED",liveKnowledgeAdapters:"NOT_TESTED"};
}catch(error){throw new Error("Knowledge fixture failed: "+String(error)+(stderr?"; fixture stderr: "+stderr:""),{cause:error});}
finally{
  if(child.exitCode===null&&child.connected){const stopped=new Promise(resolve=>child.once("exit",resolve));child.send({id:"stop",action:"stop"});let timer;await Promise.race([stopped,new Promise(resolve=>{timer=setTimeout(resolve,10000);})]);clearTimeout(timer);if(child.exitCode===null){child.kill();await stopped;}}
  const resolved=fs.realpathSync(root);assert.equal(path.dirname(resolved).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(resolved).startsWith("launcher-smoke-native-lifecycle-knowledge-"));fs.rmSync(resolved,{recursive:true,force:true});
}
const output=process.argv.find(value=>value.startsWith("--output="))?.slice(9)??path.join(repo,".tmp/p6-knowledge-cli-evidence.json");fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(evidence,null,2)+"\n");console.log(JSON.stringify(evidence));
