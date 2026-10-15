import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const live = process.argv.includes("--live");
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "packages/mcp-server/dist/cli.js")], stderr: "pipe" });
const client = new Client({ name: "gemini-owned-mcp-probe", version: "0.1.0" });
const evidence = { observedAt: new Date().toISOString(), mode: live ? "google_live" : "status_only", handshake: false, tools: [], liveTurn: "NOT_TESTED", cleanup: false };
const watchdog = setTimeout(() => { console.error("MCP probe exceeded 90 second budget."); void client.close().finally(() => { process.exitCode = 1; }); }, 90000);
const decode = result => {
  const value = JSON.parse(result.content[0].text);
  if (result.isError) throw Object.assign(new Error(value.message), { code: value.code });
  return value;
};
try {
  await client.connect(transport); evidence.handshake = true;
  evidence.tools = (await client.listTools()).tools.map(t => t.name);
  evidence.initialStatus = decode(await client.callTool({ name: "gemini_status", arguments: {} }));
  if (live) {
    let status = decode(await client.callTool({ name: "gemini_open_browser", arguments: {} }));
    const readyDeadline = performance.now() + 12000;
    while (status.browserState !== "ready" && performance.now() < readyDeadline) {
      await new Promise(resolve => setTimeout(resolve, 400));
      status = decode(await client.callTool({ name: "gemini_status", arguments: {} }));
    }
    evidence.openStatus = status;
    if (status.browserState !== "ready" || status.accountState !== "signed_in") {
      evidence.liveTurn = status.accountState === "signed_in" ? "SURFACE_NOT_READY" : "NEEDS_USER_ACTION";
    } else {
      evidence.turns = [];
      const cases = [
        { name: "plain_text", prompt: marker => `Connectivity test. Reply with exactly this text and nothing else: ${marker}`, verify: (text, marker) => text.trim() === marker },
        { name: "markdown", prompt: marker => `Connectivity test. Reply with exactly one Markdown heading containing ${marker} and a list with the single item ready.`, verify: (text, marker) => text.includes(marker) && text.includes("ready") },
        { name: "code", prompt: marker => `Connectivity test. Reply with only a JavaScript code block containing console.log("${marker}");`, verify: (text, marker) => text.includes(marker) && text.includes("console.log") },
      ];
      for (const scenario of cases) {
        const marker = "MCP_LIVE_OK_" + randomUUID().replaceAll("-", "").slice(0, 12);
        const request_id = "probe_" + randomUUID().replaceAll("-", "");
        const prompt = scenario.prompt(marker);
        decode(await client.callTool({ name: "gemini_submit", arguments: { request_id, prompt } }));
        let result;
        const deadline = performance.now() + 20000;
        do { result = decode(await client.callTool({ name: "gemini_result", arguments: { request_id, wait_ms: 5000 } })); }
        while (result.status === "pending" && performance.now() < deadline);
        const passed = result.status === "completed" && scenario.verify(result.text, marker);
        evidence.turns.push({ scenario: scenario.name, status: result.status, errorCode: result.error?.code, responseChars: result.text?.length ?? 0, modelDetected: result.modelDetected, verdict: passed ? "PASS" : "FAILED", responseHash: createHash("sha256").update(result.text ?? "").digest("hex") });
        if (!passed) break;
      }
      evidence.liveTurn = evidence.turns.length === 3 && evidence.turns.every(t => t.verdict === "PASS") ? "PASS" : "FAILED";
      if (evidence.liveTurn !== "PASS") process.exitCode = 1;
    }
  }
} catch (error) {
  evidence.errorCode = typeof error.code === "string" ? error.code : "PROBE_FAILED";
  process.exitCode = 1;
} finally {
  try { await client.close(); evidence.cleanup = true; } catch { evidence.cleanup = false; process.exitCode = 1; }
  clearTimeout(watchdog);
  // Only synthetic test metadata, never prompts, account names, cookies or raw response text.
  const target = path.join(root, "docs/evidence/mcp"); fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, live ? "google-live.json" : "status.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
