// Validate a private COPY of the current legacy browser ledger. Never mutate it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash,randomUUID } from "node:crypto";
import { AccountRegistry } from "../../packages/native-antigravity/dist/account-registry.js";
import { PhysicalReceiptStore } from "../../packages/mcp-server/dist/receipt-store.js";

const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const native=path.join(os.homedir(),".gemini/antigravity-gemini-web-live/app_data/native-route");
const account=new AccountRegistry(path.join(native,"accounts.json")).getActive();assert.ok(account);
const source=path.join(account.statePath,"receipts.json"),bytes=fs.readFileSync(source),legacy=JSON.parse(bytes.toString("utf8"));
assert.ok(Array.isArray(legacy),"This probe expects an unmigrated v1 source; no production write is allowed.");
const directory=fs.mkdtempSync(path.join(process.cwd(),".tmp/p4-migration-copy-")),copy=path.join(directory,"receipts.json");
fs.writeFileSync(copy,bytes,{flag:"wx",mode:0o600});
const store=new PhysicalReceiptStore(copy);
try{
  assert.equal(store.count(),legacy.length);assert.ok(fs.readFileSync(copy+".v1.backup").equals(bytes));
  for(const row of legacy){const saved=store.get(row.requestId);assert.equal(saved?.hash,row.hash);assert.equal(saved?.phase,row.phase);assert.equal(saved?.owner,undefined);}
  const next=store.reserve("migration_copy_"+randomUUID().replaceAll("-",""),hash("synthetic metadata only"));store.transition(next,"accepted");store.transition(next,"terminal");
}finally{store.close();}
const reopened=new PhysicalReceiptStore(copy);try{assert.equal(reopened.count(),legacy.length+1);}finally{reopened.close();}
assert.ok(fs.readFileSync(source).equals(bytes),"Production source changed concurrently; unchanged-source proof is unavailable.");
const evidence={checkedAt:new Date().toISOString(),accountId:account.accountId,sourceFormat:"legacy_v1",sourceEntries:legacy.length,sourceSha256:hash(bytes),sourceUnchanged:true,exactBackup:true,allHashesAndPhasesPreserved:true,legacyOwnersRemainUnknown:true,syntheticNewReceiptSurvivedRestart:true,browserRequests:0,productionWrites:0,status:"PASS_REAL_METADATA_COPY_MIGRATION"};
fs.writeFileSync("docs/evidence/mcp/native-p4-ledger-migration-copy.json",JSON.stringify(evidence,null,2)+"\n");console.log(JSON.stringify(evidence));
