import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NativeRoutingFileSchema,NativeRoutingSettingsSchema,type NativeRoutingFile,type NativeRoutingSettings,type AccountRecord } from "@antigravity-gemini-web/contracts";
import type { AccountRegistry } from "./account-registry.js";
import { atomicPrivateFile,assertNoLinks } from "./installation.js";
import { NativeRouteError,canonical,sha256 } from "./native-protocol.js";

export interface NativeAccountLease {
  readonly leaseId:string;readonly account:AccountRecord;readonly taskScope?:string;
  readonly requestId:string;readonly mode:NativeRoutingSettings["mode"];readonly modelSelection?:{model:string;effort?:string};
  readonly settingsKey:string;readonly attemptedAccountIds:readonly string[];readonly failoverPolicy?:NativeRoutingSettings["failover"];
}
type Observation={identityEpoch:number;modelKey?:string;code:string;until:number};
const defaults=():NativeRoutingFile=>({version:1,revision:0,settings:NativeRoutingSettingsSchema.parse({}),cursor:0,bindings:[]});

/** One native owner coordinates leases; MCP still enforces browser ownership at Send. */
export class NativeAccountRouter {
  private leases=new Map<string,NativeAccountLease>();
  private accounts=new Map<string,string>();
  private tasks=new Map<string,string>();
  private observations=new Map<string,Observation>();
  private pendingCommits=new Map<string,{revision:number;mode:"sticky"|"round_robin";nextCursor:number;replaceBinding?:{accountId:string;identityEpoch:number}}>();
  constructor(private readonly registry:AccountRegistry,private readonly filename:string,private readonly experimental=false){this.load();}
  get activeCount(){return this.leases.size;}
  private load():NativeRoutingFile {
    assertNoLinks(this.filename);
    if(!fs.existsSync(this.filename))return defaults();
    try{
      const state=NativeRoutingFileSchema.parse(JSON.parse(fs.readFileSync(this.filename,"utf8")));
      if(new Set(state.bindings.map(binding=>binding.taskScope)).size!==state.bindings.length)throw Error("duplicate binding");
      return state;
    }catch{throw new NativeRouteError("INVALID_ROUTING_STATE","Routing state is invalid; no account was selected.",503);}
  }
  private mutate<T>(expected:number|undefined,action:(state:NativeRoutingFile)=>T):T {
    assertNoLinks(this.filename);fs.mkdirSync(path.dirname(this.filename),{recursive:true});
    const lock=this.filename+".lock";assertNoLinks(lock);let fd:number;
    try{fd=fs.openSync(lock,"wx",0o600);}catch{throw new NativeRouteError("ROUTER_STATE_BUSY","Routing state has another writer; no account selection was committed.",409);}
    try{
      fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token:randomUUID()})+"\n");fs.fsyncSync(fd);
      const state=this.load();if(expected!==undefined&&state.revision!==expected)throw new NativeRouteError("STALE_ROUTING_REVISION","Routing configuration changed; refresh its revision.",409);
      const result=action(state);state.revision++;NativeRoutingFileSchema.parse(state);atomicPrivateFile(this.filename,JSON.stringify(state)+"\n");return result;
    }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
  }
  snapshot(){
    const state=this.load();
    return {...state,experimentalEnabled:this.experimental,automaticRoutingEnabled:this.experimental&&state.settings.mode!=="manual",failoverEnabled:this.experimental&&state.settings.mode!=="manual"&&state.settings.failover?.enabled===true,
      activeLeases:[...this.leases.values()].map(lease=>({leaseId:lease.leaseId,requestId:lease.requestId,taskScope:lease.taskScope,accountId:lease.account.accountId,identityEpoch:lease.account.identityEpoch})),
      observations:[...this.observations.entries()].filter(([,value])=>value.until>Date.now()).map(([accountId,value])=>({accountId,...value}))};
  }
  configure(settings:NativeRoutingSettings,expectedRevision:number){
    if(this.leases.size)throw new NativeRouteError("BUSY","Configure routing after active turns settle.",409);
    const parsed=NativeRoutingSettingsSchema.safeParse(settings);if(!parsed.success)throw new NativeRouteError("INVALID_ROUTING_SETTINGS","Routing mode, model policy or round-robin opt-in is invalid.");
    if(parsed.data.mode!=="manual"&&!this.experimental)throw new NativeRouteError("ROUTING_EXPERIMENT_DISABLED","Restart with AG_NATIVE_ROUTER_EXPERIMENTAL=1 before configuring automatic routing.",412);
    for(const id of parsed.data.priority)if(!this.registry.get(id))throw new NativeRouteError("ACCOUNT_NOT_FOUND","A routing priority account is unavailable.",404);
    this.mutate(expectedRevision,state=>{state.settings=parsed.data;state.cursor=0;});return this.snapshot();
  }
  unbind(taskScope:string,expectedRevision:number){
    if(this.leases.size)throw new NativeRouteError("BUSY","Unbind routing after active turns settle.",409);
    if(!/^[a-f0-9]{64}$/.test(taskScope))throw new NativeRouteError("INVALID_ARGUMENT","Invalid IDE task scope.");
    this.mutate(expectedRevision,state=>{state.bindings=state.bindings.filter(binding=>binding.taskScope!==taskScope);});return this.snapshot();
  }
  private eligibility(account:AccountRecord|undefined,selection:NativeRoutingSettings["modelSelection"],ignoreObservation=false):string|undefined {
    if(!account)return "ACCOUNT_NOT_FOUND";
    if(!account.enabled)return "ACCOUNT_DISABLED";
    if(!/^[a-f0-9]{64}$/.test(account.identityFingerprint??""))return "ACCOUNT_IDENTITY_UNVERIFIED";
    if(this.accounts.has(account.accountId))return "BUSY";
    const observation=this.observations.get(account.accountId),modelKey=selection?sha256(canonical(selection)):undefined;
    if(!ignoreObservation&&observation&&observation.identityEpoch===account.identityEpoch&&observation.until>Date.now()&&(!observation.modelKey||observation.modelKey===modelKey))return observation.code;
    return undefined;
  }
  acquire(requestId:string,taskScope?:string,explicitAccountId?:string):NativeAccountLease {
    if(!/^native_[a-f0-9]{64}$/.test(requestId)||(taskScope!==undefined&&!/^[a-f0-9]{64}$/.test(taskScope)))throw new NativeRouteError("INVALID_ARGUMENT","Invalid logical request or IDE task identity.");
    if(taskScope&&this.tasks.has(taskScope))throw new NativeRouteError("BUSY","This IDE chat already has an active turn; it cannot switch workers concurrently.",409);
    const state=this.load(),settings=state.settings;
    if(settings.mode!=="manual"&&!this.experimental)throw new NativeRouteError("ROUTING_EXPERIMENT_DISABLED","Automatic routing is configured but its experimental runtime flag is off.",412);
    if(settings.mode==="sticky"&&!taskScope)throw new NativeRouteError("TASK_SCOPE_REQUIRED","Sticky routing requires a stable IDE chat identity.",409);
    const all=this.registry.list(),active=this.registry.getActive(),binding=taskScope&&settings.mode==="sticky"?state.bindings.find(row=>row.taskScope===taskScope):undefined;
    if(binding&&explicitAccountId&&binding.accountId!==explicitAccountId)throw new NativeRouteError("RESUME_ACCOUNT_MISMATCH","The explicit resume account differs from this sticky binding.",409);
    let selected:AccountRecord|undefined;
    if(explicitAccountId||settings.mode==="manual"||binding){
      selected=explicitAccountId?this.registry.get(explicitAccountId):binding?this.registry.get(binding.accountId):active;
      if(binding&&selected?.identityEpoch!==binding.identityEpoch)throw new NativeRouteError("STALE_AUTHORITY","The sticky account identity epoch changed; rebind explicitly.",409);
      const code=this.eligibility(selected,settings.modelSelection,settings.mode==="manual");
      if(code){
        if(!explicitAccountId&&settings.mode==="sticky"&&settings.failover?.enabled)selected=undefined;
        else throw new NativeRouteError(code,"The pinned account is unavailable; no automatic account switch occurred.",code==="BUSY"?409:412);
      }
    }else{
      const ids=[...new Set([...settings.priority,...(settings.mode==="round_robin"?[]:active?[active.accountId]:[]),...all.map(account=>account.accountId)])];
      const rotated=settings.mode==="round_robin"?[...ids.slice(state.cursor%ids.length),...ids.slice(0,state.cursor%ids.length)]:ids;
      selected=rotated.map(id=>all.find(account=>account.accountId===id)).find(account=>!this.eligibility(account,settings.modelSelection));
      if(!selected)throw new NativeRouteError("NO_ELIGIBLE_ACCOUNT","No registered, enabled and idle account is eligible for the fixed model policy.",503);
    }
    if(!selected&&settings.mode==="sticky"&&settings.failover?.enabled&&!explicitAccountId){
      const ids=[...new Set([...settings.priority,...all.map(account=>account.accountId)])];
      selected=ids.map(id=>all.find(account=>account.accountId===id)).find(account=>account?.accountId!==binding?.accountId&&!this.eligibility(account,settings.modelSelection));
    }
    if(!selected)throw new NativeRouteError("NO_ELIGIBLE_ACCOUNT","No enabled account is eligible for this routing policy.",412);
    const chosen=selected;
    const lease:NativeAccountLease=Object.freeze({leaseId:randomUUID(),account:Object.freeze(structuredClone(chosen)),requestId,taskScope,mode:settings.mode,settingsKey:canonical(settings),attemptedAccountIds:Object.freeze([chosen.accountId]),failoverPolicy:!explicitAccountId&&settings.mode!=="manual"&&settings.failover?.enabled?Object.freeze({...settings.failover}):undefined,modelSelection:settings.modelSelection?Object.freeze(structuredClone(settings.modelSelection)):undefined});
    this.leases.set(lease.leaseId,lease);this.accounts.set(chosen.accountId,lease.leaseId);if(taskScope)this.tasks.set(taskScope,lease.leaseId);
    if((settings.mode==="sticky"&&(!binding||binding.accountId!==chosen.accountId))||settings.mode==="round_robin"){
      const ids=[...new Set([...settings.priority,...(settings.mode==="round_robin"?[]:active?[active.accountId]:[]),...all.map(account=>account.accountId)])];
      this.pendingCommits.set(lease.leaseId,{revision:state.revision,mode:settings.mode as "sticky"|"round_robin",nextCursor:(ids.indexOf(chosen.accountId)+1)%ids.length,...(binding?{replaceBinding:{accountId:binding.accountId,identityEpoch:binding.identityEpoch}}:{})});
    }
    return lease;
  }
  /** Synchronous lease transfer keeps the task locked while the settled account changes. */
  next(lease:NativeAccountLease):NativeAccountLease|undefined {
    if(this.leases.get(lease.leaseId)!==lease)throw new NativeRouteError("STALE_AUTHORITY","Routing lease is no longer active.",409);
    if(!lease.failoverPolicy?.enabled||lease.attemptedAccountIds.length>=lease.failoverPolicy.maxAttempts)return;
    const state=this.load(),settings=state.settings;
    if(canonical(settings)!==lease.settingsKey)throw new NativeRouteError("STALE_ROUTING_REVISION","Routing policy changed during a logical request.",409);
    const all=this.registry.list(),active=this.registry.getActive();
    const ids=[...new Set([...settings.priority,...(settings.mode==="round_robin"?[]:active?[active.accountId]:[]),...all.map(account=>account.accountId)])];
    const rotated=settings.mode==="round_robin"?[...ids.slice(state.cursor%ids.length),...ids.slice(0,state.cursor%ids.length)]:ids;
    const chosen=rotated.map(id=>all.find(account=>account.accountId===id)).find(account=>account&&!lease.attemptedAccountIds.includes(account.accountId)&&!this.eligibility(account,settings.modelSelection));
    if(!chosen)return;
    const next:NativeAccountLease=Object.freeze({...lease,leaseId:randomUUID(),account:Object.freeze(structuredClone(chosen)),attemptedAccountIds:Object.freeze([...lease.attemptedAccountIds,chosen.accountId])});
    this.leases.set(next.leaseId,next);this.accounts.set(chosen.accountId,next.leaseId);if(next.taskScope)this.tasks.set(next.taskScope,next.leaseId);
    if(next.mode==="sticky"||next.mode==="round_robin")this.pendingCommits.set(next.leaseId,{revision:state.revision,mode:next.mode,nextCursor:(ids.indexOf(chosen.accountId)+1)%ids.length,...(next.mode==="sticky"?{replaceBinding:{accountId:lease.account.accountId,identityEpoch:lease.account.identityEpoch}}:{})});
    this.release(lease);return next;
  }
  /** Commit only after source context and the logical request have been reserved. */
  commit(lease:NativeAccountLease){
    if(this.leases.get(lease.leaseId)!==lease)throw new NativeRouteError("STALE_AUTHORITY","Routing lease is no longer active.",409);
    const pending=this.pendingCommits.get(lease.leaseId);if(!pending)return;
    this.mutate(pending.revision,state=>{
      if(pending.mode==="sticky"){
        const binding={taskScope:lease.taskScope!,accountId:lease.account.accountId,identityEpoch:lease.account.identityEpoch,updatedAt:new Date().toISOString()};
        if(pending.replaceBinding){
          const index=state.bindings.findIndex(row=>row.taskScope===lease.taskScope);
          if(index<0||state.bindings[index].accountId!==pending.replaceBinding.accountId||state.bindings[index].identityEpoch!==pending.replaceBinding.identityEpoch)throw new NativeRouteError("STALE_AUTHORITY","Sticky binding changed before account handoff.",409);
          state.bindings[index]=binding;
        }else{
          if(state.bindings.length>=4096)throw new NativeRouteError("ROUTER_BINDING_FULL","Sticky binding capacity reached; no binding was evicted.",503);
          state.bindings.push(binding);
        }
      }else state.cursor=pending.nextCursor;
    });
    this.pendingCommits.delete(lease.leaseId);
  }
  observeNotSent(lease:NativeAccountLease,error:unknown,observedModel=lease.modelSelection){
    if(this.leases.get(lease.leaseId)!==lease||!(error instanceof NativeRouteError)||error.delivery!=="not_sent")return;
    const duration=error.code==="BUSY"?1000:error.code==="MODEL_UNAVAILABLE"?300000:["ACCOUNT_IDENTITY_CHANGED","ACCOUNT_IDENTITY_UNVERIFIED","BROWSER_LOGIN_REQUIRED"].includes(error.code)?30000:0;
    if(!duration)return;
    this.observations.set(lease.account.accountId,{identityEpoch:lease.account.identityEpoch,code:error.code,until:Date.now()+duration,...(error.code==="MODEL_UNAVAILABLE"&&observedModel?{modelKey:sha256(canonical(observedModel))}:{})});
  }
  identityVerified(accountId:string){const observation=this.observations.get(accountId);if(observation&&observation.code!=="MODEL_UNAVAILABLE")this.observations.delete(accountId);}
  release(lease:NativeAccountLease){
    if(this.leases.get(lease.leaseId)!==lease)return false;
    this.leases.delete(lease.leaseId);
    this.pendingCommits.delete(lease.leaseId);
    if(this.accounts.get(lease.account.accountId)===lease.leaseId)this.accounts.delete(lease.account.accountId);
    if(lease.taskScope&&this.tasks.get(lease.taskScope)===lease.leaseId)this.tasks.delete(lease.taskScope);
    return true;
  }
}
