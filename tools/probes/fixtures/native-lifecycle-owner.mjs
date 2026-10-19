// Test child only: real Native/MCP/SQLite, synthetic browser and no external transport.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { AccountRegistry } from "../../../packages/native-antigravity/dist/account-registry.js";
import { NativeBrowserBackendPool } from "../../../packages/native-antigravity/dist/browser-backend-pool.js";
import { McpNativeBrowserBackend } from "../../../packages/native-antigravity/dist/browser-backend.js";
import { startNativeProxy } from "../../../packages/native-antigravity/dist/native-proxy.js";
import { sha256 } from "../../../packages/native-antigravity/dist/native-protocol.js";
import { atomicPrivateFile } from "../../../packages/native-antigravity/dist/installation.js";
import { GeminiMcpService } from "../../../packages/mcp-server/dist/service.js";

if(!process.send)throw Error("Owned IPC parent required");
const root=fs.realpathSync(process.argv[2]);
if(path.dirname(root).toLowerCase()!==fs.realpathSync(os.tmpdir()).toLowerCase()||!path.basename(root).startsWith("launcher-smoke-native-lifecycle-"))throw Error("Invalid fixture root");
const home=path.join(root,"home"),nativeHome=path.join(home,".gemini","antigravity-gemini-web-live","app_data","native-route");
const registry=new AccountRegistry(path.join(nativeHome,"accounts.json"));
if(!registry.list().length)for(const letter of ["A","B","C"])registry.add({displayName:"Fixture "+letter,profilePath:path.join(root,"profiles",letter),statePath:path.join(root,"mcp",letter),identityFingerprint:sha256(letter.toLowerCase()+"@fixture.invalid")});
const services=new Map(),modes=new Map(),policy={model:"Fixture Primary",effort:"Low"};
function event(type,accountId,requestId){
  const fd=fs.openSync(path.join(root,"events.jsonl"),"a",0o600);
  try{fs.writeFileSync(fd,JSON.stringify({type,accountId,requestId,at:new Date().toISOString()})+"\n");fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function serviceFor(account){
  let service=services.get(account.accountId);if(service)return service;
  const prompts=new Map(),email=/^Fixture ([ABC])$/.exec(account.displayName)?.[1]?.toLowerCase()+"@fixture.invalid";
  const identity=email.startsWith("undefined")?account.accountId+"@fixture.invalid":email;
  const browser={supportsRetainedConversations:true,supportsProgressStreaming:true,supportsAccountIdentityVerification:true,supportsConversationUrlCheckpoint:true,
    checkStatus:async()=>({browserState:"ready",accountState:modes.get(account.accountId)==="login_required"?"needs_user_action":"signed_in",accountIdentity:modes.get(account.accountId)==="login_required"?undefined:identity,checkedAt:new Date().toISOString()}),
    openBrowser:async()=>{event("synthetic_open",account.accountId);return {opened:true};},
    selectModel:async selected=>{if(modes.get(account.accountId)==="model_unavailable"||selected.model!==policy.model||selected.effort!==policy.effort)throw {code:"MODEL_UNAVAILABLE"};return {...selected};},
    openFreshConversation:async()=>({close:async()=>{},suspend:async()=>{},resume:async()=>{},preserve:async()=>{}}),
    ...(process.argv.includes("--recovery-mode")?{openExistingConversation:async url=>{event("synthetic_resume_attach",account.accountId);return {conversationUrl:url,close:async()=>{},suspend:async()=>{},resume:async()=>{},preserve:async()=>{}};}}:{}),
    submitPrompt:async(id,prompt,options)=>{event("synthetic_send",account.accountId,id);prompts.set(id,prompt);return {turnId:id,status:"accepted",submittedAt:new Date().toISOString()};},
    pollResponse:async id=>{if(process.argv.includes("--recovery-hold-response")){event("synthetic_response_barrier",account.accountId,id);await new Promise(()=>{});}const nonce=/"nonce":"([a-f0-9]{48})"/.exec(prompts.get(id)??"")?.[1];if(!nonce)throw Error("Fixture nonce missing");return {turnId:id,status:"completed",text:JSON.stringify({nonce,type:"final",text:"SYNTHETIC_OWNER_REPLY"}),completedAt:new Date().toISOString()};},
    cancelPrompt:async id=>({turnId:id,cancelled:false}),cleanup:async()=>{},sendPrompt:async()=>{throw Error("unused");},
  };
  service=new GeminiMcpService(browser,path.join(account.statePath,"receipts.json"));services.set(account.accountId,service);return service;
}
const pool=new NativeBrowserBackendPool(registry,"unused",account=>{
  const backend=new McpNativeBrowserBackend("unused",undefined,account.identityFingerprint??"");
  Object.assign(backend,{connect:async()=>{},call:async(name,args)=>{
    const service=serviceFor(account);
    if(name==="gemini_status")return service.status();
    if(name==="gemini_open_browser")return service.openBrowser();
    if(name==="gemini_submit")return service.submit(args.request_id,args.prompt,{nativeOwner:args.native_owner,expectedAccountFingerprint:args.expected_account_fingerprint,modelSelection:args.model_selection,conversation:args.conversation?{key:args.conversation.key,revision:args.conversation.revision,baseRevision:args.conversation.base_revision}:undefined});
    if(name==="gemini_result")return service.result(args.request_id,args.wait_ms,args.after_revision);
    if(name==="gemini_receipt")return service.inspectReceipt(args.request_id);
    if(name==="gemini_release_conversation")return service.releaseConversation(args.key,args.preserve_tab);
    throw Error("Unexpected fixture broker operation");
  }});return backend;
});
const token=randomBytes(32).toString("hex"),proxy=await startNativeProxy({backend:pool,accountRegistry:registry,stateDirectory:nativeHome,port:Number(process.argv[3]??0),controlToken:token,knowledgeExperimental:process.argv.includes("--knowledge"),importsExperimental:process.argv.includes("--imports"),control:async()=>{throw Error("External control transport forbidden");}});
const endpoint="http://127.0.0.1:"+proxy.port;
const owner={version:1,pid:process.pid,controlToken:token};
// Only the CLI preloader rewrites the fixed production origin into this owned fixture.
atomicPrivateFile(path.join(nativeHome,"proxy-owner.json"),JSON.stringify({...owner,endpoint:"http://127.0.0.1:9236"})+"\n");
atomicPrivateFile(path.join(root,"native-owner.json"),JSON.stringify({...owner,endpoint})+"\n");
atomicPrivateFile(path.join(root,"cli-fixture.json"),JSON.stringify({home,endpoint})+"\n");
const routing=await fetch(endpoint+"/__native/router",{method:"POST",headers:{"x-native-control-token":token,"content-type":"application/json"},body:JSON.stringify({action:"status"})}).then(response=>response.json());
if(!routing.settings.modelSelection){const configured=await fetch(endpoint+"/__native/router",{method:"POST",headers:{"x-native-control-token":token,"content-type":"application/json"},body:JSON.stringify({action:"configure",expectedRevision:routing.revision,settings:{mode:"manual",modelSelection:policy}})});if(!configured.ok)throw Error("Fixture policy not configured");}
let closing;
async function close(){if(closing)return closing;closing=(async()=>{await proxy.close();for(const service of services.values())await service.close();})();return closing;}
process.on("message",async message=>{
  try{
    if(message?.action==="scenario"){
      if(!["ready","login_required","model_unavailable"].includes(message.mode)||!registry.get(message.accountId))throw Error("Invalid fixture scenario");
      modes.set(message.accountId,message.mode);process.send?.({id:message.id,ok:true});
    }else if(message?.action==="stop"){await close();process.send?.({id:message.id,ok:true});process.disconnect();}
    else throw Error("Invalid fixture action");
  }catch{process.send?.({id:message?.id,ok:false});}
});
process.on("disconnect",()=>{void close().finally(()=>process.exit(0));});
process.send({ready:true,pid:process.pid,port:proxy.port});
