import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runBundledCommand } from "./packaged-runtime.js";

test("Bundled runtime handles paths as arguments, removes Node injection variables and redacts command failures", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-bundled-runtime-"));
  const resources = path.join(temporary, "resources có dấu");
  const cli = path.join(resources, "app/packages/native-antigravity/dist/native-cli.js");
  const node = path.join(resources, "node/node.exe");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.mkdirSync(path.dirname(node), { recursive: true });
  try { fs.linkSync(process.execPath, node); } catch { fs.copyFileSync(process.execPath, node); }
  fs.writeFileSync(cli, `
    const fs = require('node:fs');
    if (process.env.NODE_OPTIONS || process.env.NODE_PATH || process.env.ELECTRON_RUN_AS_NODE) throw Error('Inherited injection');
    if (process.argv[2] === 'stop') { console.error(JSON.stringify({code:'PROXY_ACTIVE',message:'PRIVATE_MARKER'})); process.exit(1); }
    fs.writeFileSync('result.json', JSON.stringify(process.argv.slice(2)));
  `);
  const keys = ["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE"] as const;
  const previous = keys.map(key => process.env[key]);
  try {
    for (const key of keys) process.env[key] = "must-not-reach-child";
    const workspace = path.join(temporary, "dự án & literal-command");
    await runBundledCommand(resources, "launch", workspace);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(resources, "app/result.json"), "utf8")), ["launch", "--workspace", workspace]);
    await assert.rejects(runBundledCommand(resources, "stop"), error => error instanceof Error && error.message === "PROXY_ACTIVE" && !String(error).includes("PRIVATE_MARKER"));
    await assert.rejects(runBundledCommand(path.join(temporary, "missing"), "ensure"), { message: "BUNDLED_RUNTIME_MISSING" });
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    const resolved = fs.realpathSync(temporary);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith("launcher-bundled-runtime-"));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
