// Synthetic context benchmark. No browser, network, credentials or live model calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import { compileNativeTurn, WEB_MODEL } from "../../packages/native-antigravity/dist/native-protocol.js";
import { NativeConversationState } from "../../packages/native-antigravity/dist/conversation-state.js";
import { applyContextPatch, wireValue } from "../../packages/native-antigravity/dist/context-patch.js";

const states = new NativeConversationState();
const content = (role, text) => ({ role, parts: [{ text }] });
const initial = {
  systemInstruction: content("system", "Workspace: SYNTHETIC. Read before editing. " + "Stable instruction. ".repeat(1200)),
  contents: [content("user", "Review the fixture project. " + "Synthetic file context. ".repeat(1600))],
  tools: [{ functionDeclarations: ["view_file", "patch_file"].map(name => ({ name, description: "Synthetic tool documentation. ".repeat(140), parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } })) }],
  toolConfig: { functionCallingConfig: { mode: "AUTO" } },
};
const variants = [{ name: "bootstrap", request: initial }];
const append = structuredClone(initial);
append.contents.push({ role: "model", parts: [{ functionCall: { name: "view_file", args: { path: "fixture.txt" } } }] }, { role: "user", parts: [{ functionResponse: { name: "view_file", response: { text: "Synthetic fixture result. ".repeat(40) } } }] });
variants.push({ name: "tool_result", request: append });
const followup = structuredClone(append);
followup.contents.push(content("model", "Review complete."), content("user", "Now check the second fixture."));
variants.push({ name: "follow_up", request: followup });
const changed = structuredClone(followup);
changed.systemInstruction.parts[0].text = changed.systemInstruction.parts[0].text.replace("Read before editing.", "Read only; do not edit.");
changed.tools[0].functionDeclarations.pop();
changed.contents[0].parts[0].text = changed.contents[0].parts[0].text.replace("Review the fixture project.", "Review only the first fixture.");
variants.push({ name: "rules_history_tool_removal", request: changed });
const removed = structuredClone(changed);
removed.contents.splice(1, 2);
removed.contents.push(content("user", "Summarize the review."));
variants.push({ name: "history_rebase", request: removed });

let receiver, revision, key;
const turns = variants.map(({ name, request }) => {
  const compiled = compileNativeTurn({ model: WEB_MODEL, sessionId: "offline-fixture", request }, "offline-fixture-caller");
  const plan = states.prepare(compiled.taskKey, compiled.context);
  const prompt = compiled.promptFor(plan);
  const body = JSON.parse(prompt.split("<native_context_json>\n")[1].split("\n</native_context_json>")[0]);
  if (plan.mode === "full") { ({ revision, ...receiver } = body); key = plan.key; }
  else {
    assert.equal(plan.key, key); assert.equal(body.baseRevision, revision);
    if (body.mode === "append") { assert.equal(body.appendFrom, receiver.contents.length); receiver.contents.push(...body.contents); }
    else if (body.mode === "patch") receiver = applyContextPatch(receiver, body.patches);
    else receiver = body.context;
    revision = body.revision;
    assert.ok(prompt.length < compiled.prompt.length / 10);
  }
  assert.deepEqual(receiver, wireValue(compiled.context));
  assert.equal(revision, plan.revision);
  const final = compiled.parseReply(JSON.stringify({ nonce: compiled.nonce, type: "final", text: "OFFLINE_OK" }));
  assert.equal(final.response.candidates[0].content.parts[0].text, "OFFLINE_OK");
  if (name === "rules_history_tool_removal") assert.throws(() => compiled.parseReply(JSON.stringify({ nonce: compiled.nonce, type: "tool_call", name: "patch_file", args: { path: "fixture.txt" } })), { code: "TOOL_DENIED" });
  states.complete(plan);
  return { name, mode: plan.mode, fullPromptChars: compiled.prompt.length, sentPromptChars: prompt.length, exactReconstruction: true };
});
const baseline = turns.reduce((sum, turn) => sum + turn.fullPromptChars, 0);
const sent = turns.reduce((sum, turn) => sum + turn.sentPromptChars, 0);
const result = { fixtureOnly: true, liveModelRequests: 0, measurement: "JavaScript UTF-16 string length; not provider tokens or quota", turns, totalFullPromptChars: baseline, totalSentPromptChars: sent, reductionPercent: Number(((1 - sent / baseline) * 100).toFixed(2)) };
if (process.argv.includes("--write-evidence")) fs.writeFileSync(new URL("../../docs/evidence/mcp/native-context-offline.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
