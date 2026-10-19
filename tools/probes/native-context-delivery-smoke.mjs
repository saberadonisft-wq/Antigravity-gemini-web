// Real browser test with synthetic long context only; no IDE file access.
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { NATIVE_RUNTIME_REVISION } from "../../packages/native-antigravity/dist/native-proxy.js";
const endpoint = "http://127.0.0.1:9236";
const health = () => fetch(endpoint + "/__native/health", { signal: AbortSignal.timeout(2000) }).then(r => r.json());
const initial = await health();
if (!process.argv.includes("--live")) console.log(JSON.stringify({ runtimeRevision: initial.runtimeRevision, livePromptsSent: 0 }));
else {
  assert.equal(initial.runtimeRevision, NATIVE_RUNTIME_REVISION); assert.equal(initial.counters.active, 0);
  const markers = ["START_", "MIDDLE_", "END_"].map(prefix => prefix + randomUUID().replaceAll("-", "").slice(0, 12));
  const padding = "Synthetic fixture context. ".repeat(1400);
  const system = `Synthetic context integrity test. The three marker values, in order, are:\n${markers[0]}\n${padding}\n${markers[1]}\n${padding}\n${markers[2]}`;
  const evidence = { checkedAt: new Date().toISOString(), runtimeRevision: initial.runtimeRevision, caller: "synthetic_loopback_client", browser: "real_Gemini_Web", ideExecutor: "NOT_TESTED", syntheticSystemChars: system.length, status: "RUNNING" };
  try {
    const started = performance.now();
    const requestBody = { model: "antigravity-gemini-web", sessionId: "context_delivery_" + randomUUID(), request: {
      systemInstruction: { role: "system", parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: "Request the exact declared verify_context tool using all three marker values from the synthetic system context in their original order. This is a transport test; do not review a real workspace." }] }],
      tools: [{ functionDeclarations: [{ name: "verify_context", description: "Return all three fixture markers to the test caller. No file access or execution.", parameters: { type: "object", properties: { markers: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 } }, required: ["markers"], additionalProperties: false } }] }],
      toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["verify_context"] } },
    } };
    const send = body => fetch(endpoint + "/v1internal:streamGenerateContent?alt=sse", { method: "POST", headers: { authorization: "Bearer synthetic-context-delivery-test", "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    const response = await send(requestBody);
    evidence.httpStatus = response.status;
    const body = await response.text();
    const frames = body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    const calls = frames.flatMap(frame => frame.response?.candidates?.[0]?.content?.parts ?? []).flatMap(part => part.functionCall ? [part.functionCall] : []);
    evidence.elapsedMs = Math.round(performance.now() - started); evidence.lastTurn = (await health()).lastTurn;
    assert.equal(response.status, 200); assert.equal(evidence.lastTurn.phase, "completed");
    assert.equal(calls.length, 1); assert.equal(calls[0].name, "verify_context"); assert.deepEqual(calls[0].args.markers, markers);
    evidence.markersMatch = true;
    const marker = "CONTEXT_FOLLOW_UP_" + randomUUID().replaceAll("-", "").slice(0, 12);
    requestBody.request.contents.push({ role: "model", parts: [{ functionCall: calls[0] }] }, { role: "user", parts: [{ functionResponse: { name: calls[0].name, id: calls[0].id, response: { instruction: "Reply exactly with this marker, without calling any tools.", marker } } }] });
    requestBody.request.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    const followupStarted = performance.now();
    const followup = await send(requestBody);
    const followupFrames = (await followup.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    const reply = followupFrames.flatMap(frame => frame.response?.candidates?.[0]?.content?.parts ?? []).map(part => part.text ?? "").join("");
    evidence.followup = { httpStatus: followup.status, elapsedMs: Math.round(performance.now() - followupStarted), replyMatches: reply.trim() === marker, lastTurn: (await health()).lastTurn };
    assert.equal(followup.status, 200); assert.equal(evidence.followup.lastTurn.phase, "completed"); assert.equal(evidence.followup.replyMatches, true);
    assert.equal(evidence.followup.lastTurn.transportMessages, 1); assert.equal(evidence.followup.lastTurn.reused, true); assert.ok(evidence.followup.lastTurn.promptChars < 28000);
    evidence.status = "PASS_LONG_CONTEXT_TOOL_AND_DELTA_FOLLOW_UP";
  } catch (error) { evidence.status = "FAILED"; evidence.error = error instanceof assert.AssertionError ? "ASSERTION_FAILED" : "PROBE_FAILED"; evidence.lastTurn = (await health()).lastTurn; process.exitCode = 1; }
  const output = process.argv.find(arg => arg.startsWith("--output="))?.slice("--output=".length) ?? "docs/evidence/mcp/native-context-delivery-live.json";
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence));
}
