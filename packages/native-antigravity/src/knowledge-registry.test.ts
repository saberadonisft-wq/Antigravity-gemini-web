import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { NativeKnowledgeRegistry } from "./knowledge-registry.js";
import { githubRepository,selectedKnowledgePath } from "./knowledge-files.js";
import { sha256,canonical } from "./native-protocol.js";

function fixture(t:test.TestContext){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"ag-knowledge-")),folder=path.join(root,"project"),file=path.join(root,"state","knowledge.json");fs.mkdirSync(folder);
  t.after(()=>{const resolved=fs.realpathSync(root);assert.equal(path.dirname(resolved).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(resolved).startsWith("ag-knowledge-"));fs.rmSync(resolved,{recursive:true,force:true});});
  const store=new NativeKnowledgeRegistry(file),write=(relative:string,text:string|Buffer)=>{const target=path.join(folder,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);};
  const imported=(files:string[])=>store.importCode({kind:"local_folder",label:"Selected source",root:folder,files,overlayFiles:[]},store.snapshot().revision);
  const bind=(id:string)=>store.bind(sha256("task"),"acc_account_A",1,[id],store.snapshot().revision);
  return {root,folder,file,store,write,imported,bind};
}
function localGit(root:string,args:string[]){
  const env={...process.env};for(const name of Object.keys(env))if(name.startsWith("GIT_"))delete env[name];
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:process.platform==="win32"?"NUL":"/dev/null",GIT_TERMINAL_PROMPT:"0"});
  return execFileSync("git",["-c","core.fsmonitor=false","-c","core.autocrlf=false","-c","commit.gpgsign=false","-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-C",root,...args],{env,windowsHide:true,stdio:["ignore","pipe","pipe"]}).toString("utf8").trim();
}

test("Selected UTF-8/CRLF/BOM bytes are exact, while metadata contains no source content or private root in status",t=>{
  const f=fixture(t),text="\ufeffSYNTHETIC_SELECTED_MARKER_42\r\nTiếng Việt 😀\r\n";f.write("README.md",text);f.write("unused.md","UNSELECTED_PRIVATE_MARKER");
  const source=f.imported(["README.md"]);f.bind(source.sourceId);const resolved=f.store.resolve(sha256("task"),"acc_account_A",1);
  assert.equal(resolved.used,true);const wire=resolved.wire as any;assert.equal(wire.sources[0].files[0].text,text);assert.equal(wire.sources[0].files[0].sha256,sha256(Buffer.from(text)));
  const metadata=fs.readFileSync(f.file,"utf8");assert.ok(!metadata.includes("SYNTHETIC_SELECTED_MARKER_42"));assert.ok(!metadata.includes("UNSELECTED_PRIVATE_MARKER"));assert.ok(!JSON.stringify(wire).includes(f.folder));
  const status=f.store.status(randomUUID(),true,true);assert.ok(!JSON.stringify(status).includes(f.folder));assert.equal(status.sources[0].state,"current");resolved.assertCurrent();
});

test("Changed, renamed or removed selected files become stale; explicit refresh changes source revision",t=>{
  const f=fixture(t);f.write("a.md","version one");const source=f.imported(["a.md"]);f.bind(source.sourceId);const before=f.store.resolve(sha256("task"),"acc_account_A",1);
  f.write("a.md","version two");assert.throws(()=>before.assertCurrent(),{code:"SOURCE_STALE"});f.store.check(source.sourceId);assert.equal(f.store.status(randomUUID(),true,true).sources[0].state,"stale");
  const omitted=f.store.resolve(sha256("task"),"acc_account_A",1);assert.equal(omitted.used,false);assert.ok(omitted.issues.includes("SOURCE_STALE"));assert.ok(!JSON.stringify(omitted.wire).includes("version one"));
  const refreshed=f.store.refresh(source.sourceId,f.store.snapshot().revision);assert.equal(refreshed.revision,2);assert.notEqual(refreshed.digest,source.digest);assert.equal((f.store.resolve(sha256("task"),"acc_account_A",1).wire as any).sources[0].files[0].text,"version two");
  fs.renameSync(path.join(f.folder,"a.md"),path.join(f.folder,"renamed.md"));f.store.check(source.sourceId);assert.equal(f.store.status(randomUUID(),true,true).sources[0].reasonCode,"SOURCE_FILE_MISSING");
});

