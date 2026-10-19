import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NativeConversationState, nativePartialText, type NativeContext } from "./conversation-state.js";
import { compileNativeTurn, MAX_NATIVE_PROMPT_CHARS, WEB_MODEL, sha256 } from "./native-protocol.js";
import { applyContextPatch } from "./context-patch.js";

const context = (contents: unknown[] = ["first"]) => ({ contents, tools: [], systemInstruction: "rules" }) satisfies NativeContext;

test("Retained context keeps ownership across history and rule edits but isolates task IDs", () => {
  const states = new NativeConversationState();
  assert.equal(states.prepare(undefined, context()), undefined);
  const first = states.prepare("task-A", context())!;
  assert.throws(() => states.prepare("task-A", context(["next"])), { code: "BUSY" });
  states.complete(first);
  const next = states.prepare("task-A", context(["first", "assistant", "next"]))!;
  assert.equal(next.key, first.key); assert.equal(next.baseRevision, first.revision); assert.equal(next.appendFrom, 1);
  states.complete(next);
  const branched = states.prepare("task-A", context(["changed", "next"]))!;
  assert.equal(branched.key, first.key); assert.deepEqual(branched.retiredKeys, []); assert.equal(branched.baseRevision, next.revision);
  assert.deepEqual(branched.mode === "patch" ? applyContextPatch(next.context, branched.patches!) : branched.context, context(["changed", "next"]));
  states.complete(branched);
  const rules = states.prepare("task-A", { ...context(["changed", "next", "more"]), tools: [{ name: "new_tool" }] })!;
  assert.equal(rules.key, branched.key); assert.equal(rules.baseRevision, branched.revision);
  const other = states.prepare("task-B", context())!; assert.notEqual(other.key, rules.key);
});

test("Retained Native context keeps its account registered until the context is retired",()=>{
  const states=new NativeConversationState(),plan=states.prepare("task-account",context(),false,undefined,"acc_fixture_B",0)!;
  states.complete(plan);assert.equal(states.hasAccount("acc_fixture_B"),true);assert.equal(states.hasAccount("acc_fixture_A"),false);
});

test("Stale completion and failure cannot disturb a newer reservation even for identical revisions", () => {
  const states = new NativeConversationState();
  const first = states.prepare("task", context())!; states.complete(first);
  const second = states.prepare("task", context())!; states.complete(second);
  const third = states.prepare("task", context())!;
  assert.equal(second.revision, third.revision); assert.equal(second.baseRevision, third.baseRevision);
  states.invalidate(second);
  assert.throws(() => states.complete(second), { code: "STALE_AUTHORITY" });
  assert.throws(() => states.prepare("task", context()), { code: "BUSY" });
  states.complete(third);
  const next = states.prepare("task", context(["next"]))!;
  assert.equal(next.key, first.key);
  next.context.contents.push("tampering");
  assert.throws(() => states.complete(next), { code: "STALE_AUTHORITY" });
});

test("A compact replacement still uses the retained tab and explicitly replaces its canonical context", () => {
  const states = new NativeConversationState();
  const first = states.prepare("task", { contents: ["a"], tools: [] })!; states.complete(first);
  const second = states.prepare("task", { contents: ["b"], tools: [] })!;
  assert.equal(second.mode, "replace"); assert.equal(second.key, first.key); assert.equal(second.baseRevision, first.revision);
});

test("Full and revision-bearing prompt caps fail before Send and an unsent reservation can be released", () => {
  const envelope = (text: string) => ({ model: WEB_MODEL, sessionId: "cap-task", request: { contents: [{ role: "user", parts: [{ text }] }] } });
  const overhead = compileNativeTurn(envelope("")).prompt.length;
  const compiled = compileNativeTurn(envelope("x".repeat(MAX_NATIVE_PROMPT_CHARS - overhead)));
  const states = new NativeConversationState();
  const plan = states.prepare(compiled.taskKey, compiled.context)!;
  assert.throws(() => compiled.promptFor(plan), { code: "CONTEXT_TOO_LARGE" });
  states.discardUnsent(plan);
  const first = states.prepare(compiled.taskKey, context())!; states.complete(first);
  const pending = states.prepare(compiled.taskKey, context(["not sent"]))!; states.discardUnsent(pending);
  const next = states.prepare(compiled.taskKey, context(["retry safely"]))!;
  assert.equal(next.key, first.key); assert.equal(next.baseRevision, first.revision);
  assert.throws(() => compileNativeTurn(envelope("x".repeat(MAX_NATIVE_PROMPT_CHARS))), { code: "CONTEXT_TOO_LARGE" });
});

test("Delta prompts carry the new nonce and suffix, while the full native cap remains enforced", () => {
  const states = new NativeConversationState();
  const envelope = { model: WEB_MODEL, sessionId: "task", request: { contents: [{ role: "user", parts: [{ text: "INITIAL_CONTEXT_".repeat(1000) }] }] } };
  const first = compileNativeTurn(envelope, "caller");
  const plan = states.prepare(first.taskKey, first.context)!; states.complete(plan);
  const next = compileNativeTurn({ ...envelope, request: { contents: [...envelope.request.contents, { role: "model", parts: [{ text: "ok" }] }, { role: "user", parts: [{ text: "FOLLOW_UP" }] }] } }, "caller");
  const resumed = states.prepare(next.taskKey, next.context)!;
  const prompt = next.promptFor(resumed);
  assert.ok(prompt.includes("FOLLOW_UP")); assert.ok(prompt.includes(next.nonce)); assert.ok(!prompt.includes("INITIAL_CONTEXT_"));
  assert.ok(prompt.length < next.prompt.length / 2);
  assert.equal(compileNativeTurn({ ...envelope, sessionId: undefined, userPromptId: "only-turn" }).taskKey, undefined);
  assert.notEqual(first.taskKey, compileNativeTurn(envelope, "other-caller").taskKey);
  states.invalidate(resumed); assert.notEqual(states.prepare(first.taskKey, first.context)!.key, plan.key);
});

