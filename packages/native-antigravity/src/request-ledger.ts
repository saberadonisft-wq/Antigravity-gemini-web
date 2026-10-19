import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { NativeRouteError } from "./native-protocol.js";
import { atomicPrivateFile, assertNoLinks } from "./installation.js";
import { NativeNotSentProofSchema, permitsAccountFailover, type NativeNotSentProof } from "./failover-policy.js";

const fields={
  requestId:z.string().regex(/^native_[a-f0-9]{64}$/),attemptId:z.string().uuid(),accountId:z.string(),identityEpoch:z.number().int().nonnegative(),
  taskScope:z.string().optional(),createdAt:z.string().datetime(),updatedAt:z.string().datetime(),
  physicalRequests:z.array(z.string().regex(/^[a-zA-Z0-9_-]{8,96}$/)).max(11).optional(),
};
const LegacyRecordSchema=z.object({version:z.literal(1),...fields,state:z.enum(["reserved","submitted","completed"])}).strict();
const PreviousAttemptSchema=z.object({
  attemptId:fields.attemptId,accountId:fields.accountId,identityEpoch:fields.identityEpoch,createdAt:fields.createdAt,updatedAt:fields.updatedAt,
  physicalRequests:fields.physicalRequests,state:z.literal("not_sent"),notSentProof:NativeNotSentProofSchema,
}).strict();
const RetryRecordSchema=z.object({
  version:z.literal(2),...fields,ownerId:z.string().uuid(),state:z.enum(["reserved","submitted","completed","not_sent","unknown"]),terminal:z.boolean(),
  requestCreatedAt:fields.createdAt,maxAttempts:z.number().int().min(2).max(4),deadlineAt:z.string().datetime(),previousAttempts:z.array(PreviousAttemptSchema).max(3),notSentProof:NativeNotSentProofSchema.optional(),
}).strict().superRefine((record,context)=>{
  const attempts=[...record.previousAttempts,record];
  if(attempts.length>record.maxAttempts||new Set(attempts.map(a=>a.attemptId)).size!==attempts.length||new Set(attempts.map(a=>a.accountId)).size!==attempts.length)context.addIssue({code:z.ZodIssueCode.custom,message:"Invalid attempt chain."});
  if((record.state==="not_sent")!==!!record.notSentProof)context.addIssue({code:z.ZodIssueCode.custom,message:"Invalid no-Send proof."});
  if(["completed","unknown"].includes(record.state)&&!record.terminal||["reserved","submitted"].includes(record.state)&&record.terminal)context.addIssue({code:z.ZodIssueCode.custom,message:"Invalid terminal state."});
  if(record.previousAttempts.some(a=>!permitsAccountFailover(a.notSentProof)||(a.physicalRequests?.length??0)>1))context.addIssue({code:z.ZodIssueCode.custom,message:"A prior attempt did not authorize account failover."});
});
const RecordSchema=z.union([LegacyRecordSchema,RetryRecordSchema]);
export type NativeRequestReservation=z.infer<typeof RecordSchema>;
export type NativeLedgerAttempt=z.infer<typeof PreviousAttemptSchema>|NativeRequestReservation;
export interface NativeFailoverReservationPolicy {maxAttempts:number;deadlineAt:string}

