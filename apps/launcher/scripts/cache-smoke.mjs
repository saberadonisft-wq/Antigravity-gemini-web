import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const launcher = fileURLToPath(new URL("../", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-cache-check-"));
const environment = { ...process.env, AG_CACHE_SMOKE_DIR: root };
delete environment.ELECTRON_RUN_AS_NODE; delete environment.NODE_OPTIONS;
const children = [];
function launch(args = []) {
  const child = spawn(require("electron"), [path.join(launcher, "dist/main/cache-smoke-main.js"), ...args], { env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => output += data); child.stderr.on("data", data => output += data);
  const done = new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  done.catch(() => {});
  const instance = { child, done, output: () => output }; children.push(instance); return instance;
}
async function wait(check, instance) {
  const deadline = performance.now() + 8000;
  while (!check()) {
    if (instance.child.exitCode !== null || performance.now() >= deadline) throw new Error("Cache probe startup failed: " + instance.output());
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
async function exited(instance) {
  let timer;
  try {
    assert.equal(await Promise.race([instance.done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Cache probe exit deadline")), 5000); })]), 0, instance.output());
    assert.doesNotMatch(instance.output(), /Unable to move the cache|Unable to create cache|Gpu Cache Creation failed/i);
  } finally { clearTimeout(timer); }
}
let failure;
try {
  const first = launch(); await wait(() => fs.existsSync(path.join(root, "first.json")), first);
  const second = launch(["--secondary"]); await exited(second);
  await wait(() => fs.existsSync(path.join(root, "second-instance.json")), first);
  fs.writeFileSync(path.join(root, "close-first"), "close"); await exited(first);
  const restart = launch(["--restart"]); await wait(() => fs.existsSync(path.join(root, "restart.json")), restart);
  fs.writeFileSync(path.join(root, "close-restart"), "close"); await exited(restart);
  const before = JSON.parse(fs.readFileSync(path.join(root, "first.json"), "utf8"));
  const after = JSON.parse(fs.readFileSync(path.join(root, "restart.json"), "utf8"));
  assert.equal(before.rendered && after.rendered, true);
  assert.equal(before.userData, after.userData); assert.equal(before.sessionData, after.sessionData);
  assert.equal(before.sessionData, path.join(before.userData, "session"));
  assert.equal(before.userData, path.join(root, "home/.gemini/antigravity-gemini-web-live/electron"));
  console.log("Electron cache PASS: rendered first launch, concurrent second instance and profile restart; no cache errors.");
} catch (error) { failure = error; }
finally {
  try {
  for (const { child } of children) if (child.exitCode === null && child.pid) await promisify(execFile)("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true, timeout: 5000 });
  const resolved = fs.realpathSync(root);
  if (path.dirname(resolved).toLowerCase() !== fs.realpathSync(os.tmpdir()).toLowerCase() || !path.basename(resolved).startsWith("launcher-cache-check-")) throw new Error("Invalid cache cleanup target.");
  await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) { failure = failure ? new AggregateError([failure, error], "Cache test and cleanup failed") : error; }
}
if (failure) throw failure;