test("Credentials, caches, traversal, Windows device/ADS aliases and duplicate path selections are rejected atomically",t=>{
  const f=fixture(t);f.write("ok.md","safe");
  for(const relative of ["../outside.md","/absolute.md","a/../b.md","a.txt:secret","NUL.md","dir./file.md",".env",".env.example",".git/config","node_modules/a.js","dist/index.js","credentials.json","cookies.txt","id_ed25519","private.pem"]){assert.throws(()=>selectedKnowledgePath(relative),error=>typeof error==="object"&&error!==null&&"code" in error);}
  assert.throws(()=>f.imported(["ok.md","OK.md"]),{code:"SOURCE_SELECTION_INVALID"});
  f.write("example.md",["-----BEGIN","PRIVATE KEY-----"].join(" ")+"\nsynthetic");assert.throws(()=>f.imported(["example.md"]),{code:"SOURCE_CREDENTIAL_CONTENT"});assert.equal(f.store.snapshot().sources.length,0);
  f.write("binary.md",Buffer.from([0xff,0xfe,0x41,0x00]));assert.throws(()=>f.imported(["binary.md"]),{code:"SOURCE_NOT_TEXT"});
  f.write("embedded-zero.txt","a\0b");assert.throws(()=>f.imported(["embedded-zero.txt"]),{code:"SOURCE_NOT_TEXT"});
  f.write("large.md","x".repeat(1048577));assert.throws(()=>f.imported(["large.md"]),{code:"SOURCE_FILE_TOO_LARGE"});assert.equal(f.store.snapshot().revision,0);
});

test("Hardlinks and directory junctions cannot smuggle an unselected file into the bundle",t=>{
  const f=fixture(t),outside=path.join(f.root,"outside");fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,"private.md"),"OUTSIDE_MARKER");
  fs.linkSync(path.join(outside,"private.md"),path.join(f.folder,"hard.md"));assert.throws(()=>f.imported(["hard.md"]),{code:"SOURCE_PATH_UNSAFE"});
  fs.symlinkSync(outside,path.join(f.folder,"linked"),process.platform==="win32"?"junction":"dir");assert.throws(()=>f.imported(["linked/private.md"]));assert.equal(f.store.snapshot().sources.length,0);
});

test("Account, identity epoch and task bindings are explicit; changed metadata fences captured source leases",t=>{
  const f=fixture(t);f.write("a.md","account A reference");const source=f.imported(["a.md"]);f.bind(source.sourceId);
  assert.equal(f.store.resolve(sha256("other task"),"acc_account_A",1).used,false);
  const b=f.store.resolve(sha256("task"),"acc_account_B",1);assert.equal(b.used,false);assert.deepEqual(b.issues,["SOURCE_ACCOUNT_NOT_BOUND"]);assert.ok(!JSON.stringify(b).includes(source.sourceId));
  assert.deepEqual(f.store.resolve(sha256("task"),"acc_account_A",2).issues,["SOURCE_ACCOUNT_EPOCH_CHANGED"]);
  const lease=f.store.resolve(sha256("task"),"acc_account_A",1);f.store.bind(sha256("task"),"acc_account_A",1,[],f.store.snapshot().revision);assert.throws(()=>lease.assertCurrent(),{code:"SOURCE_CONFIG_CHANGED"});
  assert.throws(()=>f.store.bind(sha256("task"),"acc_account_A",1,[source.sourceId],0),{code:"SOURCE_CONFIG_CONFLICT"});
});

