// Explicit --live sends one synthetic prompt. No IDE UI or host tools are exercised.
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { NATIVE_RUNTIME_REVISION } from "../../packages/native-antigravity/dist/native-proxy.js";
const endpoint = "http://127.0.0.1:9236";
const health = async () => {
  const value = await (await fetch(endpoint + "/__native/health", { signal: AbortSignal.timeout(2000) })).json();
  assert.equal(value.service, "gemini-native-proxy"); return value;
};
const initial = await health();
if (!process.argv.includes("--live")) console.log(JSON.stringify({ runtimeRevision: initial.runtimeRevision, active: initial.counters.active, livePromptsSent: 0 }));
else {
  assert.equal(initial.runtimeRevision, NATIVE_RUNTIME_REVISION); assert.equal(initial.counters.active, 0);
  const evidence = { checkedAt: new Date().toISOString(), caller: "synthetic_loopback_client", ideUi: "NOT_TESTED", runtimeRevision: initial.runtimeRevision, status: "RUNNING" };
  try {
    const debug = await fetch("http://127.0.0.1:9223/json/list", { signal: AbortSignal.timeout(1500) }).then(r => r.ok, () => false);
    evidence.before = { debugBrowserReachable: debug };
    const started = performance.now();
    const response = await fetch(endpoint + "/v1internal:streamGenerateContent?alt=sse", {
      method: "POST", headers: { authorization: "Bearer synthetic-autostart-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "antigravity-gemini-web", sessionId: "autostart_" + randomUUID(), request: { contents: [{ role: "user", parts: [{ text: "Reply exactly NATIVE_AUTOSTART_OK. No tools." }] }] } }),
      signal: AbortSignal.timeout(90000),
    });
    evidence.httpStatus = response.status;
    const body = await response.text();
    const frames = body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    const text = frames.flatMap(frame => frame.response?.candidates?.[0]?.content?.parts ?? []).map(part => part.text ?? "").join("");
    evidence.elapsedMs = Math.round(performance.now() - started); evidence.replyMatches = text.trim() === "NATIVE_AUTOSTART_OK";
    evidence.lastTurn = (await health()).lastTurn;
    assert.equal(response.status, 200); assert.equal(evidence.replyMatches, true); assert.equal(evidence.lastTurn.phase, "completed");
    evidence.status = "PASS_BROWSER_AUTOSTART_AND_REPLY";
  } catch { evidence.status = "FAILED"; evidence.lastTurn = (await health()).lastTurn; process.exitCode = 1; }
  fs.writeFileSync("docs/evidence/mcp/native-autostart-live.json", JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence));
}
