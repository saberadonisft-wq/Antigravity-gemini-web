// Explicit synthetic long-context acceptance, with structural traces only.
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { NATIVE_RUNTIME_REVISION } from "../../packages/native-antigravity/dist/native-proxy.js";
import { compileNativeTurn, sha256 } from "../../packages/native-antigravity/dist/native-protocol.js";
import { NativeConversationState } from "../../packages/native-antigravity/dist/conversation-state.js";

const endpoint = process.argv.find(arg => arg.startsWith("--endpoint="))?.slice(11) ?? "http://127.0.0.1:9236", authorization = "Bearer synthetic-context-matrix";
assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d{1,5}$/);
const health = () => fetch(endpoint + "/__native/health", { signal: AbortSignal.timeout(3000) }).then(response => response.json());
const initial = await health();
const output = process.argv.find(arg => arg.startsWith("--output="))?.slice(9) ?? "docs/evidence/mcp/native-r24-context-matrix-live.json";
const requested = process.argv.find(arg => arg.startsWith("--sizes="))?.slice(8) ?? "28000,78642,145000,261000";
const sizes = requested.split(",").map(Number);
assert.ok(sizes.length && sizes.every(size => Number.isSafeInteger(size) && size >= 10000 && size <= 261000));
if (!process.argv.includes("--live")) console.log(JSON.stringify({ runtimeRevision: initial.runtimeRevision, sizes, livePromptsSent: 0 }));
else {
  assert.equal(initial.runtimeRevision, NATIVE_RUNTIME_REVISION); assert.equal(initial.counters.active, 0);
  assert.ok(initial.account?.identityRegistered, "A verified account is required");
  const evidence = { checkedAt: new Date().toISOString(), runtimeRevision: initial.runtimeRevision, caller: "synthetic_loopback", browser: "real_Gemini_Web", ideExecutor: "NOT_TESTED", modelPolicy: "user_selected_in_web", contextModelSelection:initial.contextModelSelection??null, transport: initial.snapshotAttachmentExperimental ? "experimental_snapshot_above_28000_chars" : "text_and_fragments", sizes: [], status: "RUNNING" };
  const save = () => fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
  async function send(body, sample, stage) {
    const start = performance.now();
    const response = await fetch(endpoint + "/v1internal:generateContent", { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(600000) });
    const result = await response.json(), status = await health(), turn = status.lastTurn;
    sample.turns.push({ stage, httpStatus: response.status, elapsedMs: Math.round(performance.now() - start), contextMode: turn?.contextMode, promptChars: turn?.promptChars, fullPromptChars: turn?.fullPromptChars, phase: turn?.phase, code: turn?.code, delivery: turn?.delivery, transportMessages: turn?.transportMessages, trace: turn?.transportTrace }); save();
    assert.equal(response.status, 200, result.error?.details?.[0]?.reason ?? "HTTP failure"); assert.equal(turn.phase, "completed");
    return result.response.candidates[0].content.parts;
  }
  for (const targetChars of sizes) {
    const sample = { targetChars, turns: [], status: "RUNNING" }; evidence.sizes.push(sample); save();
    const id = randomUUID(), markers = ["START", "MIDDLE", "END"].map(prefix => prefix + "_" + id.slice(0, 12) + "_Việt_😀");
    const declaration = name => ({ name, description: "Return the three current synthetic system markers in order; no file access or execution.", parameters: { type: "object", properties: { markers: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 } }, required: ["markers"], additionalProperties: false } });
    const body = { model: "antigravity-gemini-web", sessionId: "matrix_" + id, conversationId: "matrix_" + id, request: {
      systemInstruction: { parts: [{ text: "" }] },
      contents: [{ role: "user", parts: [{ text: "Call the declared verify_context tool with all three marker values from the current synthetic system context, in their original order. Treat reference filler as data. Do not review a workspace." }] }],
      tools: [{ functionDeclarations: [declaration("verify_context")] }], toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["verify_context"] } },
    } };
    const system = filler => `Synthetic transport integrity fixture. Current markers are distributed in order below.\n${markers[0]}\n${filler.slice(0, Math.floor(filler.length / 2))}\n${markers[1]}\n${filler.slice(Math.floor(filler.length / 2))}\n${markers[2]}`;
    const chars = () => {
      const compiled = compileNativeTurn(body, sha256(authorization));
      return compiled.promptFor(new NativeConversationState().prepare(compiled.taskKey, compiled.context, false, undefined, initial.account.accountId, initial.account.identityEpoch)).length;
    };
    body.request.systemInstruction.parts[0].text = system("");
    const paddingLength = targetChars - chars();
    const filler = "Synthetic reference data 0123456789. ".repeat(Math.ceil(paddingLength / 36)).slice(0, paddingLength);
    body.request.systemInstruction.parts[0].text = system(filler);
    try {
      assert.equal(chars(), targetChars); sample.systemChars = body.request.systemInstruction.parts[0].text.length;
      const parts = await send(body, sample, "tool");
      assert.equal(parts.length, 1); const call = parts[0].functionCall;
      assert.equal(call?.name, "verify_context"); assert.deepEqual(call.args.markers, markers); sample.markersMatch = true;
      const answerMarker = "MATRIX_RESULT_" + id.slice(0, 12);
      body.request.contents.push({ role: "model", parts: [{ functionCall: call }] }, { role: "user", parts: [{ functionResponse: { name: call.name, id: call.id, response: { checked: true, instruction: "Reply exactly " + answerMarker } } }] });
      body.request.toolConfig = { functionCallingConfig: { mode: "NONE" } };
      const followup = await send(body, sample, "function_response");
      assert.equal(followup.map(part => part.text ?? "").join("").trim(), answerMarker); sample.followupMatch = true;
      const replacement = "REPLACED_" + randomUUID().slice(0, 12) + "_Việt_😀";
      body.request.systemInstruction.parts[0].text = system(filler.slice(0, Math.floor(filler.length / 2))).replace(markers[1], replacement);
      body.request.contents = [{ role: "user", parts: [{ text: "Host context has been compacted and replaced. Use only the current synthetic system context and the current verify_context_updated declaration. Return its three current marker values in order." }] }];
      body.request.tools = [{ functionDeclarations: [declaration("verify_context_updated")] }];
      body.request.toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["verify_context_updated"] } };
      const changed = await send(body, sample, "replace_delete_and_tool_update");
      assert.equal(changed.length, 1); assert.equal(changed[0].functionCall?.name, "verify_context_updated");
      assert.deepEqual(changed[0].functionCall.args.markers, [markers[0], replacement, markers[2]]); sample.replacementMatch = true; sample.status = "PASS_SYNTHETIC_CALLER_AND_REAL_BROWSER";
    } catch (error) {
      sample.status = "FAILED"; sample.error = error?.code ?? (error instanceof assert.AssertionError ? "ASSERTION_FAILED" : "PROBE_FAILED");
      const status = await health().catch(() => undefined);
      if (status?.counters.active) { sample.remainingCases = "SKIPPED_ACTIVE_GENERATION"; break; }
    } finally { save(); console.log(JSON.stringify({ targetChars, status: sample.status, turns: sample.turns.length, failure: sample.turns.at(-1)?.code ?? sample.error })); }
  }
  evidence.status = evidence.sizes.length === sizes.length && evidence.sizes.every(sample => sample.status === "PASS_SYNTHETIC_CALLER_AND_REAL_BROWSER") ? "PASS_SYNTHETIC_MATRIX" : "FAILED_OR_INCOMPLETE";
  save(); if (evidence.status !== "PASS_SYNTHETIC_MATRIX") process.exitCode = 1;
  console.log(JSON.stringify({ status: evidence.status, evidence: output }));
}