test("External adapters are independently registered and remain not verified; registration is not permission proof",t=>{
  const f=fixture(t);
  assert.throws(()=>f.store.registerExternal({kind:"gem",label:"Gem",url:"https://gemini.google.com/gem/fixture"},0),{code:"SOURCE_INSTRUCTION_VERSION_REQUIRED"});
  const sources=[
    {kind:"gem" as const,label:"Gem",url:"https://gemini.google.com/gem/fixture",instructionVersion:"stable-v1"},
    {kind:"notebook" as const,label:"Notebook",url:"https://notebook.google.com/notebook/fixture"},
    {kind:"drive" as const,label:"Drive",url:"https://docs.google.com/document/d/fixture/edit"},
    {kind:"github_web" as const,label:"GitHub Web",url:"https://github.com/example/fixture"},
  ].map(params=>f.store.registerExternal(params,f.store.snapshot().revision));
  f.store.bind(sha256("task"),"acc_account_A",1,sources.map(source=>source.sourceId),f.store.snapshot().revision);
  assert.ok(f.store.status(randomUUID(),true,true).sources.every(source=>source.state==="not_verified"));const resolution=f.store.resolve(sha256("task"),"acc_account_A",1);assert.equal(resolution.used,false);assert.deepEqual(resolution.issues,["SOURCE_ADAPTER_NOT_LIVE_VERIFIED"]);
  for(const url of ["https://attacker.invalid/file/d/fixture","https://docs.google.com/document/d/fixture/edit?token=private","https://user:private@docs.google.com/document/d/fixture/edit"]){assert.throws(()=>f.store.registerExternal({kind:"drive",label:"bad",url},f.store.snapshot().revision),{code:"SOURCE_URL_INVALID"});}
});

test("Knowledge budget omission is explicit and never includes a truncated file",t=>{
  const f=fixture(t);f.write("a.md","x".repeat(32769));const source=f.imported(["a.md"]);f.bind(source.sourceId);const resolved=f.store.resolve(sha256("task"),"acc_account_A",1);assert.equal(resolved.used,false);assert.deepEqual(resolved.issues,["SOURCE_BUDGET_EXCEEDED"]);assert.ok(!JSON.stringify(resolved.wire).includes("xxxxx"));
});

test("GitHub checkout provenance pins commit and explicitly selected overlays, including uncommitted files",t=>{
  const f=fixture(t);f.write("README.md","commit value\n");localGit(f.folder,["init"]);localGit(f.folder,["config","core.autocrlf","false"]);localGit(f.folder,["remote","add","origin","git@github.com:Example/Fixture.git"]);localGit(f.folder,["add","README.md"]);localGit(f.folder,["commit","--no-verify","-m","fixture"]);
  const params={kind:"github_checkout" as const,label:"Pinned checkout",root:f.folder,files:["README.md"],overlayFiles:[],repository:"https://github.com/example/fixture"};
  f.write("README.md","commit value\r\n");const source=f.store.importCode(params,0);assert.equal(source.files[0].origin,"line_endings");assert.equal(source.git!.commit,localGit(f.folder,["rev-parse","HEAD"]));
  f.write("README.md","UNCOMMITTED_OVERLAY");f.write("new.md","NEW_UNTRACKED_OVERLAY");assert.throws(()=>f.store.importCode({...params,files:["README.md","new.md"]},1),{code:"SOURCE_OVERLAY_REQUIRED"});
  const overlay=f.store.importCode({...params,files:["README.md","new.md"],overlayFiles:["README.md","new.md"]},1);assert.ok(overlay.files.every(file=>file.origin==="overlay"));f.bind(overlay.sourceId);assert.ok(JSON.stringify(f.store.resolve(sha256("task"),"acc_account_A",1).wire).includes("NEW_UNTRACKED_OVERLAY"));
  localGit(f.folder,["add","README.md","new.md"]);localGit(f.folder,["commit","--no-verify","-m","changed"]);f.store.check(overlay.sourceId);assert.equal(f.store.status(randomUUID(),true,true).sources.find(item=>item.sourceId===overlay.sourceId)!.reasonCode,"SOURCE_COMMIT_CHANGED");
  localGit(f.folder,["config","remote.origin.promisor","true"]);assert.throws(()=>f.store.importCode(params,f.store.snapshot().revision),{code:"SOURCE_PARTIAL_CLONE_UNSUPPORTED"});
  assert.equal(githubRepository("https://GitHub.com/Example/Fixture.git"),"https://github.com/example/fixture");
});

