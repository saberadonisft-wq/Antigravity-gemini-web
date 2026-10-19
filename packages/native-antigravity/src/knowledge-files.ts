import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { KnowledgeCodeImportSchema,type KnowledgeCodeImport,type KnowledgeCodeSource } from "@antigravity-gemini-web/contracts";
import { assertNoLinks } from "./installation.js";
import { NativeRouteError,canonical,sha256 } from "./native-protocol.js";
import { hasValidUnicode } from "./unicode.js";

export const MAX_KNOWLEDGE_FILE_BYTES=1048576,MAX_KNOWLEDGE_IMPORT_BYTES=8*1048576;
const excludedDirectories=new Set([".git",".hg",".svn",".ssh",".aws",".azure",".kube",".gnupg",".codex",".gemini","node_modules",".pnpm-store",".cache",".next",".nuxt",".svelte-kit",".turbo",".parcel-cache","dist","build","out","target","bin","obj","coverage","__pycache__",".venv","venv",".pytest_cache",".mypy_cache"]);
export function knowledgeError(code:string):never{throw new NativeRouteError(code,"Project knowledge validation failed; inspect source status before continuing.",409);}
export function selectedKnowledgePath(input:string):string {
  if(!hasValidUnicode(input)||/[\u0000-\u001f\u007f:]/.test(input)||/^[\\/]/.test(input))knowledgeError("SOURCE_PATH_UNSAFE");
  const normalized=input.replaceAll("\\","/"),parts=normalized.split("/");
  if(parts.some(part=>!part||part==="."||part===".."||/[. ]$/.test(part)||/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(part)))knowledgeError("SOURCE_PATH_UNSAFE");
  const name=parts.at(-1)!.toLowerCase();
  if(parts.some(part=>excludedDirectories.has(part.toLowerCase()))||/^\.env(?:\.|$)|^\.(?:npmrc|pypirc|netrc|git-credentials|gitconfig)$|^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)|^(?:credentials?|secrets?|tokens?|cookies?)(?:\.|$)|^(?:service[-_]?account|client[-_]?secret).*\.json$/i.test(name)||/\.(?:pem|key|p12|pfx|keystore|jks|sqlite3?|db|log|lock|zip|gz|tar|7z|exe|dll|so|bin|pyc|class|wasm)$/i.test(name))knowledgeError("SOURCE_FILE_EXCLUDED");
  return normalized;
}
function sourceRoot(root:string){
  if(!path.isAbsolute(root)||/^[\\/]{2}/.test(root)||!hasValidUnicode(root))knowledgeError("SOURCE_PATH_UNSAFE");
  try{assertNoLinks(root);const actual=fs.realpathSync.native(root);if(!fs.statSync(actual).isDirectory())knowledgeError("SOURCE_PATH_UNSAFE");return actual;}catch{knowledgeError("SOURCE_PATH_UNSAFE");}
}
function inside(root:string,file:string){const relative=path.relative(root,file);return !!relative&&!relative.startsWith(".."+path.sep)&&relative!==".."&&!path.isAbsolute(relative);}
export function readKnowledgeFile(root:string,relative:string):{text:string;bytes:number;sha256:string}{
  const safe=selectedKnowledgePath(relative),absolute=path.join(root,...safe.split("/"));let fd:number|undefined;
  try{
    assertNoLinks(absolute);if(!inside(root,fs.realpathSync.native(absolute)))knowledgeError("SOURCE_PATH_UNSAFE");
    const initial=fs.lstatSync(absolute);if(!initial.isFile()||initial.nlink!==1)knowledgeError("SOURCE_PATH_UNSAFE");
    fd=fs.openSync(absolute,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0)|(fs.constants.O_NONBLOCK??0));
    const before=fs.fstatSync(fd);if(!before.isFile()||before.nlink!==1||before.size>MAX_KNOWLEDGE_FILE_BYTES)knowledgeError("SOURCE_FILE_TOO_LARGE");
    assertNoLinks(absolute);if(!inside(root,fs.realpathSync.native(absolute)))knowledgeError("SOURCE_PATH_UNSAFE");
    const linked=fs.statSync(absolute);if(linked.dev!==before.dev||linked.ino!==before.ino)knowledgeError("SOURCE_CHANGED_DURING_READ");
    const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd);
    if(bytes.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)knowledgeError("SOURCE_CHANGED_DURING_READ");
    const text=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes);
    if(text.includes("\0")||!Buffer.from(text,"utf8").equals(bytes))knowledgeError("SOURCE_NOT_TEXT");
    if(/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[0-9A-Za-z_]{20,}|github_pat_[0-9A-Za-z_]{20,}|AKIA[0-9A-Z]{16}|# Netscape HTTP Cookie File/.test(text))knowledgeError("SOURCE_CREDENTIAL_CONTENT");
    return {text,bytes:bytes.length,sha256:sha256(bytes)};
  }catch(error){if(error instanceof NativeRouteError)throw error;return knowledgeError((error as NodeJS.ErrnoException).code==="ENOENT"?"SOURCE_FILE_MISSING":"SOURCE_NOT_TEXT");}
  finally{if(fd!==undefined)fs.closeSync(fd);}
}
export function githubRepository(input:string):string {
  const ssh=/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(input);
  if(ssh)input="https://github.com/"+ssh[1]+"/"+ssh[2];
  let url:URL;try{url=new URL(input);}catch{knowledgeError("SOURCE_REPOSITORY_INVALID");}
  const match=/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
  if(url.protocol!=="https:"||url.hostname!=="github.com"||url.port||url.username||url.password||url.search||url.hash||!match||[match[1],match[2]].some(value=>value==="."||value===".."))knowledgeError("SOURCE_REPOSITORY_INVALID");
  return "https://github.com/"+match[1].toLowerCase()+"/"+match[2].toLowerCase();
}
function git(root:string,args:string[],optional=false,input?:string,limit=MAX_KNOWLEDGE_FILE_BYTES+1024):Buffer {
  const environment={...process.env};for(const name of Object.keys(environment))if(name.startsWith("GIT_"))delete environment[name];
  Object.assign(environment,{GIT_OPTIONAL_LOCKS:"0",GIT_TERMINAL_PROMPT:"0",GIT_NO_REPLACE_OBJECTS:"1",GIT_NO_LAZY_FETCH:"1",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:process.platform==="win32"?"NUL":"/dev/null"});
  try{return execFileSync("git",["-c","core.fsmonitor=false","-C",root,...args],{env:environment,windowsHide:true,timeout:10000,maxBuffer:limit,input,stdio:[input===undefined?"ignore":"pipe","pipe","pipe"]});}
  catch{if(optional)return Buffer.alloc(0);knowledgeError("SOURCE_GIT_UNAVAILABLE");}
}
function committedFiles(root:string,commit:string,paths:string[]){
  const tree=git(root,["ls-tree","-r","-z",commit,"--",...paths]).toString("utf8"),objects=new Map<string,string>();
  for(const item of tree.split("\0").filter(Boolean)){
    const match=/^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/.exec(item);if(!match)knowledgeError("SOURCE_GIT_ENTRY_UNSUPPORTED");objects.set(match[3],match[2]);
  }
  const ids=[...new Set(objects.values())],contents=new Map<string,Buffer>();
  if(ids.length){
    const output=git(root,["cat-file","--batch"],false,ids.join("\n")+"\n",MAX_KNOWLEDGE_IMPORT_BYTES+65536);let offset=0;
    for(const id of ids){
      const end=output.indexOf(10,offset);if(end<0)knowledgeError("SOURCE_GIT_UNAVAILABLE");
      const header=/^([a-f0-9]{40}|[a-f0-9]{64}) blob (\d+)$/.exec(output.subarray(offset,end).toString("ascii"));
      if(!header||header[1]!==id)knowledgeError("SOURCE_GIT_UNAVAILABLE");const length=Number(header[2]);
      if(!Number.isSafeInteger(length)||length>MAX_KNOWLEDGE_FILE_BYTES)knowledgeError("SOURCE_FILE_TOO_LARGE");
      offset=end+1;if(offset+length>=output.length||output[offset+length]!==10)knowledgeError("SOURCE_GIT_UNAVAILABLE");contents.set(id,output.subarray(offset,offset+length));offset+=length+1;
    }
    if(offset!==output.length)knowledgeError("SOURCE_GIT_UNAVAILABLE");
  }
  return new Map([...objects].map(([file,id])=>[file,contents.get(id)!]));
}
export function knowledgeGit(root:string,repository:string){
  const remote=git(root,["config","--local","--get","remote.origin.url"]).toString("utf8").trim();
  if(githubRepository(remote)!==githubRepository(repository))knowledgeError("SOURCE_REPOSITORY_MISMATCH");
  const partial=git(root,["config","--local","--get-regexp","^(remote\\..*\\.promisor|extensions\\.partialclone)$"],true);
  if(partial.length)knowledgeError("SOURCE_PARTIAL_CLONE_UNSUPPORTED");
  const top=fs.realpathSync.native(git(root,["rev-parse","--show-toplevel"]).toString("utf8").trim());
  if(top.toLowerCase()!==root.toLowerCase())knowledgeError("SOURCE_REPOSITORY_ROOT_REQUIRED");
  const commit=git(root,["rev-parse","--verify","HEAD^{commit}"]).toString("utf8").trim();
  if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))knowledgeError("SOURCE_GIT_UNAVAILABLE");
  return {repository:githubRepository(repository),commit};
}
export function importKnowledgeCode(input:KnowledgeCodeImport,previous?:KnowledgeCodeSource):KnowledgeCodeSource {
  const params=KnowledgeCodeImportSchema.parse(input),root=sourceRoot(params.root),paths=params.files.map(selectedKnowledgePath),overlays=params.overlayFiles.map(selectedKnowledgePath);
  if(new Set(paths.map(value=>value.toLowerCase())).size!==paths.length||overlays.some(value=>!paths.includes(value))||new Set(overlays).size!==overlays.length)knowledgeError("SOURCE_SELECTION_INVALID");
  if(params.kind==="local_folder"&&(params.repository||overlays.length)||params.kind==="github_checkout"&&!params.repository)knowledgeError("SOURCE_SELECTION_INVALID");
  const provenance=params.kind==="github_checkout"?knowledgeGit(root,params.repository!):undefined;
  const committed=provenance?committedFiles(root,provenance.commit,paths):undefined;let total=0;
  const files=paths.sort().map(relative=>{
    const read=readKnowledgeFile(root,relative);total+=read.bytes;if(total>MAX_KNOWLEDGE_IMPORT_BYTES)knowledgeError("SOURCE_TOO_LARGE");
    let origin:KnowledgeCodeSource["files"][number]["origin"]="local",commitSha256:string|undefined;
    if(provenance){
      const bytes=committed!.get(relative);commitSha256=bytes?sha256(bytes):undefined;
      if(bytes&&commitSha256===read.sha256)origin="commit";
      else if(bytes&&bytes.toString("utf8").replaceAll("\r\n","\n")===read.text.replaceAll("\r\n","\n"))origin="line_endings";
      else if(overlays.includes(relative))origin="overlay";
      else knowledgeError("SOURCE_OVERLAY_REQUIRED");
    }
    return {path:relative,sha256:read.sha256,bytes:read.bytes,origin,...(commitSha256?{commitSha256}:{})};
  });
  if(provenance&&knowledgeGit(root,params.repository!).commit!==provenance.commit)knowledgeError("SOURCE_CHANGED_DURING_READ");
  const now=new Date().toISOString();
  return {sourceId:previous?.sourceId??randomUUID(),kind:params.kind,label:params.label,root,revision:(previous?.revision??0)+1,createdAt:previous?.createdAt??now,updatedAt:now,files,digest:sha256(canonical({files,git:provenance})),...(provenance?{git:provenance}:{})};
}
export function verifyKnowledgeCode(source:KnowledgeCodeSource,withText=false){
  const root=sourceRoot(source.root);
  if(source.git&&knowledgeGit(root,source.git.repository).commit!==source.git.commit)knowledgeError("SOURCE_COMMIT_CHANGED");
  return source.files.map(file=>{const current=readKnowledgeFile(root,file.path);if(current.sha256!==file.sha256||current.bytes!==file.bytes)knowledgeError("SOURCE_STALE");return {path:file.path,sha256:file.sha256,...(withText?{text:current.text}:{})};});
}
