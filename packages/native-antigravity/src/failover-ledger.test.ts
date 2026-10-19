import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NativeRequestLedger } from "./request-ledger.js";
import { nativeNotSentProof, permitsAccountFailover, type NativeNotSentProof } from "./failover-policy.js";
import { NativeRouteError,sha256 } from "./native-protocol.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function fixture(t:test.TestContext){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"ag-failover-ledger-"));
  t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith("ag-failover-ledger-"));fs.rmSync(root,{recursive:true,force:true});});
  const ledger=new NativeRequestLedger(root),id="native_"+sha256(t.name);
  const policy={maxAttempts:3,deadlineAt:new Date(Date.now()+60000).toISOString()};
  return {root,ledger,id,policy};
}
const proof=(code="MODEL_UNAVAILABLE"):NativeNotSentProof=>({delivery:"not_sent",code,phase:"model_selection",observedAt:new Date().toISOString()});

test("Failover keeps all prior receipts, gives every account a new attempt, and rejects stale callbacks",t=>{
  const {root,ledger,id,policy}=fixture(t);const a=ledger.reserve(id,"acc_A",1,sha256("task"),policy);
  ledger.recordPhysical(a,"physical_account_A");ledger.submitted(a);ledger.notSent(a,proof());
  const b=ledger.nextAttempt(a,"acc_B",2);assert.notEqual(b.attemptId,a.attemptId);
  for(const stale of [()=>ledger.submitted(a),()=>ledger.complete(a),()=>ledger.recordPhysical(a,"late_account_A"),()=>ledger.discardNotSent(a)])assert.throws(stale,{code:"STALE_AUTHORITY"});
  ledger.recordPhysical(b,"physical_account_B");ledger.submitted(b);ledger.complete(b);
  const saved=new NativeRequestLedger(root).inspect(id)!;assert.equal(saved.version,2);assert.equal(saved.state,"completed");
  const attempts=ledger.attempts(saved);assert.deepEqual(attempts.map(v=>v.accountId),["acc_A","acc_B"]);assert.deepEqual(attempts.map(v=>v.physicalRequests),[["physical_account_A"],["physical_account_B"]]);
  assert.equal(saved.version===2&&saved.previousAttempts[0].notSentProof.code,"MODEL_UNAVAILABLE");
  assert.throws(()=>ledger.discardNotSent(b,proof()),{code:"STALE_AUTHORITY"});
  assert.ok(!JSON.stringify(saved).includes('"prompt"'));assert.ok(!JSON.stringify(saved).includes('"text"'));
});

test("The persisted attempt budget cannot reset after exhaustion, repeat an account, or resume in another owner",t=>{
  const {root,ledger,id,policy}=fixture(t);let record=ledger.reserve(id,"acc_A",1,undefined,{...policy,maxAttempts:2});
  ledger.notSent(record,proof("BUSY"));assert.throws(()=>ledger.nextAttempt(record,"acc_A",2),{code:"FAILOVER_ACCOUNT_REPEATED"});
  const restarted=new NativeRequestLedger(root),snapshot=restarted.inspect(id)!;
  assert.throws(()=>restarted.nextAttempt(snapshot,"acc_B",1),{code:"STALE_AUTHORITY"});
  record=ledger.nextAttempt(record,"acc_B",1);ledger.notSent(record,proof());
  assert.throws(()=>ledger.nextAttempt(record,"acc_C",1),{code:"FAILOVER_ATTEMPTS_EXHAUSTED"});
  assert.equal(ledger.discardNotSent(record),false);
  assert.throws(()=>new NativeRequestLedger(root).reserve(id,"acc_C",1,undefined,policy),{code:"OUTCOME_UNKNOWN"});
  assert.equal(ledger.inspect(id)?.version===2&&(ledger.inspect(id) as {terminal:boolean}).terminal,true);
});

