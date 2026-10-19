import fs from "node:fs";
import { PhysicalReceiptStore } from "./receipt-store.js";

const [ledger,stage,barrier,go]=process.argv.slice(2);
const pause=()=>{fs.writeFileSync(barrier,stage,{flag:"wx",mode:0o600});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
if(stage==="compete"){
  const store=new PhysicalReceiptStore(ledger);
  fs.writeFileSync(barrier,"ready",{flag:"wx",mode:0o600});
  while(!fs.existsSync(go))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
  try{store.reserve("competing_request_01","a".repeat(64));process.stdout.write("reserved");}
  catch(error){process.stdout.write(error&&typeof error==="object"&&"code" in error?String(error.code):"UNKNOWN_ERROR");}
  finally{store.close();}
}else if(stage.startsWith("migration_")){
  const rename=fs.renameSync;
  fs.renameSync=(from,to)=>{
    if(String(to)===ledger&&stage==="migration_before_marker")pause();
    rename(from,to);
    if(String(to)===ledger&&stage==="migration_after_marker")pause();
  };
  new PhysicalReceiptStore(ledger);
}else{
  const store=new PhysicalReceiptStore(ledger),receipt=store.reserve("crash_request_01","a".repeat(64));
  if(stage==="accepted"||stage==="terminal")store.transition(receipt,"accepted");
  if(stage==="terminal")store.transition(receipt,"terminal");
  pause();
}
