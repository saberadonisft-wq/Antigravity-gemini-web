// Adversarial validation of prepared builds, before starting any recovery owner.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { verifyRecoveryBuild } from "./native-recovery-build.mjs";

const repo=fileURLToPath(new URL("../../",import.meta.url));
const arg=(name,fallback)=>process.argv.find(value=>value.startsWith(name+"="))?.slice(name.length+1)??fallback;
const builds=JSON.parse(fs.readFileSync(path.resolve(arg("--builds",path.join(repo,".tmp/native-recovery-builds.json"))),"utf8"));
const baseline=verifyRecoveryBuild(repo,builds.baseline,"baseline"),current=verifyRecoveryBuild(repo,builds.current,"current");
assert.notEqual(baseline.sha256["package-lock.json"],current.sha256["package-lock.json"],"This regression must exercise the added ZIP dependency lockfile");
assert.throws(()=>verifyRecoveryBuild(repo,builds.baseline,"current"));

function changed(relative,expected) {
  const file=path.join(builds.current,relative),bytes=fs.readFileSync(file);
  try {fs.appendFileSync(file,"\n ");assert.throws(()=>verifyRecoveryBuild(repo,builds.current,"current"),expected);}
  finally {fs.writeFileSync(file,bytes);}
  verifyRecoveryBuild(repo,builds.current,"current");
}
changed("packages/native-antigravity/dist/request-ledger.js",/Prepared build changed/);
changed("node_modules/.package-lock.json",/Prepared build changed/);
changed("packages/native-antigravity/src/native-proxy.ts",/Recovery build sources changed/);
const orphan=path.join(repo,".tmp",`p8-current-r${current.runtimeRevision}-${current.commit.slice(0,7)}-${randomUUID().replaceAll("-","")}`);
fs.mkdirSync(orphan);
try {assert.throws(()=>verifyRecoveryBuild(repo,orphan,"current"),{code:"ENOENT"});}
finally {
  assert.equal(fs.realpathSync(path.dirname(orphan)).toLowerCase(),fs.realpathSync(path.join(repo,".tmp")).toLowerCase());
  fs.rmdirSync(orphan); // Empty test directory only; never recurse or traverse a workspace junction.
}
const result={checkedAt:new Date().toISOString(),status:"PASS_RECOVERY_BUILD_AUTHORITY",wrongRoleRejected:true,compiledMutationRejected:true,installedLockMutationRejected:true,trackedSourceMutationRejected:true,orphanParentFallbackRejected:true,originalBuildsReverified:true,independentDifferentLockfiles:true,startedNativeOwners:0,realGooglePromptRequests:0};
const output=path.resolve(arg("--output",path.join(repo,".tmp/native-recovery-provenance.json")));
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify(result));