test("Expired deadlines, multiple physical operations and non-eligible failures cannot authorize another account",t=>{
  const {ledger,id,policy}=fixture(t);
  const expired=ledger.reserve(id,"acc_A",1,undefined,{...policy,deadlineAt:new Date(Date.now()-1000).toISOString()});ledger.notSent(expired,proof());
  assert.throws(()=>ledger.nextAttempt(expired,"acc_B",1),{code:"FAILOVER_DEADLINE_EXCEEDED"});
  const multiple=ledger.reserve("native_"+sha256("multiple"),"acc_A",1,undefined,policy);
  ledger.recordPhysical(multiple,"physical_part_one");ledger.recordPhysical(multiple,"physical_part_two");ledger.notSent(multiple,proof());
  assert.throws(()=>ledger.nextAttempt(multiple,"acc_B",1),{code:"FAILOVER_NOT_ALLOWED"});
  for(const code of ["BROWSER_USER_ACTION_REQUIRED","CONTEXT_FRAGMENT_ACK_FAILED","TIMEOUT","CANCELLED","BROWSER_TURN_FAILED"]){
    const record=ledger.reserve("native_"+sha256(code),"acc_A",1,undefined,policy);ledger.notSent(record,proof(code));
    assert.throws(()=>ledger.nextAttempt(record,"acc_B",1),{code:"FAILOVER_NOT_ALLOWED"});
  }
});

test("An unknown outcome, interrupted write or retained writer lock always preserves the logical fence",t=>{
  const {root,ledger,id,policy}=fixture(t);const record=ledger.reserve(id,"acc_A",1,undefined,policy);ledger.submitted(record);ledger.unknown(record);
  assert.throws(()=>ledger.nextAttempt(record,"acc_B",1),{code:"FAILOVER_NOT_ALLOWED"});
  const key="native_"+sha256("locked"),locked=ledger.reserve(key,"acc_A",1,undefined,policy),file=path.join(root,key.slice(7,9),key+".json");
  fs.writeFileSync(file+".lock",JSON.stringify({pid:999999,token:"retained-crash-lock"}));
  assert.throws(()=>ledger.recordPhysical(locked,"never_submit_this"),{code:"REQUEST_LEDGER_BUSY"});
  assert.equal(fs.existsSync(file+".lock"),true);assert.throws(()=>new NativeRequestLedger(root).reserve(key,"acc_B",1),{code:"OUTCOME_UNKNOWN"});
  fs.writeFileSync(file,"{");assert.throws(()=>ledger.inspect(key),{code:"REQUEST_LEDGER_UNAVAILABLE"});
});

test("Model prose and arbitrary error objects never become trusted no-Send proof",()=>{
  assert.equal(nativeNotSentProof({code:"MODEL_UNAVAILABLE",delivery:"not_sent",phase:"model_selection"}),undefined);
  const error=new NativeRouteError("MODEL_UNAVAILABLE","local broker observation",412);error.phase="model_selection";error.delivery="not_sent";
  assert.equal(permitsAccountFailover(nativeNotSentProof(error)!),true);
  error.phase="response";assert.equal(nativeNotSentProof(error),undefined);error.phase="model_selection";error.delivery="unknown";assert.equal(nativeNotSentProof(error),undefined);
});

test("Real process kills at reservation, no-Send, handoff and writer-lock boundaries never resume an old request",{timeout:15000},async t=>{
  const {root}=fixture(t);
  for(const phase of ["reserved","not_sent","next_reserved","writer_locked"]){
    const state=path.join(root,phase),child=spawn(process.execPath,[fileURLToPath(new URL("./request-attempt-worker.fixture.js",import.meta.url)),state,phase],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
    t.after(()=>{if(child.exitCode===null)child.kill("SIGKILL");});
    const barrier=await new Promise<{id:string;attemptId:string}>((resolve,reject)=>{
      let data="";const timer=setTimeout(()=>reject(Error("Worker did not reach its durable crash boundary")),5000);
      child.once("error",error=>{clearTimeout(timer);reject(error);});
      child.stdout.on("data",chunk=>{data+=chunk.toString();if(data.includes("\n")){clearTimeout(timer);resolve(JSON.parse(data.split("\n")[0]));}});
      child.once("exit",()=>{if(!data.includes("\n")){clearTimeout(timer);reject(Error("Worker exited before its crash boundary"));}});
    });
    await new Promise<void>(resolve=>{child.once("exit",()=>resolve());child.kill("SIGKILL");});
    const recovered=new NativeRequestLedger(state),saved=recovered.inspect(barrier.id)!;assert.equal(saved.version,2);
    assert.throws(()=>recovered.reserve(barrier.id,"acc_C",1),{code:"OUTCOME_UNKNOWN"});
    assert.throws(()=>recovered.nextAttempt(saved,"acc_C",1),{code:phase==="writer_locked"?"REQUEST_LEDGER_BUSY":"STALE_AUTHORITY"});
    assert.equal(saved.accountId,phase==="next_reserved"?"acc_B":"acc_A");
    assert.equal(saved.version===2&&saved.previousAttempts.length,phase==="next_reserved"?1:0);
  }
});
