// Read-only inspection after an ordinary worker upgrade; no browser tool calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { runtimeFingerprint } from "../../packages/mcp-server/dist/shared-stdio.js";
import { AccountRegistry } from "../../packages/native-antigravity/dist/account-registry.js";
import { McpNodeSemiSpaceSchema } from "../../packages/contracts/dist/index.js";

const endpoint="http://127.0.0.1:9236",health=await fetch(endpoint+"/__native/health").then(response=>response.json());
assert.ok(health.runtimeRevision>=26);assert.equal(health.counters.active,0);
const account=new AccountRegistry(path.join(os.homedir(),".gemini/antigravity-gemini-web-live/app_data/native-route/accounts.json")).getActive();assert.ok(account);assert.equal(account.accountId,health.account.accountId);
const worker=JSON.parse(fs.readFileSync(path.join(account.profilePath,"browser-stdio-owner.json"),"utf8"));
const expectedWorkerVersion=new Map([[26,18],[27,19],[28,20],[29,21],[30,22],[31,22],[32,22],[33,23],[34,23],[35,23],[36,23],[37,24],[38,24],[39,25],[40,25]]).get(health.runtimeRevision);
assert.ok(expectedWorkerVersion,"Inspect the current worker fingerprint version before checking a new runtime revision.");
assert.equal(worker.fingerprint,runtimeFingerprint({version:expectedWorkerVersion,profile:path.resolve(account.profilePath),state:path.resolve(account.statePath),port:account.debugPort,chromePath:process.env.AG_MCP_CHROME_PATH??"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",...(health.runtimeRevision>=37?{nodeSemiSpaceMiB:McpNodeSemiSpaceSchema.parse(health.backendResources?.requestedNodeSemiSpaceMiB)??0}:{})}));
const legacy=path.join(account.statePath,"receipts.json"),marker=JSON.parse(fs.readFileSync(legacy,"utf8")),backup=fs.readFileSync(legacy+".v1.backup"),old=JSON.parse(backup.toString("utf8"));
assert.equal(marker.version,2);assert.ok(Array.isArray(old));
const db=new DatabaseSync(legacy+".sqlite",{readOnly:true,allowExtension:false});let evidence;
try{
  db.exec("PRAGMA query_only=ON; BEGIN;");
  const meta=db.prepare("SELECT store_id AS storeId,legacy_count AS legacyCount,legacy_digest AS legacyDigest,state FROM store_meta WHERE id=1").get();
  const digest=createHash("sha256").update(backup).digest("hex");assert.equal(meta.storeId,marker.storeId);assert.equal(meta.state,"ready");assert.equal(meta.legacyCount,old.length);assert.equal(meta.legacyDigest,digest);
  const lookup=db.prepare("SELECT content_hash AS hash,phase,logical_request_id AS owner FROM receipts WHERE request_id=?"),rank={reserved:0,accepted:1,terminal:2};
  for(const row of old){const current=lookup.get(row.requestId);assert.equal(current?.hash,row.hash);assert.ok(rank[current.phase]>=rank[row.phase]);assert.equal(current.owner,null);}
  assert.equal(db.prepare("PRAGMA quick_check").get().quick_check,"ok");assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode,"wal");
  const prior=JSON.parse(fs.readFileSync("docs/evidence/mcp/native-p4-ledger-migration-copy.json","utf8"));
  evidence={checkedAt:new Date().toISOString(),runtimeRevision:health.runtimeRevision,pid:health.pid,workerVersion:expectedWorkerVersion,workerPid:worker.pid,workerFingerprintMatchesBuild:true,routingMode:health.routing?.mode??"manual",automaticRoutingEnabled:health.routing?.automaticRoutingEnabled??false,accountId:account.accountId,identityEpoch:health.account.identityEpoch,identityObservedAt:health.account.identityObservedAt,ledgerFormat:marker.version,legacyCount:old.length,totalReceipts:Number(db.prepare("SELECT count(*) AS count FROM receipts").get().count),backupSha256:digest,matchesPriorCopy:digest===prior.sourceSha256,allLegacyHashesAndPhasesPreserved:true,noLegacyOwnerInferred:true,journalMode:"wal",integrity:"ok",inspectionReadOnly:true,browserRequestsByProbe:0,uploadExperimental:health.snapshotAttachmentExperimental,status:"PASS_LIVE_RECEIPT_MIGRATION_INSPECTION",boundary:"Real account verification and metadata migration only; no live native tool loop, failover or second-account acceptance."};
  db.exec("COMMIT");
}finally{db.close();}
fs.writeFileSync(process.argv.find(value=>value.startsWith("--output="))?.slice(9)??`docs/evidence/mcp/native-r${health.runtimeRevision}-ledger-live-inspection.json`,JSON.stringify(evidence,null,2)+"\n");console.log(JSON.stringify(evidence));
