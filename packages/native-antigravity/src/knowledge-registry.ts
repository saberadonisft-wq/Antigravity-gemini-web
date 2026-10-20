import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { KnowledgeRegistrySchema,type KnowledgeRegistry,type KnowledgeCodeImport,type KnowledgeCodeSource,type KnowledgeExternalSource,type KnowledgeSnapshot,type KnowledgeSource } from "@antigravity-gemini-web/contracts";
import { atomicPrivateFile,assertNoLinks } from "./installation.js";
import { canonical,sha256,NativeRouteError } from "./native-protocol.js";
import { githubRepository,importKnowledgeCode,knowledgeError,verifyKnowledgeCode,selectedKnowledgePath } from "./knowledge-files.js";

export const MAX_KNOWLEDGE_WIRE_CHARS=32768;
type Observation={revision:number;state:"current"|"stale"|"unavailable";reasonCode?:string;checkedAt:string};
export interface KnowledgeResolution {wire?:unknown;used:boolean;issues:string[];assertCurrent():void}
function externalUrl(kind:KnowledgeExternalSource["kind"],value:string){
  if(kind==="github_web")return githubRepository(value);
  let url:URL;try{url=new URL(value);}catch{knowledgeError("SOURCE_URL_INVALID");}
  if(url.protocol!=="https:"||url.username||url.password||url.port||url.search||url.hash)knowledgeError("SOURCE_URL_INVALID");
  const allowed=kind==="gem"?url.hostname==="gemini.google.com"&&/^\/gem\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname):kind==="notebook"?["notebook.google.com","notebooklm.google.com"].includes(url.hostname)&&/^\/notebook\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname):((url.hostname==="drive.google.com"&&/^\/file\/d\/[A-Za-z0-9_-]{1,160}(?:\/view)?$/.test(url.pathname))||(url.hostname==="docs.google.com"&&/^\/(?:document|spreadsheets|presentation)\/d\/[A-Za-z0-9_-]{1,160}(?:\/edit)?$/.test(url.pathname)));
  if(!allowed)knowledgeError("SOURCE_URL_INVALID");return url.href;
}
function isCode(source:KnowledgeSource):source is KnowledgeCodeSource{return source.kind==="local_folder"||source.kind==="github_checkout";}
const code=(error:unknown)=>error instanceof NativeRouteError?error.code:"SOURCE_UNAVAILABLE";

