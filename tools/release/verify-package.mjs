import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const name = `Antigravity-Gemini-Web-${version}-windows-x64`;
const archive = path.join(root, "release", name + ".zip");
const checksum = fs.readFileSync(path.join(root, "release/SHA256SUMS.txt"), "utf8").trim();
assert.equal(checksum, `${createHash("sha256").update(fs.readFileSync(archive)).digest("hex")}  ${name}.zip`);
// A path containing spaces and Vietnamese catches broken quoting and workspace links.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-release-kiểm thử-"));
const folder = path.join(temporary, name);
let child;
try {
  // Node sets the Unicode working directory through the Windows wide-char API.
  // Passing it as tar's -C argument loses Vietnamese characters on some Windows builds.
  execFileSync("tar.exe", ["-x", "-f", archive], { cwd: temporary, windowsHide: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, "release-manifest.json"), "utf8"));
  assert.equal(manifest.version, version);
  assert.equal(manifest.commit, execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim());
  const node = path.join(folder, "resources/node/node.exe");
  const application = path.join(folder, "resources/app");
  const cli = path.join(application, "packages/native-antigravity/dist/native-cli.js");
  const env = { ...process.env, USERPROFILE: path.join(temporary, "home"), LOCALAPPDATA: path.join(temporary, "local"), HOME: path.join(temporary, "home") };
  delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(env.USERPROFILE, { recursive: true });
  const accounts = JSON.parse(execFileSync(node, [cli, "accounts"], { cwd: temporary, env, encoding: "utf8", windowsHide: true }));
  assert.equal(accounts.total, 0, "A fresh package must not import developer accounts");
  // This is a synthetic installation fixture. Never launch a real IDE or send a Google prompt.
  const ide = path.join(env.LOCALAPPDATA, "Programs/Antigravity IDE/resources/app");
  const files = {
    "product.json": JSON.stringify({ ideVersion: "2.5.5", commit: "ecfbad74d93962fc8ca485d93ab9b4f3d4cb6cf8", nameShort: "Antigravity IDE", applicationName: "antigravity-ide" }),
    "package.json": JSON.stringify({ version: "1.107.0" }),
    "extensions/antigravity/package.json": JSON.stringify({ name: "antigravity", publisher: "google" }),
    "out/main.js": 'cloudCodeUrlOverride:this._configurationService.getValue("jetski.cloudCodeUrl") this.makePostRequest("v1internal:fetchAvailableModels",',
    "extensions/antigravity/dist/extension.js": '"--cloud_code_endpoint"'
  };
  for (const [file, contents] of Object.entries(files)) { const target = path.join(ide, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, contents); }
  fs.writeFileSync(path.resolve(ide, "../../Antigravity IDE.exe"), "synthetic placeholder; do not execute");
  const checked = JSON.parse(execFileSync(node, [cli, "check"], { cwd: temporary, env, encoding: "utf8", windowsHide: true }));
  assert.equal(checked.ideVersion, "2.5.5");
  // Port 0 and temporary state avoid the user's live owner on port 9236.
  const harness = `
    import {startNativeProxy} from ${JSON.stringify(pathToFileURL(path.join(application, "packages/native-antigravity/dist/native-proxy.js")).href)};
    import {AccountRegistry} from ${JSON.stringify(pathToFileURL(path.join(application, "packages/native-antigravity/dist/account-registry.js")).href)};
    import {NativeBrowserBackendPool} from ${JSON.stringify(pathToFileURL(path.join(application, "packages/native-antigravity/dist/browser-backend-pool.js")).href)};
    const registry=new AccountRegistry(${JSON.stringify(path.join(temporary, "runtime/accounts.json"))});
    const backend=new NativeBrowserBackendPool(registry,${JSON.stringify(path.join(application, "packages/mcp-server/dist/cli.js"))});
    const proxy=await startNativeProxy({port:0,backend,accountRegistry:registry,stateDirectory:${JSON.stringify(path.join(temporary, "runtime"))},controlToken:'a'.repeat(64)});
    const health=await (await fetch('http://127.0.0.1:'+proxy.port+'/__native/health')).json();
    if(health.service!=='gemini-native-proxy'||health.counters.active!==0)throw Error('Packaged owner failed');
    await proxy.close(); console.log(JSON.stringify({packagedOwner:true,emptyRegistry:true,liveGoogleRequests:0}));
  `;
  const script = path.join(temporary, "runtime-check.mjs");
  fs.writeFileSync(script, harness);
  const runtime = JSON.parse(execFileSync(node, [script], { cwd: temporary, env, encoding: "utf8", windowsHide: true, timeout: 20000 }));
  assert.equal(runtime.packagedOwner, true);
  const smoke = path.join(root, "apps/launcher/scripts/native-accounts-smoke.mjs");
  const exe = path.join(folder, "Antigravity Gemini Web.exe");
  child = spawn(process.execPath, [smoke, "--packaged=" + exe, "--evidence=" + path.join(root, ".tmp/release-smoke")], { cwd: root, env, windowsHide: true, stdio: "inherit" });
  const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  assert.equal(code, 0, "Extracted executable must pass the desktop acceptance suite");
  console.log(JSON.stringify({ status: "PASS", extractedZip: true, bundledNode: true, ...runtime, packagedElectron: true }));
} finally {
  if (child && child.exitCode === null) child.kill();
  const resolved = fs.realpathSync(temporary);
  if (path.dirname(resolved).toLowerCase() !== fs.realpathSync(os.tmpdir()).toLowerCase() || !path.basename(resolved).startsWith("gemini-release-")) throw Error("Unexpected package verification cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
