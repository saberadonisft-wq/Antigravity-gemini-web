import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { NativeManagementCommandSchema,NativeManagementSnapshotSchema,safeUiError,type NativeManagementClient,type NativeManagementCommand,type NativeManagementSnapshot } from "@antigravity-gemini-web/contracts";
import { KnowledgeUiCommandSchema,KnowledgeImportIntentSchema,KnowledgeSnapshotSchema,type KnowledgeUiCommand,type KnowledgeImportIntent } from "@antigravity-gemini-web/contracts";
import { ChatImportSnapshotSchema, ChatImportIntentSchema, ChatImportUiCommandSchema, type ChatImportIntent, type ChatImportUiCommand } from "@antigravity-gemini-web/contracts";

const defaultEndpoint="http://127.0.0.1:9236";
const defaultDescriptor=path.join(os.homedir(),".gemini","antigravity-gemini-web-live","app_data","native-route","proxy-owner.json");
function fail(code:string):never{throw safeUiError({code});}
function noLinks(filename:string){
  const absolute=path.resolve(filename);let current=path.parse(absolute).root;
  for(const part of absolute.slice(current.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())fail("OWNER_MISMATCH");
  }
}
async function boundedJson(response:Response,limit:number):Promise<unknown>{
  const reader=response.body?.getReader();if(!reader)fail("CONTRACT_MISMATCH");
  const chunks:Uint8Array[]=[];let length=0;
  try{for(;;){const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.byteLength;if(length>limit)fail("CONTRACT_MISMATCH");chunks.push(chunk.value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{fail("CONTRACT_MISMATCH");}
}
const publicCode=(code:unknown)=>typeof code!=="string"?"SERVICE_UNAVAILABLE":({IMPORT_EXPERIMENT_DISABLED:"UNSUPPORTED_OPERATION",SOURCE_CONFIG_CONFLICT:"CONFIG_CONFLICT",SOURCE_CONFIG_CHANGED:"CONFIG_CONFLICT",STALE_ACCOUNT_SELECTION:"CONFIG_CONFLICT",STALE_ROUTING_REVISION:"CONFIG_CONFLICT",BROWSER_LOGIN_REQUIRED:"LOGIN_REQUIRED",ACCOUNT_IDENTITY_UNVERIFIED:"LOGIN_REQUIRED",ACCOUNT_DISABLED:"CONFIG_CONFLICT",ACCOUNT_NOT_FOUND:"CONFIG_CONFLICT",ACCOUNT_RUNTIME_STALE:"NATIVE_RUNTIME_UPDATE_REQUIRED"} as Record<string,string>)[code]??code;

/** Main-process only. It never starts a worker, launches Chrome or exposes the owner token. */
export class NativeOwnerClient implements NativeManagementClient {
  constructor(private readonly descriptor=defaultDescriptor,private readonly endpoint=defaultEndpoint){
    const url=new URL(endpoint);
    if(url.protocol!=="http:"||url.hostname!=="127.0.0.1"||!url.port||url.username||url.password||url.search||url.hash||url.pathname!=="/")fail("OWNER_MISMATCH");
  }
  private async request<T>(resource:"manage"|"knowledge"|"imports",command:{action:string},parse:(value:unknown)=>T):Promise<T>{
    let owner:{pid:number;endpoint:string;controlToken:string};let bytes:string;
    try{
      noLinks(this.descriptor);if(fs.statSync(this.descriptor).size>16384)fail("OWNER_MISMATCH");
      bytes=fs.readFileSync(this.descriptor,"utf8");const parsed=JSON.parse(bytes);
      if(parsed.version!==1||!Number.isSafeInteger(parsed.pid)||parsed.pid<1||parsed.endpoint!==this.endpoint||typeof parsed.controlToken!=="string"||!/^[a-f0-9]{64}$/.test(parsed.controlToken))fail("OWNER_MISMATCH");
      owner=parsed;
    }catch(error){if(error&&typeof error==="object"&&"code" in error&&error.code==="OWNER_MISMATCH")throw error;fail("RUNTIME_DISCONNECTED");}
    let health:Response;
    try{health=await fetch(this.endpoint+"/__native/health",{signal:AbortSignal.timeout(2500),redirect:"error"});}catch{fail("RUNTIME_DISCONNECTED");}
    const status=await boundedJson(health,65536) as Record<string,unknown>;
    if(!health.ok||!status||typeof status!=="object"||status.service!=="gemini-native-proxy"||status.version!==1||status.pid!==owner.pid)fail("OWNER_MISMATCH");
    if(status.accountManagementSupported!==true)fail("NATIVE_RUNTIME_UPDATE_REQUIRED");
    if(resource==="knowledge"&&(typeof status.runtimeRevision!=="number"||status.runtimeRevision<35||typeof status.knowledgeExperimental!=="boolean"))fail("NATIVE_RUNTIME_UPDATE_REQUIRED");
    if(resource==="imports"&&(typeof status.runtimeRevision!=="number"||status.runtimeRevision<38||typeof status.importInspectionExperimental!=="boolean"))fail("NATIVE_RUNTIME_UPDATE_REQUIRED");
    try{noLinks(this.descriptor);if(fs.readFileSync(this.descriptor,"utf8")!==bytes)fail("OWNER_MISMATCH");}catch{fail("OWNER_MISMATCH");}
    let response:Response;
    try{response=await fetch(this.endpoint+"/__native/"+resource,{method:"POST",headers:{"content-type":"application/json","x-native-control-token":owner.controlToken},body:JSON.stringify(command),signal:AbortSignal.timeout(command.action==="verify"||command.action==="open"||resource==="knowledge"&&command.action!=="status"?30000:5000),redirect:"error"});}
    catch{fail("RUNTIME_DISCONNECTED");}
    const result=await boundedJson(response,resource==="knowledge"?12*1048576:262144);
    if(!response.ok){const code=result&&typeof result==="object"&&"error" in result&&(result.error as {code?:unknown})?.code;fail(publicCode(code));}
    let parsed:T;try{parsed=parse(result);}catch{fail("CONTRACT_MISMATCH");}
    if(resource==="manage"&&(parsed as NativeManagementSnapshot).pid!==owner.pid)fail("CONTRACT_MISMATCH");
    return parsed;
  }
  getNativeAccounts(){return this.request("manage",{action:"status"},value=>NativeManagementSnapshotSchema.parse(value));}
  getNativeChatImports(){return this.request("imports",{action:"status"},value=>ChatImportSnapshotSchema.parse(value));}
  executeNativeChatImport(raw:ChatImportUiCommand){return this.request("imports",ChatImportUiCommandSchema.parse(raw),value=>ChatImportSnapshotSchema.parse(value));}
  inspectSelectedChatArchive(raw:ChatImportIntent,file:string){
    const intent=ChatImportIntentSchema.parse(raw);if(!path.isAbsolute(file))fail("INVALID_ARGUMENT");
    const command={...intent,action:"inspect",file};return this.request("imports",command,value=>ChatImportSnapshotSchema.parse(value));
  }
  executeNativeAccount(command:NativeManagementCommand){return this.request("manage",NativeManagementCommandSchema.parse(command),value=>NativeManagementSnapshotSchema.parse(value));}
  getNativeKnowledge(){return this.request("knowledge",{action:"status"},value=>KnowledgeSnapshotSchema.parse(value));}
  executeNativeKnowledge(command:KnowledgeUiCommand){return this.request("knowledge",KnowledgeUiCommandSchema.parse(command),value=>KnowledgeSnapshotSchema.parse(value));}
  // Main-only: these paths come from an owned OS file dialog, never IPC arguments.
  importSelectedKnowledgeFiles(raw:KnowledgeImportIntent,files:string[]){
    const intent=KnowledgeImportIntentSchema.parse(raw);
    if(!files.length||files.length>128||files.some(file=>!path.isAbsolute(file)))fail("SOURCE_SELECTION_INVALID");
    let root=path.dirname(files[0]!);
    for(const file of files){
      for(;;){const relative=path.relative(root,file);if(relative&&relative!==".."&&!relative.startsWith(".."+path.sep)&&!path.isAbsolute(relative))break;const parent=path.dirname(root);if(parent===root)fail("SOURCE_SELECTION_INVALID");root=parent;}
    }
    const command={action:"import_code",expectedOwnerId:intent.expectedOwnerId,expectedRevision:intent.expectedRevision,source:{kind:"local_folder",label:intent.label,root,files:files.map(file=>path.relative(root,file).split(path.sep).join("/"))}};
    return this.request("knowledge",command,value=>KnowledgeSnapshotSchema.parse(value));
  }
}
