import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PhysicalReceiptStore } from "./receipt-store.js";
import { GeminiMcpService } from "./service.js";
import type { GeminiBrowserAdapter } from "@antigravity-gemini-web/gemini-browser";
import { removeOwnedFixture } from "./fixture-cleanup.js";

const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const root=()=>fs.mkdtempSync(path.join(os.tmpdir(),"gemini-mcp-test-"));

test("Legacy migration retains exact backup bytes and all phases, blocks old runtimes and rejects rollback to an old array", t=>{
  const directory=root(),ledger=path.join(directory,"receipts.json");t.after(()=>removeOwnedFixture(directory));
  const legacy=["reserved","accepted","terminal"].map((phase,i)=>({requestId:"legacy_request_"+i,hash:hash("legacy "+i),phase}));
  const original=Buffer.from(JSON.stringify(legacy,null,4)+"\n");fs.writeFileSync(ledger,original);
  const store=new PhysicalReceiptStore(ledger);
  assert.ok(fs.readFileSync(ledger+".v1.backup").equals(original));
  const marker=JSON.parse(fs.readFileSync(ledger,"utf8"));assert.equal(marker.version,2);assert.ok(!Array.isArray(marker));
  for(const row of legacy){assert.equal(store.get(row.requestId)?.hash,row.hash);assert.equal(store.get(row.requestId)?.phase,row.phase);assert.throws(()=>store.reserve(row.requestId,row.hash),{code:"OUTCOME_UNKNOWN"});}
  assert.equal(store.count(),3);
  const receipt=store.reserve("new_request_01",hash("new"));store.transition(receipt,"accepted");store.transition(receipt,"terminal");store.close();
  const reopened=new PhysicalReceiptStore(ledger);assert.equal(reopened.count(),4);assert.equal(reopened.get("new_request_01")?.phase,"terminal");reopened.close();
  fs.writeFileSync(ledger,original);
  assert.throws(()=>new PhysicalReceiptStore(ledger),{code:"LEDGER_UNAVAILABLE"});
});

test("Migration refuses duplicate/corrupt source, changed backup, missing database and a manifest from another store", t=>{
  for(const mode of ["duplicate","corrupt","backup","missing","foreign"]){
    const directory=root(),ledger=path.join(directory,"receipts.json");t.after(()=>removeOwnedFixture(directory));
    const row={requestId:"legacy_request_0",hash:hash("legacy"),phase:"accepted"};
    fs.writeFileSync(ledger,mode==="corrupt"?"[{partial":JSON.stringify(mode==="duplicate"?[row,row]:[row]));
    if(mode==="backup")fs.writeFileSync(ledger+".v1.backup","different source bytes");
    if(mode==="missing"||mode==="foreign"){
      const store=new PhysicalReceiptStore(ledger);store.close();
      if(mode==="missing")fs.unlinkSync(ledger+".sqlite");
      else fs.writeFileSync(ledger,JSON.stringify({version:2,kind:"sqlite_receipts",storeId:randomUUID()}));
    }
    assert.throws(()=>new PhysicalReceiptStore(ledger),{code:"LEDGER_UNAVAILABLE"});
  }
});

test("A full 2048-entry legacy ledger migrates without loss and accepts additional identities", t=>{
  const directory=root(),ledger=path.join(directory,"receipts.json");t.after(()=>removeOwnedFixture(directory));
  const legacy=Array.from({length:2048},(_,i)=>({requestId:"old_capacity_"+i,hash:hash("old "+i),phase:["reserved","accepted","terminal"][i%3]}));
  fs.writeFileSync(ledger,JSON.stringify(legacy));
  const store=new PhysicalReceiptStore(ledger);assert.equal(store.count(),2048);
  store.reserve("beyond_old_capacity",hash("next"));store.close();
  const reopened=new PhysicalReceiptStore(ledger);
  try {assert.equal(reopened.count(),2049);for(const row of legacy){const actual=reopened.get(row.requestId);assert.equal(actual?.hash,row.hash);assert.equal(actual?.phase,row.phase);assert.equal(actual?.owner,undefined);}}
  finally {reopened.close();}
});

