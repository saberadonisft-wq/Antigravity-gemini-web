import { NativeManagementSnapshotSchema,type NativeManagementSnapshot,type AccountRegistryFile } from "@antigravity-gemini-web/contracts";
import type { NativeAccountRouter } from "./account-router.js";
import { canonical,sha256,type JsonObject } from "./native-protocol.js";

type Phase=NativeManagementSnapshot["activeTurns"][number]["phase"];
export function managementPhase(detail:JsonObject|undefined):Phase {
  if(detail?.phase==="completed"||detail?.phase==="failed")return detail.phase;
  if(detail?.phase==="context_delivery")return "loading_context";
  if(detail?.phase==="attachment_processing"||detail?.phase==="processing_file")return "processing_file";
  if(detail?.phase==="preparing"||detail?.phase==="checkpoint")return detail.reused?"restoring":"loading_context";
  if(detail?.phase==="generating"||detail?.phase==="streaming")return "generating";
  return "waiting";
}
export function buildManagementSnapshot(input:{
  ownerId:string;runtimeRevision:number;registry:AccountRegistryFile;router:ReturnType<NativeAccountRouter["snapshot"]>;
  canMutate:boolean;accountControlActive:boolean;resumeArmed:boolean;
  verified:ReadonlyMap<string,{epoch:number;observedAt:string}>;
  failures:ReadonlyMap<string,{epoch:number;code:string}>;
  turns:ReadonlyMap<string,{diagnostic?:JsonObject;settled:boolean;controller:AbortController}>;lastTurn:JsonObject|undefined;
}):NativeManagementSnapshot {
  const now=Date.now(),routing=input.router;
  const code=(value:unknown)=>typeof value==="string"&&/^[A-Z0-9_]{1,80}$/.test(value)?value:undefined;
  const last=input.lastTurn;
  const duration=(value:unknown)=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0?value:undefined;
  const snapshot={
    service:"gemini-native-management",version:1,ownerId:input.ownerId,pid:process.pid,runtimeRevision:input.runtimeRevision,observedAt:new Date(now).toISOString(),revision:input.registry.revision,
    selectedAccountId:input.registry.activeAccountId||undefined,canMutate:input.canMutate,accountControlActive:input.accountControlActive,resumeArmed:input.resumeArmed,
    routing:{mode:routing.settings.mode,revision:routing.revision,automaticEnabled:routing.automaticRoutingEnabled,experimentalEnabled:routing.experimentalEnabled,failoverEnabled:routing.failoverEnabled,modelSelection:routing.settings.modelSelection,bindingsCount:routing.bindings.length,bindings:routing.bindings.slice(0,128).map(({taskScope,accountId,identityEpoch})=>({taskScope,accountId,identityEpoch}))},
    accounts:input.registry.accounts.map(account=>{
      const verified=input.verified.get(account.accountId),age=verified?now-Date.parse(verified.observedAt):Infinity;
      const identityVerified=verified?.epoch===account.identityEpoch&&age>=0&&age<30000;
      const failure=input.failures.get(account.accountId),observed=routing.observations.find(row=>row.accountId===account.accountId&&row.identityEpoch===account.identityEpoch&&(!row.modelKey||routing.settings.modelSelection&&row.modelKey===sha256(canonical(routing.settings.modelSelection))));
      const reasonCode=code(failure?.epoch===account.identityEpoch?failure.code:observed?.code);
      const busy=routing.activeLeases.some(row=>row.accountId===account.accountId);
      let state:NativeManagementSnapshot["accounts"][number]["state"]=identityVerified?"checked":"unverified";
      if(reasonCode)state=reasonCode==="BROWSER_USER_ACTION_REQUIRED"?"verification_required":reasonCode==="BROWSER_LOGIN_REQUIRED"?"login_required":reasonCode==="ACCOUNT_IDENTITY_CHANGED"?"identity_mismatch":observed?"cooldown":"unavailable";
      if(busy)state="busy";if(!account.enabled)state="disabled";
      return {accountId:account.accountId,displayName:account.displayName,browserTransport:account.browserTransport,enabled:account.enabled,selected:account.accountId===input.registry.activeAccountId,identityRegistered:!!account.identityFingerprint,identityVerified,identityEpoch:account.identityEpoch,lastVerifiedAt:verified?.epoch===account.identityEpoch?verified.observedAt:undefined,state,reasonCode,
        capabilities:Object.entries(account.capabilities).filter(([name])=>name.length>0&&name.length<=80).slice(0,32).map(([name,value])=>({name,status:value.status,observedAt:value.observedAt&&Number.isFinite(Date.parse(value.observedAt))?new Date(value.observedAt).toISOString():undefined}))};
    }),
    activeTurns:routing.activeLeases.map(lease=>{
      const turn=input.turns.get(lease.requestId);
      return {requestId:lease.requestId,accountId:lease.accountId,taskScope:lease.taskScope,phase:turn?.settled||turn?.controller.signal.aborted?"stopping":managementPhase(turn?.diagnostic)};
    }),
    lastOutcome:last&&typeof last.requestId==="string"&&/^native_[a-f0-9]{64}$/.test(last.requestId)?{requestId:last.requestId,accountId:typeof last.accountId==="string"?last.accountId:undefined,phase:managementPhase(last),code:code(last.code),delivery:last.delivery==="not_sent"||last.delivery==="unknown"?last.delivery:undefined,browserStopConfirmed:typeof last.browserStopConfirmed==="boolean"?last.browserStopConfirmed:undefined,elapsedMs:duration(last.elapsedMs),firstTextMs:last.firstTextMs===null?null:duration(last.firstTextMs),transportMessages:typeof last.transportMessages==="number"&&last.transportMessages>=1&&last.transportMessages<=11?last.transportMessages:undefined,attemptCount:Array.isArray(last.attempts)&&last.attempts.length?last.attempts.length:undefined}:undefined,
    latestIssue:last&&code(last.code)?{code:code(last.code)!,phase:typeof last.phase==="string"?last.phase.slice(0,80):undefined,expectedModel:typeof last.expectedModel==="string"?last.expectedModel.slice(0,128):undefined,receivedModelSelectors:last.receivedModelSelectors&&typeof last.receivedModelSelectors==="object"&&!Array.isArray(last.receivedModelSelectors)?Object.fromEntries(Object.entries(last.receivedModelSelectors).filter(([key,value])=>["model","modelId","model_id"].includes(key)&&typeof value==="string").slice(0,3).map(([key,value])=>[key,(value as string).slice(0,128)])):undefined}:undefined,
  };
  return NativeManagementSnapshotSchema.parse(snapshot);
}
