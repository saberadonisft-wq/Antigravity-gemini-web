import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NativeRequestLedger } from "./request-ledger.js";
import { sha256 } from "./native-protocol.js";

const root=process.argv[2],phase=process.argv[3],id="native_"+sha256("process-crash-attempt");
const ledger=new NativeRequestLedger(root),policy={maxAttempts:2,deadlineAt:new Date(Date.now()+60000).toISOString()};
let record=ledger.reserve(id,"acc_A",1,undefined,policy);
if(phase!=="reserved")ledger.notSent(record,{delivery:"not_sent",code:"MODEL_UNAVAILABLE",phase:"model_selection",observedAt:new Date().toISOString()});
if(phase==="next_reserved")record=ledger.nextAttempt(record,"acc_B",1);
if(phase==="writer_locked"){
  const fd=fs.openSync(path.join(root,id.slice(7,9),id+".json.lock"),"wx",0o600);
  fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token:randomUUID()})+"\n");fs.fsyncSync(fd);fs.closeSync(fd);
}
process.stdout.write(JSON.stringify({id,phase,attemptId:record.attemptId})+"\n");
setInterval(()=>{},1000);