test("Atomic SQLite reservations and phase compare-and-set reject competing or delayed authorities", t=>{
  const directory=root(),ledger=path.join(directory,"receipts.json");t.after(()=>removeOwnedFixture(directory));
  const first=new PhysicalReceiptStore(ledger),receipt=first.reserve("owned_request_01",hash("first")),stale={...receipt};
  const second=new PhysicalReceiptStore(ledger);
  try {
    assert.throws(()=>second.reserve(receipt.requestId,receipt.hash),{code:"OUTCOME_UNKNOWN"});
    assert.throws(()=>second.reserve(receipt.requestId,hash("changed")),{code:"CONFIG_CONFLICT"});
    first.transition(receipt,"accepted");
    assert.throws(()=>second.transition(stale,"terminal"),{code:"STALE_AUTHORITY"});
    const current=second.get(receipt.requestId)!;second.transition(current,"terminal");
    assert.throws(()=>first.transition(receipt,"terminal"),{code:"STALE_AUTHORITY"});
    assert.throws(()=>second.transition({...current,attemptId:randomUUID()},"accepted"),{code:"STALE_AUTHORITY"});
    assert.equal(first.get(receipt.requestId)?.phase,"terminal");
  } finally {first.close();second.close();}
});

test("Process termination during either migration publication barrier and each request phase never loses a Send fence", {timeout:60000}, async t=>{
  const worker=fileURLToPath(new URL("./receipt-store-worker.fixture.js",import.meta.url));
  for(const stage of ["migration_before_marker","migration_after_marker","reserved","accepted","terminal"]){
    const directory=root(),ledger=path.join(directory,"receipts.json"),barrier=path.join(directory,"barrier");t.after(()=>removeOwnedFixture(directory));
    if(stage.startsWith("migration_"))fs.writeFileSync(ledger,JSON.stringify([{requestId:"crash_request_01",hash:"a".repeat(64),phase:"accepted"}]));
    const child=spawn(process.execPath,[worker,ledger,stage,barrier],{windowsHide:true,stdio:"ignore"});
    const exited=new Promise<void>((resolve,reject)=>{child.once("error",reject);child.once("exit",()=>resolve());});
    const deadline=performance.now()+10000;
    try {
      while(!fs.existsSync(barrier)){assert.equal(child.exitCode,null,"Fixture worker must remain live until its barrier");assert.ok(performance.now()<deadline,"Fixture barrier deadline");await new Promise(resolve=>setTimeout(resolve,20));}
      assert.equal(fs.readFileSync(barrier,"utf8"),stage);assert.ok(child.kill("SIGKILL"));await exited;
      const store=new PhysicalReceiptStore(ledger);
      try {assert.equal(store.count(),1);assert.equal(store.get("crash_request_01")?.phase,stage.startsWith("migration_")?"accepted":stage);assert.throws(()=>store.reserve("crash_request_01","a".repeat(64)),{code:"OUTCOME_UNKNOWN"});}
      finally {store.close();}
    } finally {if(child.exitCode===null&&child.signalCode===null){child.kill("SIGKILL");await exited;}}
  }
});

