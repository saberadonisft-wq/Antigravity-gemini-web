// Owned-process benchmark only. Never loaded by the production browser CLI.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { getHeapSpaceStatistics } from "node:v8";
import { startSharedRuntime, runtimeFingerprint } from "../../../packages/mcp-server/dist/shared-stdio.js";
import { GeminiMcpService } from "../../../packages/mcp-server/dist/service.js";
import { createGeminiMcpServer } from "../../../packages/mcp-server/dist/server.js";

const [rootArgument, label, semiSpace] = process.argv.slice(2);
const root = fs.realpathSync(rootArgument);
assert.equal(path.dirname(root).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
assert.match(path.basename(root), /^ag-mcp-memory-/);
assert.ok(["A", "B"].includes(label));
assert.ok(["off", "8", "16"].includes(semiSpace));
assert.equal(typeof global.gc, "function");
const memoryArgs = process.execArgv.filter(value => /^--(?:max-semi-space-size|expose-gc)(?:=|$)/.test(value));
assert.deepEqual(memoryArgs, ["--expose-gc", ...(semiSpace === "off" ? [] : ["--max-semi-space-size=" + semiSpace])]);
const scope = `memory-fixture:${root}:${label}`;
const fingerprint = runtimeFingerprint({ version: 1, root, label, semiSpace });
const descriptorFile = path.join(root, label + "-owner.json");
const active = new Map();
let submissions = 0, completions = 0, inputChars = 0, maxInputChars = 0, gcMs = 0;
const hash = text => createHash("sha256").update(text).digest("hex");
const browser = {
  checkStatus: async () => ({ browserState: "ready", accountState: "signed_in", accountIdentity: hash("synthetic:" + label), checkedAt: new Date().toISOString() }),
  openBrowser: async () => ({ opened: false }),
  submitPrompt: async (turnId, text) => {
    assert.equal(active.size, 0);
    submissions++; inputChars += text.length; maxInputChars = Math.max(maxInputChars, text.length);
    active.set(turnId, hash(text));
    return { turnId, submittedAt: new Date().toISOString(), status: "accepted" };
  },
  pollResponse: async turnId => {
    const digest = active.get(turnId); assert.ok(digest); active.delete(turnId); completions++;
    // Unique large results exercise the real bounded result cache and JSON transport.
    return { turnId, status: "completed", text: `SYNTHETIC:${label}:${digest}\n` + digest.repeat(375), completedAt: new Date().toISOString() };
  },
  cancelPrompt: async turnId => { active.delete(turnId); return { requested: true, confirmed: true }; },
  cleanup: async () => { active.clear(); },
  sendPrompt: async () => { throw Error("Legacy send path is not part of the memory fixture"); },
};
const service = new GeminiMcpService(browser, path.join(root, label + "-receipts.json"));
const owner = await startSharedRuntime({
  scope, descriptorFile, fingerprint,
  createRuntime: async () => ({
    createServer: () => {
      const server = createGeminiMcpServer(service);
      server.registerTool("fixture_process_memory", {
        description: "Synthetic benchmark process diagnostics; no project or browser data.", inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      }, async () => {
        assert.equal(active.size, 0);
        await new Promise(resolve => setImmediate(resolve));
        const start = performance.now(); global.gc(); global.gc(); gcMs += performance.now() - start;
        const result = {
          pid: process.pid, owner: label, semiSpace, nodeVersion: process.version, v8Version: process.versions.v8,
          memoryArgs, memory: process.memoryUsage(), heapSpaces: getHeapSpaceStatistics(), cpuUsageUs: process.cpuUsage(),
          explicitGcMs: Math.round(gcMs), submissions, completions, inputChars, maxInputChars, activeSyntheticTurns: active.size,
        };
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      });
      return server;
    },
    close: () => service.close(),
  }),
});
process.on("message", message => { if (message?.action === "stop") void owner.close().catch(() => { process.exitCode = 1; }); });
process.send?.({ ready: true, pid: process.pid, scope, descriptorFile, fingerprint });
try { await owner.closed; } finally { process.disconnect?.(); }