/** Hash-indexed metadata, with immutable prior attempts and no prompt/results. */
export class NativeRequestLedger {
  private readonly ownerId=randomUUID();
  constructor(private readonly directory:string){assertNoLinks(directory);}
  private filename(requestId:string){
    if(!/^native_[a-f0-9]{64}$/.test(requestId))throw new NativeRouteError("INVALID_REQUEST_ID","Invalid logical request identity.");
    const filename=path.join(this.directory,requestId.slice(7,9),requestId+".json");assertNoLinks(filename);return filename;
  }
  private read(filename:string):NativeRequestReservation {
    try{return RecordSchema.parse(JSON.parse(fs.readFileSync(filename,"utf8")));}
    catch{throw new NativeRouteError("REQUEST_LEDGER_UNAVAILABLE","Logical turn metadata is missing or invalid; its fence was retained.",503);}
  }
  reserve(requestId:string,accountId:string,identityEpoch:number,taskScope?:string,policy?:NativeFailoverReservationPolicy):NativeRequestReservation {
    const filename=this.filename(requestId),now=new Date().toISOString();
    const common={requestId,attemptId:randomUUID(),accountId,identityEpoch,taskScope,state:"reserved" as const,createdAt:now,updatedAt:now};
    const record=RecordSchema.parse(policy?{...common,version:2,ownerId:this.ownerId,terminal:false,requestCreatedAt:now,maxAttempts:policy.maxAttempts,deadlineAt:policy.deadlineAt,previousAttempts:[]}:{...common,version:1});
    fs.mkdirSync(path.dirname(filename),{recursive:true});let fd:number;
    try{fd=fs.openSync(filename,"wx",0o600);}
    catch(error){
      if((error as NodeJS.ErrnoException).code==="EEXIST")throw new NativeRouteError("OUTCOME_UNKNOWN","This logical request is already fenced; switching accounts or restarting cannot replay it.",409);
      throw new NativeRouteError("REQUEST_LEDGER_UNAVAILABLE","The logical turn could not be reserved durably; no prompt was sent.",503);
    }
    try{fs.writeFileSync(fd,JSON.stringify(record)+"\n");fs.fsyncSync(fd);}
    catch{throw new NativeRouteError("REQUEST_LEDGER_UNAVAILABLE","Logical reservation could not be saved; its fence was retained.",503);}
    finally{fs.closeSync(fd);}return record;
  }
  private mutate<T>(record:NativeRequestReservation,action:(saved:NativeRequestReservation,filename:string)=>T):T {
    const filename=this.filename(record.requestId),lock=filename+".lock",token=randomUUID();assertNoLinks(lock);let fd:number;
    try{fd=fs.openSync(lock,"wx",0o600);}catch{throw new NativeRouteError("REQUEST_LEDGER_BUSY","Another logical turn writer or a retained crash lock blocks this update.",409);}
    let owned=false;
    try{
      fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token})+"\n");fs.fsyncSync(fd);owned=true;
      const saved=this.read(filename);
      if(saved.requestId!==record.requestId||saved.attemptId!==record.attemptId||saved.version===2&&(saved.ownerId!==this.ownerId||record.version!==2||record.ownerId!==saved.ownerId))throw new NativeRouteError("STALE_AUTHORITY","Logical attempt ownership changed; no additional Send is allowed.",409);
      return action(saved,filename);
    }finally{
      fs.closeSync(fd);
      if(owned){
        let same=false;try{same=JSON.parse(fs.readFileSync(lock,"utf8")).token===token;}catch{}
        if(!same)throw new NativeRouteError("REQUEST_LEDGER_UNAVAILABLE","Logical writer ownership changed; its lock was retained.",503);
        fs.unlinkSync(lock);
      }
    }
  }
  private save(filename:string,record:NativeRequestReservation){RecordSchema.parse(record);atomicPrivateFile(filename,JSON.stringify(record)+"\n");return record;}
  submitted(record:NativeRequestReservation){this.update(record,"submitted");}
  complete(record:NativeRequestReservation){this.update(record,"completed");}
  private update(record:NativeRequestReservation,state:"submitted"|"completed"){
    this.mutate(record,(saved,filename)=>{
      if(saved.state==="completed"||saved.version===2&&(saved.terminal||saved.state==="not_sent"))throw new NativeRouteError("STALE_AUTHORITY","Logical attempt is terminal or proven unsent.",409);
      this.save(filename,{...saved,state,updatedAt:new Date().toISOString(),...(saved.version===2?{terminal:state==="completed"}:{})});
    });
  }
  inspect(requestId:string):NativeRequestReservation|undefined {
    const filename=this.filename(requestId);
    try{const record=RecordSchema.parse(JSON.parse(fs.readFileSync(filename,"utf8")));if(record.requestId!==requestId)throw Error("Identity mismatch");return record;}
    catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw new NativeRouteError("REQUEST_LEDGER_UNAVAILABLE","Logical receipt identity or metadata is invalid; no replay is permitted.",503);}
  }
  attempts(record:NativeRequestReservation):NativeLedgerAttempt[]{return record.version===2?[...record.previousAttempts,record]:[record];}
  recordPhysical(record:NativeRequestReservation,requestId:string){
    if(!/^[a-zA-Z0-9_-]{8,96}$/.test(requestId))throw new NativeRouteError("INVALID_REQUEST_ID","Invalid physical request identity.");
    this.mutate(record,(saved,filename)=>{
      if(saved.state==="completed"||saved.version===2&&(saved.terminal||saved.state==="not_sent"))throw new NativeRouteError("STALE_AUTHORITY","A retired logical attempt cannot acquire a physical request.",409);
      const physical=saved.physicalRequests??[];if(physical.includes(requestId))return;
      if(physical.length>=11)throw new NativeRouteError("TRANSPORT_ATTEMPTS_EXHAUSTED","Physical request budget exceeded; no additional prompt was sent.",503);
      this.save(filename,{...saved,physicalRequests:[...physical,requestId],updatedAt:new Date().toISOString()});
    });
  }
  notSent(record:NativeRequestReservation,proof:NativeNotSentProof){
    const checked=NativeNotSentProofSchema.parse(proof);
    this.mutate(record,(saved,filename)=>{
      if(saved.version!==2||saved.terminal||saved.state==="not_sent")throw new NativeRouteError("STALE_AUTHORITY","The attempt cannot accept another no-Send observation.",409);
      this.save(filename,{...saved,state:"not_sent",notSentProof:checked,updatedAt:new Date().toISOString()});
    });
  }
  nextAttempt(record:NativeRequestReservation,accountId:string,identityEpoch:number):NativeRequestReservation {
    return this.mutate(record,(saved,filename)=>{
      if(saved.version!==2||saved.terminal||saved.state!=="not_sent"||!saved.notSentProof||!permitsAccountFailover(saved.notSentProof))throw new NativeRouteError("FAILOVER_NOT_ALLOWED","No trusted pre-Send failure authorizes another account.",409);
      if(saved.previousAttempts.length+1>=saved.maxAttempts)throw new NativeRouteError("FAILOVER_ATTEMPTS_EXHAUSTED","The persisted account attempt budget is exhausted.",409);
      if(Date.parse(saved.deadlineAt)<=Date.now())throw new NativeRouteError("FAILOVER_DEADLINE_EXCEEDED","The account failover deadline expired.",409);
      if(this.attempts(saved).some(a=>a.accountId===accountId))throw new NativeRouteError("FAILOVER_ACCOUNT_REPEATED","An account cannot be retried within one logical request.",409);
      if((saved.physicalRequests?.length??0)>1)throw new NativeRouteError("FAILOVER_NOT_ALLOWED","Multiple physical operations require explicit reconciliation; no account switch is permitted.",409);
      const previous=PreviousAttemptSchema.parse({attemptId:saved.attemptId,accountId:saved.accountId,identityEpoch:saved.identityEpoch,createdAt:saved.createdAt,updatedAt:saved.updatedAt,physicalRequests:saved.physicalRequests,state:saved.state,notSentProof:saved.notSentProof}),now=new Date().toISOString();
      return this.save(filename,{...saved,attemptId:randomUUID(),accountId,identityEpoch,state:"reserved",createdAt:now,updatedAt:now,physicalRequests:undefined,notSentProof:undefined,previousAttempts:[...saved.previousAttempts,previous]});
    });
  }
  unknown(record:NativeRequestReservation){
    if(record.version!==2)return;
    this.mutate(record,(saved,filename)=>{if(saved.version!==2||saved.terminal)throw new NativeRouteError("STALE_AUTHORITY","The logical request is already terminal.",409);this.save(filename,{...saved,state:"unknown",terminal:true,notSentProof:undefined,updatedAt:new Date().toISOString()});});
  }
  /** Legacy requests may be released; a failover request keeps its finite budget forever. */
  discardNotSent(record:NativeRequestReservation,proof?:NativeNotSentProof):boolean {
    return this.mutate(record,(saved,filename)=>{
      if(saved.state==="completed"||saved.version===2&&saved.terminal)throw new NativeRouteError("STALE_AUTHORITY","A terminal logical request cannot be released.",409);
      if(saved.version===1){fs.unlinkSync(filename);return true;}
      const checked=saved.notSentProof??(proof&&NativeNotSentProofSchema.parse(proof));
      if(!checked)throw new NativeRouteError("FAILOVER_PROOF_REQUIRED","No-Send evidence is required; the request fence was retained.",409);
      this.save(filename,{...saved,state:"not_sent",notSentProof:checked,terminal:true,updatedAt:new Date().toISOString()});return false;
    });
  }
}
