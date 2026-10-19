// Synthetic pool lifecycle only. --expose-gc measures this Node process, not Chrome.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { getHeapSpaceStatistics } from "node:v8";
import { AccountRegistry } from "../../packages/native-antigravity/dist/account-registry.js";
import { NativeBrowserBackendPool } from "../../packages/native-antigravity/dist/browser-backend-pool.js";
import { NativeRouteError,sha256 } from "../../packages/native-antigravity/dist/native-protocol.js";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"ag-pool-lifecycle-spike-")),registry=new AccountRegistry(path.join(root,"accounts.json"));
const backendPoolJsSha256=sha256(fs.readFileSync(new URL("../../packages/native-antigravity/dist/browser-backend-pool.js",import.meta.url))),probeSha256=sha256(fs.readFileSync(new URL(import.meta.url)));
const started=performance.now(),cpuStarted=process.cpuUsage();let gcMs=0;
const accounts=["A","B"].map((name,index)=>registry.add({displayName:name,profilePath:path.join(root,"profile"+name),statePath:path.join(root,"state"+name),debugPort:15501+index,identityFingerprint:sha256(name)}));
let busy=false,generated=0,released=0,busyReleases=0;
const pool=new NativeBrowserBackendPool(registry,"unused",account=>({prepare:async()=>{},generate:async()=>{generated++;return "synthetic";},releaseConversation:async()=>{released++;if(account.displayName==="B"&&busy){busyReleases++;throw new NativeRouteError("BUSY","Synthetic busy owner",409);}},close:async()=>{}}));
const resources=()=>typeof pool.resourceStatus==="function"?pool.resourceStatus():{cachedWorkers:pool.backends.size,conversationOwners:pool.conversationOwners.size,pendingConversationReleases:[...pool.pendingReleases.values()].reduce((sum,entries)=>sum+entries.size,0),privatePrePatchDiagnostic:true};
const gc=()=>{if(typeof global.gc!=="function")throw Error("Use node --expose-gc for this bounded metadata probe");const startedGc=performance.now();global.gc();global.gc();gcMs+=performance.now()-startedGc;return process.memoryUsage();};
let evidence;
try{
  const a=pool.bindAccount(accounts[0].accountId),b=pool.bindAccount(accounts[1].accountId),signal=new AbortController().signal;
  await b.generate("busy-first","synthetic",signal,{conversation:{key:"busy-owner-B",revision:sha256("busy")}});busy=true;let busyError;
  try{await b.releaseConversation("busy-owner-B",true);}catch(error){busyError=error.code??"UNKNOWN";}
  const queued=resources();busy=false;await b.prepare(signal);const drained=resources();
  async function rounds(count,prefix,start=0){for(let index=0;index<count;index++){const key=prefix+(start+index);await a.generate(key,"synthetic",signal,{conversation:{key,revision:sha256(key)}});await a.releaseConversation(key,true);}}
  await rounds(500,"warm-");await new Promise(resolve=>setImmediate(resolve));const before=gc(),samples=[{rounds:0,memory:before,heapSpaces:getHeapSpaceStatistics()}];
  for(let chunk=0;chunk<4;chunk++){await rounds(2500,"soak-",chunk*2500);await new Promise(resolve=>setImmediate(resolve));samples.push({rounds:(chunk+1)*2500,memory:gc(),heapSpaces:getHeapSpaceStatistics()});}
  const after=samples.at(-1).memory,final=resources();
  const passed=!busyError&&queued.pendingConversationReleases===1&&drained.pendingConversationReleases===0&&final.conversationOwners===0&&final.pendingConversationReleases===0;
  evidence={checkedAt:new Date().toISOString(),status:passed?"PASS_POOL_RELEASE_LIFECYCLE_SYNTHETIC_GC":"REPRODUCED_BOUND_RELEASE_LEAK_AND_BUSY_DROP",backendPoolJsSha256,probeSha256,nodeVersion:process.version,v8Version:process.versions.v8,nodeMemoryArgs:process.execArgv.filter(value=>/^--(?:max-semi-space-size|max-old-space-size|expose-gc)(?:=|$)/.test(value)),elapsedMs:Math.round(performance.now()-started),cpuUsageUs:process.cpuUsage(cpuStarted),explicitGcMs:Math.round(gcMs),browser:"SYNTHETIC",realGooglePromptRequests:0,realMcpWorkers:0,realChromeProcesses:0,gc:"EXPLICIT_NODE_ONLY_WITH_MACROTASK_GAPS",liveMemoryGate:"NOT_PROVEN_FOR_MCP_CHROME",busyError:busyError??null,queued,drained,final,warmupRounds:500,soakRounds:10000,syntheticGenerations:generated,releaseCalls:released,busyReleases,nodeMemoryAfterWarmup:before,nodeMemoryAfterSoak:after,memorySamples:samples,heapDeltaAfterGc:after.heapUsed-before.heapUsed,rssDelta:after.rss-before.rss,lastHalfHeapDeltaAfterGc:after.heapUsed-samples[2].memory.heapUsed,lastHalfRssDelta:after.rss-samples[2].memory.rss};
}finally{await pool.close();const resolved=fs.realpathSync(root);assert.equal(path.dirname(resolved).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(resolved).startsWith("ag-pool-lifecycle-spike-"));fs.rmSync(resolved,{recursive:true,force:true});}
const output=process.argv.find(value=>value.startsWith("--output="))?.slice(9)??path.join(process.cwd(),".tmp/pool-lifecycle-spike.json");fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(evidence,null,2)+"\n");console.log(JSON.stringify({status:evidence.status,busyError:evidence.busyError,owners:evidence.final.conversationOwners,queued:evidence.queued.pendingConversationReleases,heapDeltaAfterGc:evidence.heapDeltaAfterGc,soakRounds:evidence.soakRounds}));