test("New IDE conversation IDs are isolated across camelCase and snake_case envelopes", () => {
  const base = { model: WEB_MODEL, sessionId: "ide-session", request: { contents: [{ role: "user", parts: [{ text: "same prompt" }] }] } };
  const camelFirst = compileNativeTurn({ ...base, conversationId: "chat-one" }, "caller");
  const camelSecond = compileNativeTurn({ ...base, conversationId: "chat-two" }, "caller");
  assert.notEqual(camelFirst.taskKey, camelSecond.taskKey);

  const snakeFirst = compileNativeTurn({ model: WEB_MODEL, session_id: "ide-session", request: { ...base.request, conversation_id: "chat-one" } }, "caller");
  const snakeSecond = compileNativeTurn({ model: WEB_MODEL, session_id: "ide-session", request: { ...base.request, conversation_id: "chat-two" } }, "caller");
  assert.notEqual(snakeFirst.taskKey, snakeSecond.taskKey);
  assert.equal(camelFirst.taskKey, snakeFirst.taskKey);
});

test("An uncertain old IDE chat stays fenced while a new IDE conversation gets a fresh Web conversation", () => {
  const states = new NativeConversationState();
  const oldTurn = compileNativeTurn({ model: WEB_MODEL, session_id: "ide-session", conversation_id: "chat-old", request: { contents: [{ role: "user", parts: [{ text: "same prompt" }] }] } }, "caller");
  const oldPlan = states.prepare(oldTurn.taskKey, oldTurn.context)!;
  states.markOutcomeUnknown(oldPlan);
  const oldFollowUp = compileNativeTurn({ model: WEB_MODEL, session_id: "ide-session", conversation_id: "chat-old", request: { contents: [{ role: "user", parts: [{ text: "follow up" }] }] } }, "caller");
  assert.throws(() => states.prepare(oldFollowUp.taskKey, oldFollowUp.context), { code: "OUTCOME_UNKNOWN" });

  const newTurn = compileNativeTurn({ model: WEB_MODEL, session_id: "ide-session", conversation_id: "chat-new", request: { contents: [{ role: "user", parts: [{ text: "same prompt" }] }] } }, "caller");
  const newPlan = states.prepare(newTurn.taskKey, newTurn.context)!;
  assert.notEqual(newPlan.key, oldPlan.key);
  assert.equal(newPlan.mode, "full");
  assert.equal(newPlan.baseRevision, undefined);
});

test("Streaming decodes only the current final envelope, never tool arguments or incomplete Unicode", () => {
  const nonce = "a".repeat(48);
  const prefix = '{"nonce":"' + nonce + '","type":"final","text":"';
  assert.equal(nativePartialText(prefix + 'hello\\nworld\\uD83D', nonce), "hello\nworld");
  assert.equal(nativePartialText(prefix + 'hello\\uD83D\\uDE00', nonce), "hello😀");
  assert.equal(nativePartialText(prefix + 'hello\\', nonce), "hello");
  assert.equal(nativePartialText(prefix + 'safe-\\udbff-broken', nonce), "safe-");
  assert.equal(nativePartialText(prefix + 'safe-\\udfff-broken', nonce), "safe-");
  assert.equal(nativePartialText(prefix + 'safe-\\udbff\\udfff-ok', nonce), "safe-" + String.fromCodePoint(0x10ffff) + "-ok");
  assert.equal(nativePartialText(prefix + 'hello', "b".repeat(48)), undefined);
  assert.equal(nativePartialText('{"nonce":"' + nonce + '","type":"tool_call","name":"run","args":{"text":"secret"}}', nonce), undefined);
});

test("Only idle owned tasks may be evicted from the bounded retained context cache", () => {
  const states = new NativeConversationState(1);
  const first = states.prepare("a", context())!;
  assert.throws(() => states.prepare("b", context()), { code: "BUSY" });
  states.complete(first);
  const second = states.prepare("b", context())!; assert.deepEqual(second.retiredKeys, [first.key]);
});

test("Failed task fences survive restart without exhausting live conversation slots", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-quarantine-test-"));
  const filename = path.join(directory, "cache.json");
  t.after(() => { fs.rmSync(filename, { force: true }); fs.rmdirSync(directory); });
  let states = new NativeConversationState(1, filename);
  for (let index = 0; index < 6; index++) {
    const failed = states.prepare(sha256("failed-" + index), context())!;
    states.markOutcomeUnknown(failed);
    states = new NativeConversationState(1, filename);
  }
  for (let index = 0; index < 6; index++) assert.throws(() => states.prepare(sha256("failed-" + index), context()), { code: "OUTCOME_UNKNOWN" });
  const fresh = states.prepare(sha256("new-task"), context())!;
  assert.deepEqual(fresh.retiredKeys, []);
  assert.throws(() => states.prepare(sha256("another-task"), context()), { code: "BUSY" });
  states.complete(fresh, "https://gemini.google.com/app/fixture");
  states = new NativeConversationState(1, filename);
  const replacement = states.prepare(sha256("another-task"), context())!;
  assert.deepEqual(replacement.retiredKeys, [fresh.key]);
  assert.throws(() => states.prepare(sha256("failed-0"), context()), { code: "OUTCOME_UNKNOWN" });
});
