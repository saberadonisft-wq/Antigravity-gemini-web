// Synthetic loopback caller -> real Gemini Web -> native functionCall/text.
// No IDE executor or workspace files are used by this probe.
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { NATIVE_RUNTIME_REVISION } from "../../packages/native-antigravity/dist/native-proxy.js";

const endpoint = "http://127.0.0.1:9236";
const health = () => fetch(endpoint + "/__native/health", { signal: AbortSignal.timeout(2000) }).then(r => r.json());
const initial = await health();
if (!process.argv.includes("--live")) {
  console.log(JSON.stringify({ runtimeRevision: initial.runtimeRevision, active: initial.counters.active, livePromptsSent: 0 }));
} else {
  assert.equal(initial.runtimeRevision, NATIVE_RUNTIME_REVISION);
  assert.equal(initial.counters.active, 0);
  const evidence = { checkedAt: new Date().toISOString(), runtimeRevision: initial.runtimeRevision, caller: "synthetic_loopback_client", browser: "real_Gemini_Web", ideExecutor: "NOT_TESTED", status: "RUNNING", turns: [] };
  const sessionId = "completion_" + randomUUID();
  const marker = "NATIVE_RESPONSE_COMPLETE_" + randomUUID().replaceAll("-", "").slice(0, 8);
  const contents = [{ role: "user", parts: [{ text: "Synthetic test: request view_file with AbsolutePath D:/synthetic-completion-fixture.txt. After its functionResponse, reply exactly with the marker it supplies. Do not claim to have read a real file." }] }];
  const declaration = { name: "view_file", description: "Request a synthetic fixture response from this test caller.", parameters: { type: "object", properties: { AbsolutePath: { type: "string" } }, required: ["AbsolutePath"], additionalProperties: false } };
  async function turn(mode) {
    const started = performance.now();
    const response = await fetch(endpoint + "/v1internal:streamGenerateContent?alt=sse", {
      method: "POST", headers: { authorization: "Bearer synthetic-completion-test", "content-type": "application/json" },
      body: JSON.stringify({ model: "antigravity-gemini-web", sessionId, request: { contents, tools: [{ functionDeclarations: [declaration] }], toolConfig: { functionCallingConfig: { mode } } } }),
      signal: AbortSignal.timeout(90000),
    });
    const body = await response.text();
    let errorCode;
    if (!response.ok) { try { const error = JSON.parse(body).error; errorCode = error?.details?.[0]?.reason ?? error?.status; } catch {} }
    const frames = body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    const parts = frames.flatMap(frame => frame.response?.candidates?.[0]?.content?.parts ?? []);
    const status = await health();
    evidence.turns.push({ httpStatus: response.status, errorCode, elapsedMs: Math.round(performance.now() - started), frames: frames.length, functionCalls: parts.filter(p => p.functionCall).length, textChars: parts.map(p => p.text ?? "").join("").length, lastTurn: status.lastTurn });
    assert.equal(response.status, 200);
    assert.equal(status.lastTurn.phase, "completed");
    return parts;
  }
  try {
    const first = await turn("ANY");
    assert.equal(first.length, 1);
    const call = first[0].functionCall;
    assert.equal(call.name, "view_file");
    assert.deepEqual(call.args, { AbsolutePath: "D:/synthetic-completion-fixture.txt" });
    contents.push({ role: "model", parts: [{ functionCall: call }] }, { role: "user", parts: [{ functionResponse: { name: call.name, id: call.id, response: { marker } } }] });
    const second = await turn("AUTO");
    assert.equal(second.map(part => part.text ?? "").join("").trim(), marker);
    assert.equal(second.some(part => part.functionCall), false);
    evidence.replyMatches = true;
    evidence.status = "PASS_NATIVE_PROTOCOL_AND_REAL_BROWSER";
  } catch (error) {
    evidence.status = "FAILED";
    evidence.error = error instanceof assert.AssertionError ? "ASSERTION_FAILED" : error?.name === "TimeoutError" ? "PROBE_DEADLINE" : "PROBE_FAILED";
    evidence.lastTurn = (await health()).lastTurn;
    process.exitCode = 1;
  }
  const output = process.argv.find(arg => arg.startsWith("--output="))?.slice("--output=".length) ?? "docs/evidence/mcp/native-response-completion-live.json";
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence));
}
