// Owned real Electron/IPC/HTTP fixture. --real-chooser uses the actual OS dialog.
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
import { sha256,WEB_MODEL } from "../../../packages/native-antigravity/dist/native-protocol.js";

const realChooser=process.argv.includes("--real-chooser"),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),temporary=fs.mkdtempSync(path.join(os.tmpdir(),"launcher-smoke-native-knowledge-")),project=path.join(temporary,"project");fs.mkdirSync(project);
fs.writeFileSync(path.join(project,"README.md"),"SYNTHETIC_KNOWLEDGE_DESKTOP_CONTENT\r\nTiếng Việt 😀\r\n");fs.writeFileSync(path.join(project,"architecture.md"),"SYNTHETIC_ARCHITECTURE_CONTENT");fs.writeFileSync(path.join(project,".env"),"synthetic excluded file");
fs.writeFileSync(path.join(temporary,"knowledge-dialog.json"),JSON.stringify({canceled:false,filePaths:[path.join(project,"README.md"),path.join(project,"architecture.md")]}));
const registry=new AccountRegistry(path.join(temporary,"accounts.json"));for(const name of ["A","B"])registry.add({displayName:"Fixture "+name,profilePath:path.join(temporary,"profile"+name),statePath:path.join(temporary,"state"+name),identityFingerprint:sha256(name+"@fixture.invalid")});
let generations=0;
const pool=new NativeBrowserBackendPool(registry,"unused",()=>({prepare:async()=>{},close:async()=>{},generate:async(id,_prompt,signal,options)=>{
  options.onPhysicalSubmission?.(id);options.onSubmissionStarted?.();generations++;
  while(fs.existsSync(path.join(temporary,"hold-turn"))){signal.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,20));}
  options.onConversationCheckpoint?.("https://gemini.google.com/app/desktop-knowledge-fixture");return JSON.stringify({nonce:options.responseNonce,type:"final",text:"SYNTHETIC_DESKTOP_REPLY"});
}}));
const token=randomBytes(32).toString("hex"),proxy=await startNativeProxy({backend:pool,accountRegistry:registry,stateDirectory:path.join(temporary,"native"),port:0,controlToken:token,knowledgeExperimental:true,control:async()=>{throw Error("External transport forbidden");}}),endpoint="http://127.0.0.1:"+proxy.port;
fs.writeFileSync(path.join(temporary,"native-owner.json"),JSON.stringify({version:1,pid:process.pid,endpoint,controlToken:token}));
const seed={model:WEB_MODEL,sessionId:"knowledge-desktop-chat",conversationId:"knowledge-desktop-chat",request:{contents:[{role:"user",parts:[{text:"seed native chat"}]}]}};
const response=await fetch(endpoint+"/v1internal:generateContent",{method:"POST",headers:{authorization:"Bearer desktop-knowledge","content-type":"application/json"},body:JSON.stringify(seed)});if(!response.ok)throw Error("Native seed failed");await response.json();
const headers={"x-native-control-token":token,"content-type":"application/json"};
const status=await fetch(endpoint+"/__native/knowledge",{method:"POST",headers,body:JSON.stringify({action:"status"})}).then(response=>response.json());
const registered=await fetch(endpoint+"/__native/knowledge",{method:"POST",headers,body:JSON.stringify({action:"register_external",kind:"notebook",label:"Notebook metadata only",url:"https://notebook.google.com/notebook/synthetic-desktop",expectedOwnerId:status.ownerId,expectedRevision:status.revision})});if(!registered.ok)throw Error("Metadata seed failed");await registered.json();
const environment={...process.env,AG_LAUNCHER_SMOKE:"1",AG_NATIVE_ACCOUNTS_SMOKE:"1",AG_NATIVE_KNOWLEDGE_SMOKE:"1",AG_LAUNCHER_DATA_DIR:temporary,ELECTRON_ENABLE_LOGGING:"0"};delete environment.ELECTRON_RUN_AS_NODE;delete environment.NODE_OPTIONS;
if(realChooser)environment.AG_NATIVE_KNOWLEDGE_REAL_CHOOSER="1";else delete environment.AG_NATIVE_KNOWLEDGE_REAL_CHOOSER;
const require=createRequire(import.meta.url),child=spawn(require("electron"),[root],{cwd:root,env:environment,windowsHide:!realChooser,stdio:["ignore","pipe","pipe"]});let output="",timer;child.stdout.on("data",chunk=>{output=(output+chunk).slice(-16000);});child.stderr.on("data",chunk=>{output=(output+chunk).slice(-16000);});
if(realChooser)console.log(JSON.stringify({readyForComputerUse:true,windowTitle:"Native Knowledge - Real Chooser Acceptance",fixtureRoot:temporary,childPid:child.pid}));
try{
  const code=await Promise.race([new Promise((resolve,reject)=>{child.once("exit",resolve);child.once("error",reject);}),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error("Knowledge desktop deadline")),realChooser?900000:55000);})]);
  const filename=realChooser?"native-knowledge-real-chooser.json":"native-knowledge-desktop.json",file=path.join(temporary,filename);if(code!==0||!fs.existsSync(file)){console.error(output.slice(-10000));throw Error("Knowledge desktop failed: "+code);}
  if(generations!==(realChooser?1:2))throw Error("Unexpected synthetic generation count: "+generations);
  const evidenceArgument=process.argv.find(value=>value.startsWith("--evidence="))?.slice(11),evidence=evidenceArgument?path.resolve(evidenceArgument):path.resolve(root,"../../docs/evidence/"+(realChooser?"p6b-native-real-chooser-r35":"p6b-native-knowledge-r35"));fs.mkdirSync(evidence,{recursive:true});
  const result={...JSON.parse(fs.readFileSync(file,"utf8")),syntheticGenerations:generations,realGooglePromptRequests:0};fs.writeFileSync(path.join(evidence,filename),JSON.stringify(result,null,2)+"\n");
  for(const name of fs.readdirSync(temporary).filter(value=>/^knowledge-[a-z0-9-]+\.png$/.test(value)))fs.copyFileSync(path.join(temporary,name),path.join(evidence,name));console.log(JSON.stringify(result));
}finally{
  clearTimeout(timer);if(child.exitCode===null){const exited=new Promise(resolve=>child.once("exit",resolve));child.kill();let stopTimer;await Promise.race([exited,new Promise(resolve=>{stopTimer=setTimeout(resolve,3000);})]);clearTimeout(stopTimer);}
  await proxy.close();
  const resolved=fs.realpathSync(temporary);if(path.dirname(resolved).toLowerCase()!==fs.realpathSync(os.tmpdir()).toLowerCase()||!path.basename(resolved).startsWith("launcher-smoke-native-knowledge-"))throw Error("Invalid cleanup target");fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
