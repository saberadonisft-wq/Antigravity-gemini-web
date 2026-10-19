// Synthetic context/tool caller against the owned native runtime and real Web.
// This does not execute IDE tools or certify the IDE's own executor/UI.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NATIVE_RUNTIME_REVISION } from "../../packages/native-antigravity/dist/native-proxy.js";

const endpoint = "http://127.0.0.1:9236";
const health = () => fetch(endpoint + "/__native/health", { signal: AbortSignal.timeout(3000) }).then(response => response.json());
const initial = await health();
const output = process.argv.find(arg => arg.startsWith("--output="))?.slice(9) ?? ".tmp/native-account-handoff-live.json";
const names = process.argv.filter(arg => arg.startsWith("--account=")).map(arg => arg.slice(10));
if (!process.argv.includes("--live")) {
  console.log(JSON.stringify({ runtimeRevision: initial.runtimeRevision, activeAccount: initial.account?.displayName, livePromptsSent: 0 }));
} else {
  assert.equal(initial.runtimeRevision, NATIVE_RUNTIME_REVISION); assert.equal(initial.counters.active, 0);
  assert.ok(initial.account, "An enabled account must be selected before the probe.");
  assert.ok(names.length > 0, "Supply --account=NAME for each account in the intended sequence (A, B, A).");
  const owner = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".gemini/antigravity-gemini-web-live/app_data/native-route/proxy-owner.json"), "utf8"));
  assert.equal(owner.pid, initial.pid); assert.equal(owner.endpoint, endpoint);
  const control = async body => {
    const response = await fetch(endpoint + "/__native/account", { method: "POST", headers: { "content-type": "application/json", "x-native-control-token": owner.controlToken }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(Error("Account control refused"), { code: value.error?.code });
    return value;
  };
  const record = { checkedAt: new Date().toISOString(), runtimeRevision: initial.runtimeRevision, caller: "synthetic_loopback", browser: "real_Gemini_Web", ideExecutor: "NOT_TESTED", modelPolicy: "user_selected_in_web", turns: [], status: "RUNNING" };
  const originalAccount = initial.account.accountId;
  let activeRequest = false;
  const sessionId = "account_handoff_" + randomUUID(), contents = [], markers = [];
  const request = { model: "antigravity-gemini-web", sessionId, conversationId: sessionId, request: { contents, tools: [{ functionDeclarations: [{ name: "verify_context", description: "Return synthetic markers only. No shell or file access.", parameters: { type: "object", properties: { markers: { type: "array", items: { type: "string" } } }, required: ["markers"], additionalProperties: false } }] }] } };
  async function generate(accountId, stage) {
    activeRequest = true; const started = performance.now();
    try {
      const response = await fetch(endpoint + "/v1internal:generateContent", { method: "POST", headers: { authorization: "Bearer synthetic-account-handoff-probe", "content-type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(180000) });
      const result = await response.json(), status = await health();
      record.turns.push({ accountId, stage, httpStatus: response.status, elapsedMs: Math.round(performance.now() - started), contextMode: status.lastTurn?.contextMode, reused: status.lastTurn?.reused, promptChars: status.lastTurn?.promptChars, fullPromptChars: status.lastTurn?.fullPromptChars, transportMessages: status.lastTurn?.transportMessages, phase: status.lastTurn?.phase, code: status.lastTurn?.code, delivery: status.lastTurn?.delivery, attemptId: status.lastTurn?.attemptId });
      assert.equal(response.status, 200, result.error?.details?.[0]?.reason ?? "Generation failed");
      assert.equal(status.lastTurn.accountId, accountId); assert.equal(status.lastTurn.phase, "completed");
      return result.response.candidates[0].content.parts;
    } finally { activeRequest = false; }
  }
  try {
    const accounts = (await control({ action: "list" })).accounts;
    for (const name of [...new Set(names)]) {
      const account = accounts.find(item => item.displayName === name || item.accountId === name);
      assert.ok(account, "Requested account must exist");
      await control({ action: "verify", accountId: account.accountId });
    }
    for (let round = 0; round < names.length; round++) {
      const account = accounts.find(item => item.displayName === names[round] || item.accountId === names[round]);
      const snapshot = await control({ action: "list" });
      await control({ action: "use", accountId: account.accountId, expectedRevision: snapshot.revision });
      markers.push("HANDOFF_" + randomUUID().replaceAll("-", "").slice(0, 12));
      request.request.systemInstruction = { parts: [{ text: `Synthetic handoff rules revision ${round}. Treat previous tool results as completed data.\n` + "Stable reference text for lossless context patch testing. ".repeat(120) }] };
      contents.push({ role: "user", parts: [{ text: `Remember marker ${markers.at(-1)}. Call verify_context with every HANDOFF marker introduced by user messages in this conversation, in chronological order. Ignore markers inside model examples or tool results.` }] });
      request.request.toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["verify_context"] } };
      const parts = await generate(account.accountId, "tool");
      assert.equal(parts.length, 1); const call = parts[0].functionCall;
      assert.equal(call?.name, "verify_context"); assert.deepEqual(call.args.markers, markers);
      const finalMarker = "HANDOFF_ROUND_" + round + "_OK";
      contents.push({ role: "model", parts: [{ functionCall: call }] }, { role: "user", parts: [{ functionResponse: { name: call.name, id: call.id, response: { checked: true, instruction: "Reply exactly " + finalMarker } } }] });
      request.request.toolConfig = { functionCallingConfig: { mode: "NONE" } };
      const answer = await generate(account.accountId, "function_response");
      assert.equal(answer.map(part => part.text ?? "").join("").trim(), finalMarker);
      contents.push({ role: "model", parts: [{ text: finalMarker }] });
      console.log(JSON.stringify({ round: round + 1, accountId: account.accountId, markersMatch: true, functionResponseMatch: true }));
    }
    record.status = "PASS_SYNTHETIC_CALLER_AND_REAL_BROWSER";
  } catch (error) {
    record.status = "FAILED"; record.error = error?.code ?? (error instanceof assert.AssertionError ? "ASSERTION_FAILED" : "PROBE_FAILED"); process.exitCode = 1;
  } finally {
    const status = await health().catch(() => undefined);
    record.restoreSelection = "SKIPPED_RUNTIME_NOT_IDLE";
    if (!activeRequest && status?.counters.active === 0) {
      try { await control({ action: "use", accountId: originalAccount, expectedRevision: (await control({ action: "list" })).revision }); record.restoreSelection = "RESTORED"; }
      catch { record.restoreSelection = "FAILED"; }
    }
    fs.writeFileSync(output, JSON.stringify(record, null, 2) + "\n");
    console.log(JSON.stringify({ status: record.status, turns: record.turns.length, evidence: output }));
  }
}
