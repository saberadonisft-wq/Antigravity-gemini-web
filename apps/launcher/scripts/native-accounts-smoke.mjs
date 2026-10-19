import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { AccountRegistry } from "../../../packages/native-antigravity/dist/account-registry.js";
import { NativeBrowserBackendPool } from "../../../packages/native-antigravity/dist/browser-backend-pool.js";
import { startNativeProxy } from "../../../packages/native-antigravity/dist/native-proxy.js";
import { NativeRouteError,sha256 } from "../../../packages/native-antigravity/dist/native-protocol.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),temporary=fs.mkdtempSync(path.join(os.tmpdir(),"launcher-smoke-native-accounts-"));
const registry=new AccountRegistry(path.join(temporary,"accounts.json"));
for(const name of ["A","B"])registry.add({displayName:"Fixture "+name,profilePath:path.join(temporary,"profile_"+name),statePath:path.join(temporary,"state_"+name),identityFingerprint:name==="A"?sha256("a@fixture.invalid"):undefined});
const counts={opens:0,identityChecks:0,syntheticGenerations:0,realGoogleRequests:0};let bChecks=0;
const pool=new NativeBrowserBackendPool(registry,"unused",account=>({close:async()=>{},prepare:async()=>{},openBrowser:async()=>{counts.opens++;return {opened:true};},inspectIdentity:async()=>{
  counts.identityChecks++;const letter=account.displayName.endsWith(" B")?"b":"a";
  if(letter==="b"&&++bChecks===1)throw new NativeRouteError("BROWSER_USER_ACTION_REQUIRED","Synthetic Google verification gate",412);
  return {accountIdentity:letter+"@fixture.invalid"};
},generate:async(_id,_prompt,signal,options)=>{
  counts.syntheticGenerations++;options.onSubmissionStarted?.();
  await new Promise((_resolve,reject)=>{const stop=()=>{setTimeout(()=>{options.onCancellationResult?.({confirmed:true,reason:"synthetic_stop"});reject(signal.reason);},180);};if(signal.aborted)stop();else signal.addEventListener("abort",stop,{once:true});});
  throw Error("Synthetic fixture cannot complete a response");
}}));
const token=randomBytes(32).toString("hex"),proxy=await startNativeProxy({backend:pool,accountRegistry:registry,stateDirectory:path.join(temporary,"native"),port:0,controlToken:token,control:async()=>{throw Error("No external requests allowed");}});
fs.writeFileSync(path.join(temporary,"native-owner.json"),JSON.stringify({version:1,pid:process.pid,endpoint:"http://127.0.0.1:"+proxy.port,controlToken:token}));
const require=createRequire(import.meta.url),environment={...process.env,AG_LAUNCHER_SMOKE:"1",AG_NATIVE_ACCOUNTS_SMOKE:"1",AG_LAUNCHER_DATA_DIR:temporary,ELECTRON_ENABLE_LOGGING:"0"};delete environment.ELECTRON_RUN_AS_NODE;delete environment.NODE_OPTIONS;
const child=spawn(require("electron"),[root],{cwd:root,env:environment,windowsHide:true,stdio:["ignore","pipe","pipe"]});let output="",timer;child.stdout.on("data",chunk=>{output+=chunk;});child.stderr.on("data",chunk=>{output+=chunk;});
try{
  const code=await Promise.race([new Promise((resolve,reject)=>{child.once("exit",resolve);child.once("error",reject);}),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error("Native account desktop deadline")),55000);})]);
  const file=path.join(temporary,"native-accounts-desktop.json");if(code!==0||!fs.existsSync(file)){console.error(output.slice(-12000));throw Error("Native account desktop failed: "+code);}
  if(counts.opens!==1||counts.identityChecks!==3||counts.syntheticGenerations!==1||counts.realGoogleRequests!==0)throw Error("Unexpected fixture action counts: "+JSON.stringify(counts));
  const evidenceArgument=process.argv.find(value=>value.startsWith("--evidence="))?.slice("--evidence=".length);
  const evidence=evidenceArgument?path.resolve(evidenceArgument):path.resolve(root,"../../docs/evidence/p5-native-accounts");fs.mkdirSync(evidence,{recursive:true});
  const result={...JSON.parse(fs.readFileSync(file,"utf8")),...counts};fs.writeFileSync(path.join(evidence,"native-accounts-desktop.json"),JSON.stringify(result,null,2)+"\n");
  for(const name of fs.readdirSync(temporary).filter(value=>/^accounts-[a-z0-9-]+\.png$/.test(value)))fs.copyFileSync(path.join(temporary,name),path.join(evidence,name));
  console.log(JSON.stringify(result));
}finally{
  clearTimeout(timer);if(child.exitCode===null){child.kill();await new Promise(resolve=>{child.once("exit",resolve);setTimeout(resolve,3000);});}
  await proxy.close();
  const resolved=fs.realpathSync(temporary);if(path.dirname(resolved).toLowerCase()!==fs.realpathSync(os.tmpdir()).toLowerCase()||!path.basename(resolved).startsWith("launcher-smoke-native-accounts-"))throw Error("Invalid cleanup target");
  fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