/** Metadata only. Selected source bytes are read into RAM and never saved here. */
export class NativeKnowledgeRegistry {
  private observations=new Map<string,Observation>();
  constructor(private readonly filename:string){assertNoLinks(filename);}
  snapshot():KnowledgeRegistry {
    assertNoLinks(this.filename);if(!fs.existsSync(this.filename))return {version:1,revision:0,sources:[],bindings:[]};
    try{
      if(fs.statSync(this.filename).size>16*1048576)throw Error("oversized");
      const data=KnowledgeRegistrySchema.parse(JSON.parse(fs.readFileSync(this.filename,"utf8")));
      if(new Set(data.sources.map(source=>source.sourceId)).size!==data.sources.length||new Set(data.bindings.map(binding=>binding.taskScope+":"+binding.accountId)).size!==data.bindings.length)throw Error("duplicate");
      for(const source of data.sources){
        if(isCode(source)){
          if(!path.isAbsolute(source.root)||(source.kind==="github_checkout")!==!!source.git||source.digest!==sha256(canonical({files:source.files,git:source.git}))||new Set(source.files.map(file=>file.path.toLowerCase())).size!==source.files.length||source.files.reduce((total,file)=>total+file.bytes,0)>8*1048576)throw Error("source digest");
          for(const file of source.files)if(selectedKnowledgePath(file.path)!==file.path)throw Error("noncanonical file");
          if(source.git&&githubRepository(source.git.repository)!==source.git.repository)throw Error("noncanonical repository");
        }else if(externalUrl(source.kind,source.url)!==source.url||source.kind==="gem"&&!source.instructionVersion||source.kind!=="gem"&&source.instructionVersion)throw Error("invalid external metadata");
      }
      for(const binding of data.bindings)if(new Set(binding.sourceIds).size!==binding.sourceIds.length||binding.sourceIds.some(id=>!data.sources.some(source=>source.sourceId===id)))throw Error("binding");
      return data;
    }catch{knowledgeError("SOURCE_REGISTRY_UNAVAILABLE");}
  }
  private mutate<T>(expectedRevision:number,action:(state:KnowledgeRegistry)=>T):T {
    assertNoLinks(this.filename);fs.mkdirSync(path.dirname(this.filename),{recursive:true});const lock=this.filename+".lock",token=randomUUID();assertNoLinks(lock);let fd:number;
    try{fd=fs.openSync(lock,"wx",0o600);}catch{knowledgeError("SOURCE_REGISTRY_BUSY");}
    try{
      fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token})+"\n");fs.fsyncSync(fd);
      const state=this.snapshot();if(state.revision!==expectedRevision)knowledgeError("SOURCE_CONFIG_CONFLICT");
      const result=action(state);state.revision++;KnowledgeRegistrySchema.parse(state);atomicPrivateFile(this.filename,JSON.stringify(state)+"\n");return result;
    }finally{
      fs.closeSync(fd);let same=false;try{same=JSON.parse(fs.readFileSync(lock,"utf8")).token===token;}catch{}
      if(!same)knowledgeError("SOURCE_REGISTRY_UNAVAILABLE");fs.unlinkSync(lock);
    }
  }
  retireAccountBindings(accountId:string){
    const snapshot=this.snapshot();if(!snapshot.bindings.some(binding=>binding.accountId===accountId))return;
    const backup=this.filename+".before-account-removal.backup";assertNoLinks(backup);
    if(!fs.existsSync(backup))atomicPrivateFile(backup,JSON.stringify(snapshot)+"\n");
    this.mutate(snapshot.revision,state=>{state.bindings=state.bindings.filter(binding=>binding.accountId!==accountId);});
  }
  importCode(params:KnowledgeCodeImport,expectedRevision:number){
    const source=importKnowledgeCode(params);
    this.mutate(expectedRevision,state=>{if(state.sources.length>=64)knowledgeError("SOURCE_CAPACITY_FULL");state.sources.push(source);});return source;
  }
  registerExternal(params:{kind:KnowledgeExternalSource["kind"];label:string;url:string;instructionVersion?:string},expectedRevision:number){
    if(params.kind==="gem"&&!params.instructionVersion||params.kind!=="gem"&&params.instructionVersion)knowledgeError("SOURCE_INSTRUCTION_VERSION_REQUIRED");
    const now=new Date().toISOString(),source={...params,url:externalUrl(params.kind,params.url),sourceId:randomUUID(),revision:1,createdAt:now,updatedAt:now};
    this.mutate(expectedRevision,state=>{if(state.sources.length>=64)knowledgeError("SOURCE_CAPACITY_FULL");state.sources.push(source);});return source;
  }
  refresh(sourceId:string,expectedRevision:number,overlayFiles?:string[]){
    const current=this.snapshot().sources.find(source=>source.sourceId===sourceId);if(!current||!isCode(current))knowledgeError("SOURCE_REFRESH_UNAVAILABLE");
    const source=importKnowledgeCode({kind:current.kind,label:current.label,root:current.root,files:current.files.map(file=>file.path),overlayFiles:overlayFiles??current.files.filter(file=>file.origin==="overlay").map(file=>file.path),repository:current.git?.repository},current);
    this.mutate(expectedRevision,state=>{const index=state.sources.findIndex(item=>item.sourceId===sourceId&&item.revision===current.revision);if(index<0)knowledgeError("SOURCE_CONFIG_CONFLICT");state.sources[index]=source;});this.observations.delete(sourceId);return source;
  }
  bind(taskScope:string,accountId:string,identityEpoch:number,sourceIds:string[],expectedRevision:number){
    this.mutate(expectedRevision,state=>{
      if(sourceIds.some(id=>!state.sources.some(source=>source.sourceId===id))||new Set(sourceIds).size!==sourceIds.length)knowledgeError("SOURCE_SELECTION_INVALID");
      const index=state.bindings.findIndex(binding=>binding.taskScope===taskScope&&binding.accountId===accountId);
      if(!sourceIds.length){if(index>=0)state.bindings.splice(index,1);return;}
      const binding={taskScope,accountId,identityEpoch,sourceIds,updatedAt:new Date().toISOString()};
      if(index>=0)state.bindings[index]=binding;else{if(state.bindings.length>=1024)knowledgeError("SOURCE_BINDING_FULL");state.bindings.push(binding);}
    });
  }
  check(sourceId:string){
    const source=this.snapshot().sources.find(source=>source.sourceId===sourceId);if(!source)knowledgeError("SOURCE_NOT_FOUND");
    if(!isCode(source))return;
    try{verifyKnowledgeCode(source);this.observations.set(sourceId,{revision:source.revision,state:"current",checkedAt:new Date().toISOString()});}
    catch(error){this.observations.set(sourceId,{revision:source.revision,state:["SOURCE_STALE","SOURCE_COMMIT_CHANGED","SOURCE_FILE_MISSING"].includes(code(error))?"stale":"unavailable",reasonCode:code(error),checkedAt:new Date().toISOString()});}
  }
  remove(sourceId:string,expectedRevision:number){
    this.mutate(expectedRevision,state=>{
      const index=state.sources.findIndex(source=>source.sourceId===sourceId);if(index<0)knowledgeError("SOURCE_NOT_FOUND");
      if(state.bindings.some(binding=>binding.sourceIds.includes(sourceId)))knowledgeError("SOURCE_STILL_BOUND");
      state.sources.splice(index,1);
    });this.observations.delete(sourceId);
  }
  status(ownerId:string,experimentalEnabled:boolean,canMutate:boolean,lastTaskScope?:string):KnowledgeSnapshot {
    const state=this.snapshot(),now=Date.now();
    return {service:"gemini-native-knowledge",version:1,ownerId,revision:state.revision,experimentalEnabled,canMutate,lastTaskScope,bindings:state.bindings,sources:state.sources.map(source=>{
      const observation=this.observations.get(source.sourceId),age=observation?now-Date.parse(observation.checkedAt):Infinity;
      const fresh=observation?.revision===source.revision&&age>=0&&age<30000;
      return {sourceId:source.sourceId,kind:source.kind,label:source.label,revision:source.revision,digest:isCode(source)?source.digest:undefined,commit:isCode(source)?source.git?.commit:undefined,url:isCode(source)?undefined:source.url,instructionVersion:isCode(source)?undefined:source.instructionVersion,selectedFiles:isCode(source)?source.files.map(file=>file.path):undefined,fileCount:isCode(source)?source.files.length:0,bytes:isCode(source)?source.files.reduce((sum,file)=>sum+file.bytes,0):0,state:isCode(source)?fresh?observation!.state:"not_checked":"not_verified",reasonCode:isCode(source)?fresh?observation!.reasonCode:undefined:"SOURCE_ADAPTER_NOT_LIVE_VERIFIED",checkedAt:fresh?observation!.checkedAt:undefined};
    })};
  }
  resolve(taskScope:string|undefined,accountId:string,identityEpoch:number):KnowledgeResolution {
    let state:KnowledgeRegistry;try{state=this.snapshot();}catch(error){return {used:false,issues:[code(error)],assertCurrent:()=>{}};}
    const empty:KnowledgeResolution={used:false,issues:[],assertCurrent:()=>{}};
    if(!taskScope)return empty;
    const binding=state.bindings.find(item=>item.taskScope===taskScope&&item.accountId===accountId);
    if(!binding)return state.bindings.some(item=>item.taskScope===taskScope)?{...empty,issues:["SOURCE_ACCOUNT_NOT_BOUND"]}:empty;
    if(binding.identityEpoch!==identityEpoch)return {...empty,issues:["SOURCE_ACCOUNT_EPOCH_CHANGED"]};
    const issues:string[]=[],sources:unknown[]=[],used:KnowledgeCodeSource[]=[];
    for(const id of binding.sourceIds){
      const source=state.sources.find(item=>item.sourceId===id)!;
      if(!isCode(source)){issues.push("SOURCE_ADAPTER_NOT_LIVE_VERIFIED");continue;}
      if(source.files.reduce((sum,file)=>sum+file.bytes,0)>MAX_KNOWLEDGE_WIRE_CHARS){issues.push("SOURCE_BUDGET_EXCEEDED");continue;}
      try{
        const files=verifyKnowledgeCode(source,true);sources.push({sourceId:source.sourceId,label:source.label,revision:source.revision,digest:source.digest,git:source.git,files});used.push(source);this.observations.set(id,{revision:source.revision,state:"current",checkedAt:new Date().toISOString()});
      }catch(error){const reason=code(error);issues.push(reason);this.observations.set(id,{revision:source.revision,state:["SOURCE_STALE","SOURCE_COMMIT_CHANGED","SOURCE_FILE_MISSING"].includes(reason)?"stale":"unavailable",reasonCode:reason,checkedAt:new Date().toISOString()});}
    }
    const wire={version:1,referenceOnly:true,sourcePolicy:"native_knowledge_reference_v1",sources,issues:[...new Set(issues)]};
    if(canonical(wire).length>MAX_KNOWLEDGE_WIRE_CHARS)return {used:false,issues:["SOURCE_BUDGET_EXCEEDED"],assertCurrent:()=>{}};
    const captured=sha256(canonical(state));
    return {wire,used:sources.length>0,issues:[...new Set(issues)],assertCurrent:()=>{
      if(!used.length)return;
      if(sha256(canonical(this.snapshot()))!==captured)knowledgeError("SOURCE_CONFIG_CHANGED");
      for(const source of used)verifyKnowledgeCode(source);
    }};
  }
}
