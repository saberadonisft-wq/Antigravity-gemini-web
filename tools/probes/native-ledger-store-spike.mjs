// Synthetic disk-store comparison and process-crash barriers; no browser actions.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here=fileURLToPath(import.meta.url);
const configure=file=>{const db=new DatabaseSync(file);db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, phase TEXT NOT NULL) STRICT;");return db;};
if(process.argv.includes("--worker")) {
  const db=configure(process.argv[process.argv.indexOf("--file")+1]), committed=process.argv.includes("--commit");
  db.exec("BEGIN IMMEDIATE");db.prepare("INSERT INTO receipts VALUES (?,?)").run("crash_request","reserved");
  if(committed)db.exec("COMMIT");
  process.send?.({barrier:committed?"after_commit":"before_commit"});
  setInterval(()=>{},1000);
} else {
  const directory=fs.mkdtempSync(path.join(process.cwd(),".tmp/p4-ledger-spike-")), count=512;
  const db=configure(path.join(directory,"candidate.sqlite")), insert=db.prepare("INSERT INTO receipts VALUES (?,?)"), update=db.prepare("UPDATE receipts SET phase=? WHERE id=?");
  let started=performance.now();
  for(let i=0;i<count;i++){const id="request_"+i;insert.run(id,"reserved");update.run("accepted",id);update.run("terminal",id);}
  const sqliteMs=Math.round(performance.now()-started);started=performance.now();
  const select=db.prepare("SELECT phase FROM receipts WHERE id=?");
  for(let i=0;i<count;i++)assert.equal(select.get("request_"+i).phase,"terminal");
  const sqliteLookupMs=Math.round(performance.now()-started), version=db.prepare("SELECT sqlite_version() AS version").get().version;db.close();
  const logs=path.join(directory,"indexed-logs");fs.mkdirSync(logs);started=performance.now();
  for(let i=0;i<count;i++){
    const id="request_"+i, file=path.join(logs,createHash("sha256").update(id).digest("hex")+".jsonl"), fd=fs.openSync(file,"wx",0o600);
    try {for(const phase of ["reserved","accepted","terminal"]){fs.writeSync(fd,JSON.stringify({id,phase})+"\n");fs.fsyncSync(fd);}}finally{fs.closeSync(fd);}
  }
  const appendLogMs=Math.round(performance.now()-started);started=performance.now();
  for(let i=0;i<count;i++){const file=path.join(logs,createHash("sha256").update("request_"+i).digest("hex")+".jsonl");assert.equal(JSON.parse(fs.readFileSync(file,"utf8").trim().split("\n").at(-1)).phase,"terminal");}
  const appendLogLookupMs=Math.round(performance.now()-started), crashes=[];
  for(const committed of [false,true]) {
    const file=path.join(directory,"crash-"+randomUUID()+".sqlite");
    const child=fork(here,["--worker","--file",file,...(committed?["--commit"]:[])],{windowsHide:true,stdio:["ignore","ignore","ignore","ipc"]});
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("Worker barrier timeout")),15000);child.once("error",reject);child.once("message",message=>{clearTimeout(timer);assert.equal(message.barrier,committed?"after_commit":"before_commit");resolve();});child.once("exit",()=>{clearTimeout(timer);reject(Error("Worker exited before barrier"));});});
    const exited=new Promise(resolve=>child.once("exit",resolve));assert.ok(child.kill("SIGKILL"));await exited;
    const reopened=configure(file);assert.equal(!!reopened.prepare("SELECT id FROM receipts WHERE id=?").get("crash_request"),committed);assert.equal(reopened.prepare("PRAGMA quick_check").get().quick_check,"ok");reopened.close();
    crashes.push({barrier:committed?"after_commit":"before_commit",recoveredReceipt:committed,integrity:"ok"});
  }
  const evidence={checkedAt:new Date().toISOString(),platform:process.platform,node:process.versions.node,sqliteVersion:version,syntheticOnly:true,browserRequests:0,count,sqlite:{mode:"WAL",synchronous:"FULL",threePhaseWriteMs:sqliteMs,lookupAllMs:sqliteLookupMs},indexedAppendLog:{fsyncPerPhase:true,threePhaseWriteMs:appendLogMs,lookupAllMs:appendLogLookupMs,files:count},crashes,choice:"sqlite_wal",status:"PASS_WINDOWS_STORE_SPIKE",boundary:"Process termination recovery, not power-loss or filesystem hardware failure."};
  fs.writeFileSync("docs/evidence/mcp/native-p4-ledger-store-spike.json",JSON.stringify(evidence,null,2)+"\n");console.log(JSON.stringify(evidence));
}
