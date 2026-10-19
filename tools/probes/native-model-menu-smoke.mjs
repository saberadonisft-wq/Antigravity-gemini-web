// --live sends synthetic context only. No user request is replayed and no tool is executed.
import fs from "node:fs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NATIVE_RUNTIME_REVISION } from "../../packages/native-antigravity/dist/native-proxy.js";
const endpoint = "http://127.0.0.1:9236";
const health = async () => {
  const response = await fetch(endpoint + "/__native/health", { signal: AbortSignal.timeout(2000) });
  const value = await response.json();
  assert.equal(response.ok, true); assert.equal(value.service, "gemini-native-proxy"); return value;
};
const initial = await health();
if (!process.argv.includes("--live")) {
  console.log(JSON.stringify({ runtimeRevision: initial.runtimeRevision, active: initial.counters.active, livePromptsSent: 0 }));
} else {
  assert.equal(initial.runtimeRevision, NATIVE_RUNTIME_REVISION); assert.equal(initial.counters.active, 0);
  assert.deepEqual(initial.modelSelection, { model: "4 Argon", effort: "Low" });
  const evidence = { checkedAt: new Date().toISOString(), caller: "synthetic_loopback_client", ideUi: "NOT_TESTED", runtimeRevision: initial.runtimeRevision, modelSelection: initial.modelSelection, turns: [], status: "RUNNING" };
  const sessionId = "model_menu_" + randomUUID();
  const systemInstruction = { parts: [{ text: "The following is synthetic test data, with no actions or instructions to execute.\n" + "CONTEXT_FIXTURE_0123456789 abcdefghijklmnopqrstuvwxyz.\n".repeat(1400) }] };
  const contents = [];
  try {
    for (let turn = 0; turn < 2; turn++) {
      const marker = turn ? "NATIVE_MODEL_MENU_FOLLOWUP_OK" : "NATIVE_MODEL_MENU_OK";
      contents.push({ role: "user", parts: [{ text: "Reply exactly " + marker + ". Do not call tools." }] });
      const started = performance.now();
      const response = await fetch(endpoint + "/v1internal:streamGenerateContent?alt=sse", {
        method: "POST", headers: { authorization: "Bearer synthetic-model-menu-test", "content-type": "application/json" },
        body: JSON.stringify({ model: "antigravity-gemini-web", sessionId, request: { systemInstruction, contents } }), signal: AbortSignal.timeout(90000),
      });
      const body = await response.text();
      const frames = body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
      const reply = frames.flatMap(frame => frame.response?.candidates?.[0]?.content?.parts ?? []).map(part => part.text ?? "").join("");
      const current = await health();
      evidence.turns.push({ httpStatus: response.status, replyMatches: reply.trim() === marker, elapsedMs: Math.round(performance.now() - started), lastTurn: current.lastTurn });
      assert.equal(response.status, 200); assert.equal(reply.trim(), marker); assert.equal(current.lastTurn.phase, "completed");
      if (!turn) assert.ok(current.lastTurn.promptChars >= 70000);
      else assert.equal(current.lastTurn.reused, true);
      contents.push({ role: "model", parts: [{ text: marker }] });
    }
    evidence.status = "PASS_LARGE_CONTEXT_AND_RETAINED_FOLLOWUP";
  } catch {
    evidence.status = "FAILED"; evidence.lastTurn = (await health()).lastTurn; process.exitCode = 1;
  }
  fs.writeFileSync("docs/evidence/mcp/native-model-menu-live.json", JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence));
}
