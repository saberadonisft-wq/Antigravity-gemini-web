// Actual hidden Electron/Native/worker fixture; no Google or OS chooser automation.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { AccountRegistry } from "../../../packages/native-antigravity/dist/account-registry.js";
import { startNativeProxy } from "../../../packages/native-antigravity/dist/native-proxy.js";
import { sha256 } from "../../../packages/native-antigravity/dist/native-protocol.js";
import { writeSyntheticChatArchive } from "../../../packages/native-antigravity/dist/testing/chat-import-archive.fixture.js";

const appRoot = fileURLToPath(new URL("../", import.meta.url)), temporary = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-smoke-native-imports-"));
const archive = await writeSyntheticChatArchive(temporary);
fs.writeFileSync(path.join(temporary, "imports-dialog.json"), JSON.stringify({ canceled: false, filePaths: [archive] }));
const registry = new AccountRegistry(path.join(temporary, "accounts.json"));
for (const label of ["A", "B"]) registry.add({ displayName: "Fixture " + label, profilePath: path.join(temporary, "profile" + label), statePath: path.join(temporary, "state" + label), identityFingerprint: sha256(label) });
let generations = 0;
const token = randomBytes(32).toString("hex"), proxy = await startNativeProxy({ port: 0, accountRegistry: registry, stateDirectory: path.join(temporary, "native"), controlToken: token, importsExperimental: true, backend: { generate: async () => { generations++; throw Error("Import preview must not enter model generation"); }, close: async () => {} } });
fs.writeFileSync(path.join(temporary, "native-owner.json"), JSON.stringify({ version: 1, pid: process.pid, endpoint: "http://127.0.0.1:" + proxy.port, controlToken: token }));
const environment = { ...process.env, AG_LAUNCHER_SMOKE: "1", AG_NATIVE_ACCOUNTS_SMOKE: "1", AG_NATIVE_IMPORTS_SMOKE: "1", AG_LAUNCHER_DATA_DIR: temporary, ELECTRON_ENABLE_LOGGING: "0" }; delete environment.ELECTRON_RUN_AS_NODE; delete environment.NODE_OPTIONS;
const require = createRequire(import.meta.url), child = spawn(require("electron"), [appRoot], { cwd: appRoot, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let output = "", timer; child.stdout.on("data", bytes => { output = (output + String(bytes)).slice(-12000); }); child.stderr.on("data", bytes => { output = (output + String(bytes)).slice(-12000); });
const exited = new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
try {
  const code = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Import desktop deadline")), 60000); })]);
  const file = path.join(temporary, "native-chat-import-desktop.json");
  if (code !== 0 || !fs.existsSync(file)) { console.error(output); throw Error("Import desktop failed: " + code); }
  assert.equal(generations, 0);
  const evidence = path.resolve(process.argv.find(value => value.startsWith("--evidence="))?.slice(11) ?? path.join(appRoot, "../../docs/evidence/p7b-native-imports-r38")); fs.mkdirSync(evidence, { recursive: true });
  const result = { ...JSON.parse(fs.readFileSync(file, "utf8")), nativeGenerations: generations, realGooglePromptRequests: 0 };
  fs.writeFileSync(path.join(evidence, "native-chat-import-desktop.json"), JSON.stringify(result, null, 2) + "\n");
  for (const name of fs.readdirSync(temporary).filter(name => /^imports-[a-z0-9-]+\.png$/.test(name))) fs.copyFileSync(path.join(temporary, name), path.join(evidence, name));
  console.log(JSON.stringify(result));
} finally {
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) { child.kill(); let stopTimer; try { await Promise.race([exited, new Promise((_, reject) => { stopTimer = setTimeout(() => reject(Error("Owned Electron exit deadline")), 5000); })]); } finally { clearTimeout(stopTimer); } }
  await proxy.close();
  const target = fs.realpathSync(temporary); assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase()); assert.match(path.basename(target), /^launcher-smoke-native-imports-/);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
