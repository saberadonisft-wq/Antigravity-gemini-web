import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1"));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-smoke-"));
const require = createRequire(import.meta.url);
const executable = require("electron");
const environment = { ...process.env, AG_LAUNCHER_SMOKE: "1", AG_LAUNCHER_DATA_DIR: temporary, ELECTRON_ENABLE_LOGGING: "0" };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.NODE_OPTIONS;
const child = spawn(executable, [root], { cwd: root, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", data => { output += data; });
child.stderr.on("data", data => { output += data; });
let timeout;
try {
  const code = await Promise.race([
    new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }),
    new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Desktop suite deadline")), 90000); }),
  ]);
  if (code !== 0 || !fs.existsSync(path.join(temporary, "desktop-smoke.json"))) {
    console.error(output); throw new Error("Desktop smoke failed: " + code);
  }
  if (/Unable to move the cache|Unable to create cache|Gpu Cache Creation failed/i.test(output)) {
    console.error(output); throw new Error("Chromium cache startup failed.");
  }
  const evidenceArgument=process.argv.find(argument=>argument.startsWith("--evidence="))?.slice("--evidence=".length);
  const evidence = evidenceArgument?path.resolve(evidenceArgument):path.resolve(root, "../../docs/evidence/g4-desktop-smoke");
  fs.mkdirSync(evidence, { recursive: true });
  const lifecycle = JSON.parse(fs.readFileSync(path.join(temporary, "desktop-lifecycle.json"), "utf8"));
  if (!lifecycle.pendingClose || !lifecycle.noLateExport || lifecycle.subscriptionsAfterClose !== 0) throw new Error("Lifecycle evidence incomplete.");
  for (const file of fs.readdirSync(temporary).filter(file => file.endsWith(".png") || ["desktop-smoke.json", "desktop-lifecycle.json", "desktop-ui.json", "desktop-dialog.json"].includes(file))) fs.copyFileSync(path.join(temporary, file), path.join(evidence, file));
  console.log("Desktop smoke PASS. Evidence:", evidence);
} finally {
  clearTimeout(timeout);
  if (child.exitCode === null) {
    await promisify(execFile)("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true, timeout: 5000 });
  }
  const resolved = fs.realpathSync(temporary);
  if (path.dirname(resolved).toLowerCase() !== fs.realpathSync(os.tmpdir()).toLowerCase() || !path.basename(resolved).startsWith("launcher-smoke-")) throw new Error("Invalid cleanup target.");
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