test("Corrupt metadata, unknown fields and retained writer locks fail closed without source-content persistence",t=>{
  const f=fixture(t);f.write("a.md","safe source");const source=f.imported(["a.md"]);
  fs.writeFileSync(f.file+".lock","retained crash lock");assert.throws(()=>f.store.bind(sha256("task"),"acc_account_A",1,[source.sourceId],1),{code:"SOURCE_REGISTRY_BUSY"});fs.unlinkSync(f.file+".lock");
  const data=JSON.parse(fs.readFileSync(f.file,"utf8"));data.prompt="not allowed";fs.writeFileSync(f.file,JSON.stringify(data));assert.throws(()=>f.store.snapshot(),{code:"SOURCE_REGISTRY_UNAVAILABLE"});assert.deepEqual(f.store.resolve(sha256("task"),"acc_account_A",1).issues,["SOURCE_REGISTRY_UNAVAILABLE"]);
});

test("Reading checkout provenance never runs repository filters, textconv or fsmonitor commands",t=>{
  const f=fixture(t);f.write("empty.md","");f.write("a.md","safe committed reference\n");localGit(f.folder,["init"]);localGit(f.folder,["remote","add","origin","https://github.com/example/fixture"]);localGit(f.folder,["add","a.md","empty.md"]);localGit(f.folder,["commit","--no-verify","-m","fixture"]);
  const marker=path.join(f.root,"unexpected-execution"),script=path.join(f.root,"unexpected.cjs");fs.writeFileSync(script,'require("node:fs").writeFileSync(process.argv[2],"unexpected");');
  const command='"'+process.execPath.replaceAll("\\","/")+'" "'+script.replaceAll("\\","/")+'" "'+marker.replaceAll("\\","/")+'"';
  for(const key of ["core.fsmonitor","filter.reference.clean","filter.reference.smudge","diff.reference.textconv"])localGit(f.folder,["config",key,command]);
  f.write(".gitattributes","*.md filter=reference diff=reference\n");
  const source=f.store.importCode({kind:"github_checkout",label:"No executable filters",root:f.folder,files:["a.md","empty.md"],overlayFiles:[],repository:"https://github.com/example/fixture"},0);f.bind(source.sourceId);
  assert.equal(source.files.find(file=>file.path==="empty.md")!.origin,"commit");assert.equal(f.store.resolve(sha256("task"),"acc_account_A",1).used,true);assert.equal(fs.existsSync(marker),false);
});

test("Removing metadata requires all explicit bindings to be cleared and never removes the source files",t=>{
  const f=fixture(t);f.write("a.md","file remains on disk");const source=f.imported(["a.md"]);f.bind(source.sourceId);
  assert.throws(()=>f.store.remove(source.sourceId,f.store.snapshot().revision),{code:"SOURCE_STILL_BOUND"});assert.equal(f.store.snapshot().sources.length,1);
  f.store.bind(sha256("task"),"acc_account_A",1,[],f.store.snapshot().revision);f.store.remove(source.sourceId,f.store.snapshot().revision);assert.equal(f.store.snapshot().sources.length,0);assert.equal(fs.readFileSync(path.join(f.folder,"a.md"),"utf8"),"file remains on disk");
});

test("Tampered paths and credential-bearing external URLs cannot leak through a status snapshot",t=>{
  const f=fixture(t);f.write("a.md","safe");f.imported(["a.md"]);const original=fs.readFileSync(f.file,"utf8"),data=JSON.parse(original);
  data.sources[0].files[0].path="C:/private/root.md";data.sources[0].digest=sha256(canonical({files:data.sources[0].files,git:data.sources[0].git}));fs.writeFileSync(f.file,JSON.stringify(data));assert.throws(()=>f.store.status(randomUUID(),true,true),{code:"SOURCE_REGISTRY_UNAVAILABLE"});
  fs.writeFileSync(f.file,original);f.store.registerExternal({kind:"drive",label:"Drive",url:"https://docs.google.com/document/d/fixture/edit"},1);const external=JSON.parse(fs.readFileSync(f.file,"utf8"));external.sources[1].url="https://user:private@docs.google.com/document/d/fixture/edit";fs.writeFileSync(f.file,JSON.stringify(external));assert.throws(()=>f.store.status(randomUUID(),true,true),{code:"SOURCE_REGISTRY_UNAVAILABLE"});
});
