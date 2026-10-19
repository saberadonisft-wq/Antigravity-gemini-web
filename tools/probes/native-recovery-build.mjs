// Prepare independent, immutable dependency/build trees for the owned recovery fixture.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const receiptName = ".tmp/native-recovery-build.json";
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const git = (directory, ...args) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", windowsHide: true }).trim();
const normalize = filename => fs.realpathSync(filename).toLowerCase();
const workspacePaths = { contracts: "packages/contracts", "gemini-browser": "packages/gemini-browser", "mcp-server": "packages/mcp-server", "model-bridge": "packages/model-bridge", "native-antigravity": "packages/native-antigravity", runtime: "packages/runtime", launcher: "apps/launcher" };
const evidenceFiles = ["package-lock.json", "node_modules/.package-lock.json", "packages/contracts/dist/index.js", "packages/native-antigravity/dist/native-proxy.js", "packages/native-antigravity/dist/request-ledger.js", "packages/native-antigravity/dist/native-cli.js", "packages/mcp-server/dist/service.js", "packages/mcp-server/dist/receipt-store.js", "packages/gemini-browser/dist/index.js"];

function checkWorkspace(base, directory, role) {
  assert.ok(["baseline", "current"].includes(role));
  assert.equal(normalize(path.dirname(directory)), normalize(path.join(base, ".tmp")));
  assert.ok(!fs.lstatSync(directory).isSymbolicLink(), "Recovery build root cannot be a junction/link");
  assert.match(path.basename(directory), new RegExp("^p8-" + role + "-r[0-9]+-[a-f0-9]{7}-[a-f0-9]{32}$"));
  // A leftover directory without .git must never fall back to the parent checkout.
  assert.ok(fs.lstatSync(path.join(directory, ".git")).isFile(), "Expected a registered isolated worktree");
  assert.equal(normalize(git(directory, "rev-parse", "--show-toplevel")), normalize(directory));
  assert.equal(git(directory, "status", "--porcelain"), "", "Recovery build sources changed");
  return git(directory, "rev-parse", "HEAD");
}
export function verifyRecoveryBuild(base, directory, role) {
  const commit = checkWorkspace(base, directory, role);
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, receiptName), "utf8"));
  assert.equal(receipt.version, 1); assert.equal(receipt.role, role); assert.equal(receipt.commit, commit);
  assert.equal(receipt.install, "npm ci --ignore-scripts --prefer-offline --no-audit --no-fund");
  assert.equal(receipt.build, "npm run build"); assert.equal(receipt.installExitCode, 0); assert.equal(receipt.buildExitCode, 0);
  assert.deepEqual(Object.keys(receipt.sha256).sort(), evidenceFiles.slice().sort());
  for (const relative of evidenceFiles) assert.equal(hash(path.join(directory, relative)), receipt.sha256[relative], "Prepared build changed: " + relative);
  for (const [name, relative] of Object.entries(workspacePaths)) assert.equal(normalize(path.join(directory, "node_modules/@antigravity-gemini-web", name)), normalize(path.join(directory, relative)), "Cross-checkout workspace dependency");
  return receipt;
}

async function prepare(role, commit, expectedRevision) {
  const directory = path.join(repo, ".tmp", `p8-${role}-r${expectedRevision}-${commit.slice(0, 7)}-${randomUUID().replaceAll("-", "")}`);
  fs.mkdirSync(path.join(repo, ".tmp"), { recursive: true });
  git(repo, "worktree", "add", "--detach", directory, commit);
  checkWorkspace(repo, directory, role);
  const logs = path.join(directory, ".tmp"); fs.mkdirSync(logs);
  const npmCli = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  assert.ok(fs.existsSync(npmCli), "Run with the installed Node/npm distribution");
  const run = (name, args) => {
    const output = fs.openSync(path.join(logs, name + ".log"), "wx");
    try { execFileSync(process.execPath, [npmCli, ...args], { cwd: directory, windowsHide: true, timeout: 600000, stdio: ["ignore", output, output], env: { ...process.env, NODE_OPTIONS: "", ELECTRON_SKIP_BINARY_DOWNLOAD: "1" } }); }
    finally { fs.closeSync(output); }
  };
  console.log(`${role}: isolated npm ci`);
  run("install", ["ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"]);
  console.log(`${role}: full workspace build`); run("build", ["run", "build"]);
  const { NATIVE_RUNTIME_REVISION } = await import(pathToFileURL(path.join(directory, "packages/native-antigravity/dist/native-proxy.js")));
  assert.equal(NATIVE_RUNTIME_REVISION, expectedRevision); assert.equal(checkWorkspace(repo, directory, role), commit);
  const receipt = { version: 1, role, commit, runtimeRevision: NATIVE_RUNTIME_REVISION, checkedAt: new Date().toISOString(), install: "npm ci --ignore-scripts --prefer-offline --no-audit --no-fund", build: "npm run build", installExitCode: 0, buildExitCode: 0, node: process.version,
    sha256: Object.fromEntries(evidenceFiles.map(relative => [relative, hash(path.join(directory, relative))])) };
  fs.writeFileSync(path.join(directory, receiptName), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  verifyRecoveryBuild(repo, directory, role);
  console.log(`${role}: prepared revision ${expectedRevision}`);
  return directory;
}

if (process.argv[1] && normalize(process.argv[1]) === normalize(fileURLToPath(import.meta.url))) {
  const currentCommit = git(repo, "rev-parse", "HEAD"), baselineCommit = git(repo, "rev-parse", "4e28d7a");
  const { NATIVE_RUNTIME_REVISION } = await import(new URL("../../packages/native-antigravity/dist/native-proxy.js", import.meta.url));
  const baseline = await prepare("baseline", baselineCommit, 36);
  const current = await prepare("current", currentCommit, NATIVE_RUNTIME_REVISION);
  const report = path.join(repo, ".tmp/native-recovery-builds.json");
  fs.writeFileSync(report, JSON.stringify({ baseline, current, currentCommit, baselineCommit, retention: "KEEP_ISOLATED_BUILDS_FOR_REPRODUCTION_NO_PROCESS_RUNNING" }, null, 2) + "\n");
  console.log("Prepared build paths: " + report);
}