test("Three synchronized processes competing for the same SQLite identity reserve it exactly once",{timeout:20000},async t=>{
  const directory=root(),ledger=path.join(directory,"receipts.json"),go=path.join(directory,"go"),worker=fileURLToPath(new URL("./receipt-store-worker.fixture.js",import.meta.url));
  t.after(()=>removeOwnedFixture(directory));
  const seed=new PhysicalReceiptStore(ledger);seed.reserve("seed_request_001",hash("seed"));seed.close();
  const children=Array.from({length:3},(_,i)=>{
    const barrier=path.join(directory,"ready-"+i),child=spawn(process.execPath,[worker,ledger,"compete",barrier,go],{windowsHide:true,stdio:["ignore","pipe","ignore"]});let output="";child.stdout.on("data",bytes=>{output+=bytes.toString();});
    const done=new Promise<string>((resolve,reject)=>{child.once("error",reject);child.once("exit",code=>code===0?resolve(output):reject(Error("Store worker failed")));});
    return {child,barrier,done};
  });
  try {
    const deadline=performance.now()+10000;
    while(!children.every(value=>fs.existsSync(value.barrier))){assert.ok(children.every(value=>value.child.exitCode===null),"All competitors must be live at the barrier");assert.ok(performance.now()<deadline);await new Promise(resolve=>setTimeout(resolve,20));}
    fs.writeFileSync(go,"go",{flag:"wx"});
    assert.deepEqual((await Promise.all(children.map(value=>value.done))).sort(),["OUTCOME_UNKNOWN","OUTCOME_UNKNOWN","reserved"]);
    const store=new PhysicalReceiptStore(ledger);try{assert.equal(store.count(),2);assert.equal(store.get("competing_request_01")?.phase,"reserved");}finally{store.close();}
  } finally {for(const value of children)if(value.child.exitCode===null&&value.child.signalCode===null)value.child.kill("SIGKILL");await Promise.allSettled(children.map(value=>value.done));}
});

test("More than 2048 physical browser fixture requests complete with bounded cached results and survive restart", {timeout:120000}, async t=>{
  const directory=root(),ledger=path.join(directory,"receipts.json");let sends=0;
  const browser:GeminiBrowserAdapter={
    checkStatus:async()=>({browserState:"ready",accountState:"signed_in",checkedAt:new Date().toISOString()}),openBrowser:async()=>({opened:true}),
    submitPrompt:async turnId=>{sends++;return {turnId,status:"accepted",submittedAt:new Date().toISOString()};},
    pollResponse:async turnId=>({turnId,status:"completed",text:"PRIVATE_FIXTURE_REPLY",completedAt:new Date().toISOString()}),cancelPrompt:async turnId=>({turnId,cancelled:false}),cleanup:async()=>{},sendPrompt:async()=>{throw Error("unused");},
  };
  const service=new GeminiMcpService(browser,ledger);let reopened:GeminiMcpService|undefined;
  t.after(async()=>{await service.close();await reopened?.close();removeOwnedFixture(directory);});
  const started=performance.now();
  for(let i=0;i<2100;i++){const id="physical_fixture_"+i;await service.submit(id,"PRIVATE_FIXTURE_PROMPT_"+i);assert.equal((await service.result(id,1000)).status,"completed");}
  const status=await service.status();assert.equal(sends,2100);assert.equal(status.requestIdentities,2100);assert.equal(status.maxRequestIdentities,null);assert.equal(status.receiptStore,"sqlite_wal_v2");assert.ok(status.cachedResults<=32);
  await assert.rejects(service.submit("physical_fixture_0","PRIVATE_FIXTURE_PROMPT_0"),{code:"OUTCOME_UNKNOWN"});await service.close();
  reopened=new GeminiMcpService(browser,ledger);
  await assert.rejects(reopened.submit("physical_fixture_0","PRIVATE_FIXTURE_PROMPT_0"),{code:"OUTCOME_UNKNOWN"});
  await assert.rejects(reopened.submit("physical_fixture_2099","changed"),{code:"CONFIG_CONFLICT"});
  assert.equal(sends,2100);assert.equal((await reopened.status()).requestIdentities,2100);await reopened.close();
  const bytes=fs.readFileSync(ledger+".sqlite");assert.ok(!bytes.includes(Buffer.from("PRIVATE_FIXTURE_PROMPT")));assert.ok(!bytes.includes(Buffer.from("PRIVATE_FIXTURE_REPLY")));
  t.diagnostic(`2100 physical fixture requests completed in ${Math.round(performance.now()-started)}ms; no Gemini Web requests were made.`);
});
