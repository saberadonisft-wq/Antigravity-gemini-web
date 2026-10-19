import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { BridgeError } from "./bridge-error.js";
import { NativeReceiptOwnerSchema, type NativeReceiptOwner } from "@antigravity-gemini-web/contracts";

export const RequestId = z.string().regex(/^[a-zA-Z0-9_-]{8,96}$/);
const Phase = z.enum(["reserved", "accepted", "terminal"]);
const LegacyReceipt = z.object({requestId:RequestId,hash:z.string().regex(/^[a-f0-9]{64}$/),phase:Phase}).strict();
const Receipt = LegacyReceipt.extend({attemptId:z.string().uuid(),createdAt:z.string().datetime(),updatedAt:z.string().datetime(),owner:NativeReceiptOwnerSchema.optional()});
export type PhysicalReceipt = z.infer<typeof Receipt>;
const Manifest = z.object({version:z.literal(2),kind:z.literal("sqlite_receipts"),storeId:z.string().uuid()}).strict();
const Meta = z.object({version:z.literal(2),storeId:z.string().uuid(),state:z.enum(["installing","ready"]),legacyDigest:z.string().regex(/^[a-f0-9]{64}$/).nullable(),legacyCount:z.number().int().nonnegative()});
type Meta = z.infer<typeof Meta>;
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function unavailable() { return new BridgeError("LEDGER_UNAVAILABLE", "Physical receipt store is unavailable. No browser action or automatic replay is permitted."); }
function assertPrivatePath(filename: string) {
  const resolved=path.resolve(filename);let current=path.parse(resolved).root;
  for(const part of resolved.slice(current.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);
    try {if(fs.lstatSync(current).isSymbolicLink())throw unavailable();}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  }
}
function privateWrite(filename:string,bytes:string|Buffer) {
  const fd=fs.openSync(filename,"wx",0o600);
  try {fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function publish(filename:string,bytes:string) {
  const temporary=filename+"."+randomUUID()+".tmp";
  try {privateWrite(temporary,bytes);fs.renameSync(temporary,filename);}
  finally {if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}

/** Indexed metadata only; SQLite owns atomic reservations and durable phase changes. */
export class PhysicalReceiptStore {
  readonly databaseFile: string;
  private db?: DatabaseSync;
  private closed=false;
  private faulted=false;
  constructor(readonly legacyFile:string) {
    this.databaseFile=legacyFile+".sqlite";
    if(fs.existsSync(legacyFile)||fs.existsSync(this.databaseFile))this.initialize();
  }
  private paths() {
    for(const file of [this.legacyFile,this.legacyFile+".v1.backup",this.databaseFile,this.databaseFile+"-wal",this.databaseFile+"-shm"])assertPrivatePath(file);
  }
  private transaction<T>(action:()=>T):T {
    this.db!.exec("BEGIN IMMEDIATE");
    try {const result=action();this.db!.exec("COMMIT");return result;}
    catch(error){try{this.db!.exec("ROLLBACK");}catch{}throw error;}
  }
  private meta():Meta {
    return Meta.parse(this.db!.prepare("SELECT version, store_id AS storeId, state, legacy_digest AS legacyDigest, legacy_count AS legacyCount FROM store_meta WHERE id=1").get());
  }
  private initialize() {
    if(this.closed||this.faulted)throw unavailable();
    if(this.db)return;
    try {
      this.paths();
      const original=fs.existsSync(this.legacyFile)?fs.readFileSync(this.legacyFile):undefined;
      const raw:unknown=original?JSON.parse(original.toString("utf8")):undefined;
      const marker=Manifest.safeParse(raw);
      let legacy:z.infer<typeof LegacyReceipt>[]|undefined;
      if(original&&!marker.success){
        legacy=z.array(LegacyReceipt).max(2048).parse(raw);
        if(new Set(legacy.map(row=>row.requestId)).size!==legacy.length)throw unavailable();
      }
      const existing=fs.existsSync(this.databaseFile);
      // A missing SQLite file can never be replaced by an empty store after migration.
      if(marker.success&&!existing)throw unavailable();
      fs.mkdirSync(path.dirname(this.legacyFile),{recursive:true,mode:0o700});
      this.paths();
      const {DatabaseSync}=createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      if(!existing)privateWrite(this.databaseFile,Buffer.alloc(0));
      this.db=new DatabaseSync(this.databaseFile,{allowExtension:false});
      fs.chmodSync(this.databaseFile,0o600);
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      if(this.db.prepare("PRAGMA journal_mode").get()?.journal_mode!=="wal"||this.db.prepare("PRAGMA synchronous").get()?.synchronous!==2)throw unavailable();
      if(this.db.prepare("PRAGMA quick_check").get()?.quick_check!=="ok")throw unavailable();
      if(!existing){
        this.transaction(()=>{
          this.db!.exec("CREATE TABLE store_meta(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=2), store_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('installing','ready')), legacy_digest TEXT, legacy_count INTEGER NOT NULL) STRICT; CREATE TABLE receipts(request_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL CHECK(length(content_hash)=64), phase TEXT NOT NULL CHECK(phase IN ('reserved','accepted','terminal')), attempt_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, logical_request_id TEXT, logical_attempt_id TEXT, account_id TEXT, identity_epoch INTEGER, CHECK((logical_request_id IS NULL AND logical_attempt_id IS NULL AND account_id IS NULL AND identity_epoch IS NULL) OR (logical_request_id IS NOT NULL AND logical_attempt_id IS NOT NULL AND account_id IS NOT NULL AND identity_epoch IS NOT NULL))) STRICT; CREATE INDEX native_owner_attempt ON receipts(logical_request_id,logical_attempt_id);");
          const storeId=randomUUID();
          this.db!.prepare("INSERT INTO store_meta VALUES(1,2,?,'installing',?,?)").run(storeId,original?digest(original):null,legacy?.length??0);
          if(legacy){
            const now=new Date().toISOString(),insert=this.db!.prepare("INSERT INTO receipts(request_id,content_hash,phase,attempt_id,created_at,updated_at) VALUES(?,?,?,?,?,?)");
            for(const row of legacy)insert.run(row.requestId,row.hash,row.phase,randomUUID(),now,now);
          }
        });
      }
      this.transaction(()=>{
        const meta=this.meta();
        if(marker.success){
          if(marker.data.storeId!==meta.storeId)throw unavailable();
          if(meta.legacyDigest){
            const backup=fs.readFileSync(this.legacyFile+".v1.backup");
            if(digest(backup)!==meta.legacyDigest)throw unavailable();
            const imported=z.array(LegacyReceipt).max(2048).parse(JSON.parse(backup.toString("utf8")));
            if(imported.length!==meta.legacyCount)throw unavailable();
            const rank={reserved:0,accepted:1,terminal:2};
            for(const row of imported){const saved=this.getRow(row.requestId);if(!saved||saved.hash!==row.hash||rank[saved.phase]<rank[row.phase])throw unavailable();}
          }
        } else {
          if(meta.state!=="installing"||meta.legacyDigest!==(original?digest(original):null)||meta.legacyCount!==(legacy?.length??0))throw unavailable();
          const current=fs.existsSync(this.legacyFile)?fs.readFileSync(this.legacyFile):undefined;
          if((original?digest(original):undefined)!==(current?digest(current):undefined))throw unavailable();
          if(legacy&&original){
            const backup=this.legacyFile+".v1.backup";
            if(fs.existsSync(backup)){if(!fs.readFileSync(backup).equals(original))throw unavailable();}
            else privateWrite(backup,original);
            for(const row of legacy){const saved=this.getRow(row.requestId);if(!saved||saved.hash!==row.hash||saved.phase!==row.phase)throw unavailable();}
          }
          publish(this.legacyFile,JSON.stringify({version:2,kind:"sqlite_receipts",storeId:meta.storeId})+"\n");
        }
        this.db!.prepare("UPDATE store_meta SET state='ready' WHERE id=1").run();
      });
      this.paths();
    } catch {
      this.faulted=true;try{this.db?.close();}catch{}this.db=undefined;throw unavailable();
    }
  }
  private access() {
    if(this.closed||this.faulted)throw unavailable();
    if(!this.db)this.initialize();
    return this.db!;
  }
  private getRow(requestId:string):PhysicalReceipt|undefined {
    const row=this.db!.prepare("SELECT request_id AS requestId,content_hash AS hash,phase,attempt_id AS attemptId,created_at AS createdAt,updated_at AS updatedAt,logical_request_id AS logicalRequestId,logical_attempt_id AS logicalAttemptId,account_id AS accountId,identity_epoch AS identityEpoch FROM receipts WHERE request_id=?").get(requestId);
    if(!row)return undefined;
    const {logicalRequestId,logicalAttemptId,accountId,identityEpoch,...base}=row;
    return Receipt.parse({...base,...(logicalRequestId===null?{}:{owner:{logicalRequestId,logicalAttemptId,accountId,identityEpoch}})});
  }
  get(requestId:string):PhysicalReceipt|undefined {
    RequestId.parse(requestId);
    if(!this.db&&!this.closed&&!this.faulted&&!fs.existsSync(this.legacyFile)&&!fs.existsSync(this.databaseFile))return undefined;
    try {this.access();return this.getRow(requestId);}catch{this.faulted=true;throw unavailable();}
  }
  count():number {
    if(!this.db&&!this.closed&&!this.faulted&&!fs.existsSync(this.legacyFile)&&!fs.existsSync(this.databaseFile))return 0;
    try{return Number(this.access().prepare("SELECT count(*) AS count FROM receipts").get()!.count);}catch{this.faulted=true;throw unavailable();}
  }
  reserve(requestId:string,hash:string,owner?:NativeReceiptOwner):PhysicalReceipt {
    RequestId.parse(requestId);z.string().regex(/^[a-f0-9]{64}$/).parse(hash);
    if(owner)owner=NativeReceiptOwnerSchema.parse(owner);
    const now=new Date().toISOString(),receipt:PhysicalReceipt={requestId,hash,phase:"reserved",attemptId:randomUUID(),createdAt:now,updatedAt:now,...(owner?{owner}:{})};
    try {
      const db=this.access();
      this.transaction(()=>{
        const old=this.getRow(requestId);
        if(old)throw new BridgeError(old.hash===hash?"OUTCOME_UNKNOWN":"CONFIG_CONFLICT","This physical request already has a durable Send identity; no replay.");
        db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?,?,?,?,?)").run(requestId,hash,"reserved",receipt.attemptId,now,now,owner?.logicalRequestId??null,owner?.logicalAttemptId??null,owner?.accountId??null,owner?.identityEpoch??null);
      });
      return receipt;
    }catch(error){if(error instanceof BridgeError&&error.code!=="LEDGER_UNAVAILABLE")throw error;this.faulted=true;throw unavailable();}
  }
  transition(receipt:PhysicalReceipt,phase:"accepted"|"terminal") {
    try {
      const now=new Date().toISOString(),old=this.get(receipt.requestId);
      if(!old||old.attemptId!==receipt.attemptId||old.hash!==receipt.hash||old.phase!==receipt.phase||old.phase==="terminal"||(phase==="accepted"&&old.phase!=="reserved"))throw new BridgeError("STALE_AUTHORITY","Physical receipt phase or attempt authority changed.");
      const result=this.access().prepare("UPDATE receipts SET phase=?,updated_at=? WHERE request_id=? AND content_hash=? AND attempt_id=? AND phase=?").run(phase,now,receipt.requestId,receipt.hash,receipt.attemptId,receipt.phase);
      if(Number(result.changes)!==1)throw new BridgeError("STALE_AUTHORITY","Physical receipt authority changed.");
      receipt.phase=phase;receipt.updatedAt=now;
    }catch(error){if(error instanceof BridgeError&&error.code==="STALE_AUTHORITY")throw error;this.faulted=true;throw unavailable();}
  }
  close(){if(this.closed)return;this.closed=true;try{this.db?.close();}finally{this.db=undefined;}}
}
