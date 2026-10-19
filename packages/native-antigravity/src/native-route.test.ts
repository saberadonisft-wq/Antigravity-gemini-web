import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileNativeTurn, nativeToolCacheStats, MAX_NATIVE_PROMPT_CHARS, WEB_MODEL, NativeRouteError, type JsonObject } from "./native-protocol.js";
import { startNativeProxy, NativeModelIdentity, WEB_CATALOG_MODEL, type ControlTransport } from "./native-proxy.js";
import { selectNativeBrowserReply } from "./browser-backend.js";
import { configureIsolatedProfile } from "./installation.js";
import type { NativeBrowserBackend } from "./browser-backend.js";
import { applyContextPatch, wireValue } from "./context-patch.js";
import { hasValidUnicode } from "./unicode.js";
import { nativeBrowserTransport } from "./browser-transport.js";

test("Native SSE never emits lone surrogates even inside a partial string; valid Unicode repair streams losslessly", { timeout: 5000 }, async t => {
  const f = await fixture(t, async (_id, prompt, _signal, options) => {
    options!.onProgress!({ revision: 1, text: reply(prompt, { type: "final", text: "safe-\udbff-broken" }), stage: "responding" });
    await new Promise(resolve => setTimeout(resolve, 10));
    const final = reply(prompt, { type: "final", text: "safe-" + String.fromCodePoint(0x10ffff) + "-ok 😀" });
    options!.onProgress!({ revision: 2, text: final, stage: "responding" });
    return final;
  });
  const raw = await (await f.post("/v1internal:streamGenerateContent?alt=sse", request("unicode fixture"))).text();
  const frames = raw.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  assert.ok(frames.every(hasValidUnicode));
  assert.equal(frames.map(frame => frame.response.candidates[0].content.parts[0].text).join(""), "safe-" + String.fromCodePoint(0x10ffff) + "-ok 😀");
  assert.equal(f.proxy.counters.completed, 1);
});

test("Invalid terminal Unicode becomes a safe explicit failure, including nested tool argument values and keys", { timeout: 5000 }, async t => {
  const compiled = compileNativeTurn(request());
  for (const args of [{ AbsolutePath: "bad\udbff-name" }, { AbsolutePath: "ok", ["bad\udfff-key"]: "value" }]) {
    assert.throws(() => compiled.parseReply(reply(compiled.prompt, { type: "tool_call", name: "view_file", args })), { code: "INVALID_MODEL_UNICODE" });
  }
  const f = await fixture(t, async (_id, prompt) => reply(prompt, { type: "final", text: "bad\udbff-text" }));
  const raw = await (await f.post("/v1internal:streamGenerateContent?alt=sse", request("invalid unicode fixture"))).text();
  assert.ok(raw.includes("INVALID_MODEL_UNICODE")); assert.ok(raw.includes('"finishReason":"STOP"'));
  assert.ok(!raw.includes("\\udbff")); assert.equal(f.proxy.counters.completed, 0); assert.equal(f.proxy.counters.failed, 1);
});

test("Native streams a nonce-bound text prefix before completion and finishes without duplicating it", { timeout: 5000 }, async t => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let calls = 0;
  const f = await fixture(t, async (_id, prompt, _signal, options) => {
    calls++;
    const raw = reply(prompt, { type: "final", text: "hello world" });
    options!.onProgress!({ revision: 1, text: raw.slice(0, raw.indexOf("world")), stage: "responding" });
    await pending; return raw;
  });
  const response = await f.post("/v1internal:streamGenerateContent?alt=sse", request());
  const reader = response.body!.getReader(); let text = "";
  while (!text.includes('"text":"hello ')) { const chunk = await reader.read(); assert.equal(chunk.done, false); text += new TextDecoder().decode(chunk.value); }
  assert.equal(f.proxy.counters.completed, 0); finish();
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); }
  const frames = text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  assert.equal(frames.map(frame => frame.response.candidates[0].content.parts[0].text).join(""), "hello world");
  assert.equal(frames.at(-1).response.candidates[0].finishReason, "STOP"); assert.equal(calls, 1);
});

test("Owner cancellation ends native SSE with an explicit failure terminal and never replays the accepted Send", { timeout: 5000 }, async t => {
  let aborted = false, calls = 0;
  const f = await fixture(t, async (_id, _prompt, signal, generationOptions) => {
    generationOptions?.onSubmissionStarted?.();
    calls++; signal.addEventListener("abort", () => { aborted = true; generationOptions?.onCancellationResult?.({ confirmed: true }); });
    return new Promise(() => {});
  });
  const response = await f.post("/v1internal:streamGenerateContent?alt=sse", request());
  const cancel = await f.post("/__native/cancel", {}, { "x-native-control-token": "owned-control" });
  const cancellation = await cancel.json();
  assert.equal(cancellation.cancelRequested, 1); assert.equal(cancellation.browserStopConfirmed, true); assert.equal(cancellation.browserStopConfirmationPending, false);
  const body = await response.text(); assert.equal(aborted, true);
  assert.ok(body.includes("Gemini Web error: CANCELLED")); assert.ok(body.includes('"finishReason":"STOP"')); assert.ok(!body.includes("event: error"));
  assert.equal(f.proxy.counters.failed, 1); assert.equal(f.proxy.counters.completed, 0);
  const retry = await (await f.post("/v1internal:streamGenerateContent?alt=sse", request())).text();
  assert.ok(retry.includes("CANCELLED")); assert.equal(calls, 1); assert.equal(f.proxy.counters.active, 0);
  assert.equal((await (await fetch(f.url + "/__native/health")).json()).lastTurn.delivery, "unknown");
});

test("A new IDE conversation opens a fresh Web conversation while the old uncertain turn remains isolated", { timeout: 5000 }, async t => {
  const received: Array<{ prompt: string; conversation: unknown }> = [];
  const f = await fixture(t, async (_id, prompt, _signal, generationOptions) => {
    received.push({ prompt, conversation: generationOptions?.conversation });
    if (received.length === 1) {
      generationOptions?.onSubmissionStarted?.();
      throw new NativeRouteError("BROWSER_TURN_FAILED", "The old Web turn ended with an uncertain result.", 502);
    }
    return reply(prompt, { type: "final", text: "new IDE chat is ready" });
  });
  const path = "/v1internal:streamGenerateContent?alt=sse";
  const first = { ...request("same first prompt"), session_id: "ide-session", conversation_id: "ide-chat-one" };
  const failed = await f.post(path, first);
  assert.match(await failed.text(), /BROWSER_TURN_FAILED/);

  const oldFollowUp = structuredClone(first);
  oldFollowUp.request.contents.push({ role: "user", parts: [{ text: "continue the old chat" }] });
  const fenced = await f.post(path, oldFollowUp);
  assert.equal(fenced.status, 409);
  assert.equal((await fenced.json()).error.details[0].reason, "OUTCOME_UNKNOWN");
  assert.equal(received.length, 1);

  const newChat = { ...request("same first prompt"), session_id: "ide-session", conversation_id: "ide-chat-two" };
  const completed = await f.post(path, newChat);
  assert.match(await completed.text(), /new IDE chat is ready/);
  assert.equal(received.length, 2);
  const oldBinding = received[0].conversation as { key: string; baseRevision?: string };
  const newBinding = received[1].conversation as { key: string; baseRevision?: string };
  assert.notEqual(newBinding.key, oldBinding.key);
  assert.equal(newBinding.baseRevision, undefined);
});

test("Browser preparation failure is a non-retryable Google JSON error before SSE headers, never a submitted prompt", { timeout: 5000 }, async t => {
  let sends = 0;
  const proxy = await startNativeProxy({ port: 0, stateDirectory: temporary(t), backend: {
    prepare: async () => { throw new NativeRouteError("BROWSER_LOGIN_REQUIRED", "Sign in to the opened browser. No prompt submitted.", 412); },
    generate: async () => { sends++; throw Error("must not submit"); }, close: async () => {},
  } });
  t.after(() => proxy.close());
  const response = await fetch("http://127.0.0.1:" + proxy.port + "/v1internal:streamGenerateContent?alt=sse", { method: "POST", headers: { authorization: "Bearer fixture-only" }, body: JSON.stringify(request("browser closed")) });
  assert.equal(response.status, 412); assert.match(response.headers.get("content-type")!, /application\/json/);
  const error = (await response.json()).error;
  assert.equal(error.code, 412); assert.equal(error.status, "FAILED_PRECONDITION"); assert.equal(error.details[0].reason, "BROWSER_LOGIN_REQUIRED");
  assert.equal(sends, 0); assert.equal(proxy.counters.failed, 1); assert.equal(proxy.counters.active, 0);
});

test("A late browser failure produces one visible STOP boundary while the operation stays failed and cannot execute tools", { timeout: 5000 }, async t => {
  const diagnostic = { stage: "choose_effort" as const, verificationOnly: true };
  const f = await fixture(t, async () => { await new Promise(resolve => setTimeout(resolve, 20)); throw new NativeRouteError("BROWSER_UI_CHANGED", "Browser changed", 502, diagnostic); });
  const response = await f.post("/v1internal:streamGenerateContent?alt=sse", request("late browser error"));
  const frames = (await response.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  assert.equal(frames.length, 1);
  const candidate = frames[0].response.candidates[0];
  assert.equal(candidate.finishReason, "STOP"); assert.match(candidate.content.parts[0].text, /Gemini Web error: BROWSER_UI_CHANGED/);
  assert.equal(candidate.content.parts[0].functionCall, undefined); assert.equal(frames[0].error, undefined);
  assert.equal(f.proxy.counters.completed, 0); assert.equal(f.proxy.counters.failed, 1);
  assert.deepEqual((await (await fetch(f.url + "/__native/health")).json()).lastTurn.modelSelection, diagnostic);
});

test("Cancellation during uncooperative browser preparation ends the HTTP request without submitting", { timeout: 5000 }, async t => {
  let entered!: () => void; const starting = new Promise<void>(resolve => { entered = resolve; }); let prepareCalls = 0, sends = 0;
  const proxy = await startNativeProxy({ port: 0, stateDirectory: temporary(t), controlToken: "owned-control", backend: {
    prepare: async () => { if (prepareCalls++ === 0) { entered(); await new Promise(() => {}); } },
    generate: async (_id, prompt) => { sends++; return reply(prompt, { type: "final", text: "safe retry" }); }, close: async () => {},
  } });
  t.after(() => proxy.close());
  const url = "http://127.0.0.1:" + proxy.port;
  const body = request("cancel startup");
  const post = () => fetch(url + "/v1internal:generateContent", { method: "POST", headers: { authorization: "Bearer fixture-only", "content-type": "application/json" }, body: JSON.stringify(body) });
  const pending = post();
  await starting;
  await fetch(url + "/__native/cancel", { method: "POST", headers: { "x-native-control-token": "owned-control" } });
  const response = await pending; assert.equal(response.status, 499); assert.equal((await response.json()).error.status, "CANCELLED");
  assert.equal(sends, 0); assert.equal(proxy.counters.active, 0);
  assert.equal((await (await fetch(url + "/__native/health")).json()).lastTurn.delivery, "not_sent");
  const retry = await post(); assert.equal(retry.status, 200); assert.match(JSON.stringify(await retry.json()), /safe retry/); assert.equal(sends, 1);
});

const fence = String.fromCharCode(96).repeat(3);
test("Owner can arm exact existing conversation continuation without sending, and later turns resume its new lease", { timeout: 10000 }, async t => {
  const received: Array<{ prompt: string; conversation: unknown }> = [];
  const f = await fixture(t, async (_id, prompt, _signal, options) => {
    received.push({ prompt, conversation: options?.conversation });
    return reply(prompt, { type: "final", text: "continued" });
  });
  const url = "https://gemini.google.com/app/fixture_thread";
  const owner = { "x-native-control-token": "owned-control" };
  assert.equal((await f.post("/__native/resume", { url, nextTurn: true })).status, 401);
  assert.equal((await f.post("/__native/resume", { url }, owner)).status, 409);
  for (const invalid of ["https://example.invalid/app/x", "https://gemini.google.com/app", url + "?token=secret", url + "#fragment"]) assert.equal((await f.post("/__native/resume", { url: invalid, nextTurn: true }, owner)).status, 400);
  const arm = await (await f.post("/__native/resume", { url, nextTurn: true }, owner)).json();
  assert.equal(arm.armed, true); assert.equal(arm.promptSent, false); assert.equal(received.length, 0);
  const health = await (await fetch(f.url + "/__native/health")).json();
  assert.equal(health.resumeArmed, true); assert.ok(!JSON.stringify(health).includes("fixture_thread"));
  const first = request("New follow-up after previous failed turn");
  const missingScope = { ...first, sessionId: undefined };
  assert.equal((await f.post("/v1internal:streamGenerateContent?alt=sse", missingScope)).status, 409);
  assert.ok((await (await f.post("/v1internal:streamGenerateContent?alt=sse", first)).text()).includes("continued"));
  const firstBinding = received[0].conversation as { key: string; revision: string; baseRevision?: string; resumeUrl?: string };
  assert.equal(firstBinding.resumeUrl, url); assert.equal(firstBinding.baseRevision, undefined);
  assert.ok(received[0].prompt.includes("supersedes earlier bridge context"));
  const next = structuredClone(first); next.request.contents.push({ role: "user", parts: [{ text: "Another follow-up" }] });
  await (await f.post("/v1internal:streamGenerateContent?alt=sse", next)).text();
  const nextBinding = received[1].conversation as typeof firstBinding;
  assert.equal(nextBinding.key, firstBinding.key); assert.equal(nextBinding.baseRevision, firstBinding.revision); assert.equal(nextBinding.resumeUrl, undefined);
  assert.ok(received[1].prompt.includes('"mode":"append"'));
  await f.post("/__native/resume", { url }, owner);
  // Retrying an old completed request returns its receipt, never another Send.
  await (await f.post("/v1internal:streamGenerateContent?alt=sse", next)).text(); assert.equal(received.length, 2);
  const otherTask = await f.post("/v1internal:streamGenerateContent?alt=sse", { ...request("other task"), sessionId: "other" });
  assert.match(await otherTask.text(), /continued/);
  assert.equal(received.length, 3);
  const otherBinding = received[2].conversation as { resumeUrl?: string; baseRevision?: string };
  assert.equal(otherBinding.resumeUrl, undefined);
  assert.equal(otherBinding.baseRevision, undefined);
  const realNow = Date.now(); t.mock.method(Date, "now", () => realNow + 300001);
  const expired = await f.post("/v1internal:streamGenerateContent?alt=sse", request("after expiry"));
  assert.equal(expired.status, 409); assert.equal((await expired.json()).error.details[0].reason, "RESUME_EXPIRED");
  assert.equal(received.length, 3); t.mock.restoreAll();
  assert.equal((await (await f.post("/__native/resume", { clear: true }, owner)).json()).armed, false);
});

test("Existing conversation recovery never falls back to a new Web chat or replays failed requests", { timeout: 5000 }, async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw new NativeRouteError("CONVERSATION_NOT_FOUND", "Open the selected conversation.", 409); });
  const owner = { "x-native-control-token": "owned-control" };
  await f.post("/__native/resume", { url: "https://gemini.google.com/app/missing", nextTurn: true }, owner);
  const body = request("Explicit new follow-up");
  for (let i = 0; i < 2; i++) assert.ok((await (await f.post("/v1internal:streamGenerateContent?alt=sse", body)).text()).includes("CONVERSATION_NOT_FOUND"));
  assert.equal(calls, 1); assert.equal((await (await fetch(f.url + "/__native/health")).json()).resumeArmed, false);
});

test("Persistent rebind to missing tab after account switch fails with CONVERSATION_NOT_OPEN at checkpoint before Send", { timeout: 5000 }, async t => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    const err = new NativeRouteError("CONVERSATION_NOT_OPEN", "Tab hội thoại không mở; kiểm tra trình duyệt.", 412);
    err.phase = "checkpoint";
    err.delivery = "not_sent";
    throw err;
  });
  const owner = { "x-native-control-token": "owned-control" };
  await f.post("/__native/resume", { url: "https://gemini.google.com/app/old_account_thread", nextTurn: true }, owner);
  const body = request("Follow up on old thread");
  const stream = await f.post("/v1internal:streamGenerateContent?alt=sse", body);
  const text = await stream.text();
  assert.ok(text.includes("CONVERSATION_NOT_OPEN"));
  assert.ok(text.includes("Tab hội thoại không mở; kiểm tra trình duyệt."));
  assert.equal(calls, 1);
  const health = await (await fetch(f.url + "/__native/health")).json();
  assert.equal(health.lastTurn.code, "CONVERSATION_NOT_OPEN");
  assert.equal(health.lastTurn.delivery, "not_sent");
  assert.equal(health.lastTurn.failurePhase, "checkpoint");
});

const request = (contents = "Read the authorized fixture.") => ({
  model: WEB_MODEL, sessionId: "fixture-session",
  request: { systemInstruction: { parts: [{ text: "Follow the user's task." }] },
    contents: [{ role: "user", parts: [{ text: contents }] }],
    tools: [{ functionDeclarations: [{ name: "view_file", parameters: { type: "OBJECT", required: ["AbsolutePath"], properties: { AbsolutePath: { type: "STRING" } }, additionalProperties: false } }] }],
  },
});
function reply(prompt: string, value: JsonObject) {
  const nonce = /"nonce":"([a-f0-9]{48})"/.exec(prompt)?.[1];
  assert.ok(nonce);
  return fence + "ag-native-response\n" + JSON.stringify({ nonce, ...value }) + "\n" + fence;
}
function temporary(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ag-native-route-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("ag-native-route-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
async function fixture(t: TestContext, generate: NativeBrowserBackend["generate"], generationTimeoutMs = 3000, stallTimeoutMs?: number, contextModelSelection?: { model: string; effort?: string }) {
  const root = temporary(t);
  const calls: Array<{ origin: string; route: string; headers: Record<string, string> }> = [];
  const control: ControlTransport = async (origin, route, _body, headers) => {
    calls.push({ origin, route, headers });
    return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(route.endsWith("loadCodeAssist")
      ? { paidTier: { usesGcpTos: false } } : { models: { native: { model: "MODEL_PLACEHOLDER_M650", displayName: "Native" } }, agentModelSorts: [{ groups: [{ modelIds: ["native"] }] }] })) };
  };
  const proxy = await startNativeProxy({ port: 0, stateDirectory: root, control, backend: { generate, close: async () => {} }, controlToken: "owned-control", generationTimeoutMs, stallTimeoutMs, contextModelSelection });
  t.after(() => proxy.close());
  const url = "http://127.0.0.1:" + proxy.port;
  const post = (route: string, body: unknown, extra?: Record<string, string>, signal?: AbortSignal) => fetch(url + route, { method: "POST", headers: { authorization: "Bearer fixture-only", "content-type": "application/json", ...extra }, body: JSON.stringify(body), signal });
  return { root, calls, proxy, url, post };
}

test("Health withdraws expired native results without removing their replay fences",async t=>{
  let sends=0;const f=await fixture(t,async(_id,prompt)=>{sends++;return reply(prompt,{type:"final",text:"temporary cache fixture"});});
  const body:any=request("expiry fixture");delete body.sessionId;
  assert.equal((await f.post("/v1internal:generateContent",body)).status,200);
  assert.equal((await fetch(f.url+"/__native/health").then(response=>response.json())).requestCache.retainedResults,1);
  const originalNow=Date.now,advanced=originalNow()+600001;
  try{
    Date.now=()=>advanced;
    const health=await fetch(f.url+"/__native/health").then(response=>response.json());assert.equal(health.requestCache.retainedResults,0);assert.equal(health.requestCache.retiredIdentities,1);
    const retry=await f.post("/v1internal:generateContent",body);assert.equal(retry.status,409);assert.match(JSON.stringify(await retry.json()),/OUTCOME_UNKNOWN/);assert.equal(sends,1);
  }finally{Date.now=originalNow;}
});

test("More than 128 native requests complete while evicted successes and uncertain failures cannot replay", { timeout: 20000 }, async t => {
  let sends = 0;
  const f = await fixture(t, async (_id, prompt) => {
    sends++;
    if (prompt.includes("uncertain-cache-failure")) throw new NativeRouteError("OUTCOME_UNKNOWN", "Synthetic lost acknowledgement", 502);
    return reply(prompt, { type: "final", text: "cached result" });
  });
  const body = (text: string) => { const value: any = request(text); delete value.sessionId; return value; };
  assert.equal((await f.post("/v1internal:generateContent", body("uncertain-cache-failure"))).status, 502);
  for (let i = 0; i < 140; i++) {
    const response = await f.post("/v1internal:generateContent", body("cache-turn-" + i));
    assert.equal(response.status, 200, "request " + i); await response.json();
  }
  for (const text of ["cache-turn-0", "uncertain-cache-failure"]) {
    const expired = await f.post("/v1internal:generateContent", body(text));
    assert.equal(expired.status, 409); assert.match(JSON.stringify(await expired.json()), /OUTCOME_UNKNOWN/);
  }
  assert.equal((await f.post("/v1internal:generateContent", body("cache-turn-139"))).status, 200);
  assert.equal(sends, 141);
  const health = await (await fetch(f.url + "/__native/health")).json();
  assert.ok(health.requestCache.retainedResults <= 32); assert.ok(health.requestCache.retiredIdentities >= 109);
});

test("Tool inventory cache preserves original schemas, isolates mutations and keeps policy per turn", () => {
  const body: any = request();
  const schema = body.request.tools[0].functionDeclarations[0].parameters;
  schema.$id = "https://fixtures.invalid/cached-inventory";
  schema.properties.toolAction = { type: "STRING", minLength: 4, description: "A detailed user-facing action label. ".repeat(15) };
  schema.properties.toolSummary = { type: "STRING", description: "A detailed user-facing purpose summary. ".repeat(15) };
  schema.required.push("toolAction");
  const first = compileNativeTurn(body), stats = nativeToolCacheStats();
  const second = compileNativeTurn(body);
  assert.equal(nativeToolCacheStats().hits, stats.hits + 1);
  assert.ok(first.toolDescriptionCharsSaved > 800);
  (first.context.tools[0] as any).parameters.properties.AbsolutePath.type = "number";
  const args = { AbsolutePath: "D:/owned.txt", toolAction: "Read file" };
  second.parseReply(reply(second.prompt, { type: "tool_call", name: "view_file", args }));
  assert.throws(() => second.parseReply(reply(second.prompt, { type: "tool_call", name: "view_file", args: { ...args, toolAction: "x" } })), { code: "TOOL_DENIED" });
  const none = compileNativeTurn({ ...body, request: { ...body.request, toolConfig: { functionCallingConfig: { mode: "NONE" } } } });
  assert.throws(() => none.parseReply(reply(none.prompt, { type: "tool_call", name: "view_file", args })), { code: "TOOL_DENIED" });
  const changed = structuredClone(body); changed.request.tools[0].functionDeclarations[0].parameters.properties.AbsolutePath.type = "NUMBER";
  const different = compileNativeTurn(changed);
  assert.throws(() => different.parseReply(reply(different.prompt, { type: "tool_call", name: "view_file", args })), { code: "TOOL_DENIED" });
  for (let i = 0; i < 20; i++) { const varied = structuredClone(body); varied.request.tools[0].functionDeclarations[0].description = "inventory " + i; compileNativeTurn(varied); }
  assert.ok(nativeToolCacheStats().entries <= 16);
  // An evicted inventory cannot invalidate a parser already held by an in-flight turn.
  second.parseReply(reply(second.prompt, { type: "tool_call", name: "view_file", args }));
});

test("Opt-in read batches work in ANY, AUTO and VALIDATED with schema, allowlist and mutation checks", () => {
  const body: any = request();
  const declarations = body.request.tools[0].functionDeclarations;
  declarations.push(...["list_dir", "grep_search", "run_command"].map(name => ({ ...structuredClone(declarations[0]), name })));
  const calls = ["view_file", "list_dir", "grep_search"].map(name => ({ name, args: { AbsolutePath: "D:/owned.txt" } }));
  for (const mode of ["ANY", "AUTO", "VALIDATED"]) {
    const envelope = { ...body, request: { ...body.request, toolConfig: { functionCallingConfig: { mode } } } };
    const compiled = compileNativeTurn(envelope, "", { batchToolCalls: true });
    const output: any = compiled.parseReply(reply(compiled.prompt, { type: "tool_calls", calls }));
    assert.deepEqual(output.response.candidates[0].content.parts.map((part: any) => part.functionCall.name), calls.map(call => call.name));
    for (const invalid of [[calls[0], calls[0]], [calls[0], { ...calls[1], name: "run_command" }], [calls[0], { ...calls[1], args: {} }]]) {
      assert.throws(() => compiled.parseReply(reply(compiled.prompt, { type: "tool_calls", calls: invalid })), { code: "TOOL_DENIED" });
    }
    const off = compileNativeTurn(envelope);
    assert.throws(() => off.parseReply(reply(off.prompt, { type: "tool_calls", calls })), { code: "TOOL_BATCH_DISABLED" });
  }
  const restricted = compileNativeTurn({ ...body, request: { ...body.request, toolConfig: { functionCallingConfig: { mode: "VALIDATED", allowedFunctionNames: ["view_file"] } } } }, "", { batchToolCalls: true });
  assert.throws(() => restricted.parseReply(reply(restricted.prompt, { type: "tool_calls", calls })), { code: "TOOL_DENIED" });
  const none = compileNativeTurn({ ...body, request: { ...body.request, toolConfig: { functionCallingConfig: { mode: "NONE" } } } }, "", { batchToolCalls: true });
  assert.throws(() => none.parseReply(reply(none.prompt, { type: "tool_calls", calls })), { code: "TOOL_BATCH_DISABLED" });
});

test("Native compilation preserves context/history while excluding outer transport credentials", () => {
  const body = { ...request("SECRET_USER_CONTENT"), authorization: "DO_NOT_FORWARD_AUTH", project: "DO_NOT_FORWARD_PROJECT" };
  const compiled = compileNativeTurn(body);
  assert.ok(compiled.prompt.includes("SECRET_USER_CONTENT"));
  assert.ok(compiled.prompt.includes("Follow the user's task."));
  assert.ok(!compiled.prompt.includes("DO_NOT_FORWARD_AUTH"));
  assert.ok(!compiled.prompt.includes("DO_NOT_FORWARD_PROJECT"));
  const output = compiled.parseReply(reply(compiled.prompt, { type: "tool_call", name: "view_file", args: { AbsolutePath: "D:/owned/file.txt" } }));
  assert.equal((output.response as any).candidates[0].content.parts[0].functionCall.name, "view_file");
});

test("Native envelope discards renderer metadata but preserves nonce and schema authority", () => {
  const compiled = compileNativeTurn(request());
  const output = compiled.parseReply(reply(compiled.prompt, {
    type: "tool_call", name: "view_file", args: { AbsolutePath: "D:/owned/file.txt" },
    id: "renderer-call-id", provider: "Gemini Web", thought: "metadata never reaches the IDE executor",
  }));
  const call = (output.response as any).candidates[0].content.parts[0].functionCall;
  assert.deepEqual(call, { id: call.id, name: "view_file", args: { AbsolutePath: "D:/owned/file.txt" } });
  assert.throws(() => compiled.parseReply(reply(compiled.prompt, {
    type: "tool_call", name: "view_file", provider: "metadata without arguments",
  })), { code: "TOOL_DENIED" });
  assert.throws(() => compiled.parseReply(reply(compiled.prompt, {
    type: "tool_call", name: "view_file", args: null,
  })), error => {
    assert.equal((error as NativeRouteError).code, "INVALID_MODEL_ENVELOPE");
    assert.deepEqual((error as NativeRouteError).diagnostic, {
      stage: "schema", envelope: { kind: "object", keys: ["args", "name", "nonce", "type"], type: "tool_call" },
      issues: [{ code: "invalid_type", path: ["args"] }],
    });
    return true;
  });
});

test("Native wire tool descriptions are bounded while full local schemas still validate replies", () => {
  const body: any = structuredClone(request());
  const declaration = body.request.tools[0].functionDeclarations[0];
  const long = "Briefly describe this tool and its safety boundaries. " + "Verbose provider documentation and examples. ".repeat(80);
  declaration.description = long;
  declaration.parameters.properties.AbsolutePath.description = long;
  const compiled = compileNativeTurn(body);
  const wireDeclaration: any = compiled.context.tools[0];
  assert.ok(wireDeclaration.description.length <= 320);
  assert.ok(wireDeclaration.parameters.properties.AbsolutePath.description.length <= 220);
  assert.ok(compiled.toolDescriptionCharsSaved > 1000);
  assert.equal((compiled.parseReply(reply(compiled.prompt, { type: "tool_call", name: "view_file", args: { AbsolutePath: "D:/workspace/file.txt" } })).response as any).candidates[0].content.parts[0].functionCall.name, "view_file");
  assert.throws(() => compiled.parseReply(reply(compiled.prompt, { type: "tool_call", name: "view_file", args: { AbsolutePath: 7 } })), { code: "TOOL_DENIED" });
});

test("Native provider leaves model and thinking level under the user's control in Gemini Web", { timeout: 5000 }, async t => {
  let receivedSelection: unknown = "not-called";
  const f = await fixture(t, async (_id, prompt, _signal, options) => {
    receivedSelection = options?.modelSelection;
    return reply(prompt, { type: "final", text: "uses the web selection" });
  });
  const response = await f.post("/v1internal:generateContent", request("use selected Web model"));
  assert.equal(response.status, 200); assert.equal(receivedSelection, undefined);
  const health = await (await fetch(f.url + "/__native/health")).json();
  assert.equal(health.modelSelection, null); assert.equal(health.modelSelectionMode, "user_selected_in_web");
});

test("Context staging model is limited to full loads; short append and patch go directly to the primary model", { timeout: 10000 }, async t => {
  const contextModel = { model: "3.8 Flash" }, observed: Array<{ mode: string; model: unknown; messages: number; chars: number }> = [];
  const initial = request("INITIAL_CONTEXT_".repeat(2400)), append = structuredClone(initial);
  append.request.contents.push({ role: "model", parts: [{ text: "ok" }] }, { role: "user", parts: [{ text: "FOLLOWUP_CONTEXT_".repeat(750) }] });
  const patch = structuredClone(append); patch.request.systemInstruction.parts[0].text += " Updated host rule.";
  const replacement = { model: WEB_MODEL, sessionId: initial.sessionId, request: { contents: [{ role: "user", parts: [{ text: "Compact host history" }] }] } };
  const fresh: any = request("Fresh task without a stable session identity"); delete fresh.sessionId;
  const f = await fixture(t, async (_id, prompt, _signal, options) => {
    const context = JSON.parse(prompt.split("<native_context_json>\n")[1].split("\n</native_context_json>")[0]);
    const messages = nativeBrowserTransport(prompt, options?.conversation?.revision, options?.conversation?.baseRevision, !!options?.contextModelSelection);
    observed.push({ mode: context.mode ?? "full", model: options?.contextModelSelection, messages: messages.length, chars: prompt.length });
    return reply(prompt, { type: "final", text: "ok" });
  }, 3000, undefined, contextModel);
  for (const body of [initial, append, patch, replacement, fresh]) assert.equal((await f.post("/v1internal:generateContent", body)).status, 200);
  assert.deepEqual(observed.map(value => value.mode), ["full", "append", "patch", "replace", "full"]);
  assert.deepEqual(observed.map(value => value.model), [contextModel, undefined, undefined, undefined, contextModel]);
  assert.ok(observed[1]!.chars < 28000); assert.deepEqual(observed.slice(1, 4).map(value => value.messages), [1, 1, 1]);
  assert.ok(observed[0]!.messages > 1 && observed[4]!.messages > 1);
});

test("HTTP context updates retain one lease, reconstruct host state and reject revoked tools without resending", { timeout: 10000 }, async t => {
  let receiver: any, revision: string | undefined, key: string | undefined, calls = 0;
  const bodies = [request("INITIAL_CONTEXT_".repeat(3500))];
  const append = structuredClone(bodies[0]);
  append.request.contents.push({ role: "model", parts: [{ text: "ready" }] }, { role: "user", parts: [{ text: "Next instruction" }] }); bodies.push(append);
  const edited = structuredClone(append);
  edited.request.systemInstruction.parts[0].text = "Read only. Current rules supersede previous rules.";
  edited.request.contents[1].parts[0].text = "updated IDE history";
  edited.request.tools = []; bodies.push(edited);
  const f = await fixture(t, async (_id, prompt, _signal, options) => {
    const body = JSON.parse(prompt.split("<native_context_json>\n")[1].split("\n</native_context_json>")[0]);
    if (!calls) { const { revision: initialRevision, ...context } = body; receiver = context; revision = initialRevision; key = options!.conversation!.key; }
    else {
      assert.equal(body.baseRevision, revision); assert.equal(options!.conversation!.key, key);
      assert.ok(prompt.length < 3000); assert.ok(!prompt.includes("INITIAL_CONTEXT_"));
      if (body.mode === "append") { assert.equal(body.appendFrom, receiver.contents.length); receiver.contents.push(...body.contents); }
      else if (body.mode === "patch") receiver = applyContextPatch(receiver, body.patches);
      else receiver = body.context;
      revision = body.revision;
    }
    assert.deepEqual(receiver, wireValue(compileNativeTurn(bodies[calls]).context));
    calls++;
    return reply(prompt, calls === 3 ? { type: "tool_call", name: "view_file", args: { AbsolutePath: "D:/fixture.txt" } } : { type: "final", text: "ok" });
  });
  for (let index = 0; index < bodies.length; index++) {
    const response = await f.post("/v1internal:streamGenerateContent?alt=sse", bodies[index]);
    const text = await response.text();
    if (index < 2) assert.ok(text.includes('"text":"ok"'));
    else { assert.ok(text.includes("TOOL_DENIED")); assert.ok(!text.includes('"functionCall"')); }
  }
  assert.equal(calls, 3); assert.equal(f.proxy.counters.completed, 2);
  const retry = await (await f.post("/v1internal:streamGenerateContent?alt=sse", bodies[2])).text();
  assert.ok(retry.includes("TOOL_DENIED")); assert.equal(calls, 3);
  const health = await (await fetch(f.url + "/__native/health")).json();
  assert.equal(health.lastTurn.contextMode, "patch"); assert.ok(health.lastTurn.savedPromptChars > 40000);
});

test("Stale nonces, invented tools, invalid types and ambiguous response blocks never become native calls", () => {
  const compiled = compileNativeTurn(request());
  assert.throws(() => compiled.parseReply(fence + "ag-native-response\n" + JSON.stringify({ nonce: "stale", type: "final", text: "x" }) + "\n" + fence), { code: "STALE_MODEL_AUTHORITY" });
  assert.throws(() => compiled.parseReply(reply(compiled.prompt, { type: "tool_call", name: "run_command", args: {} })), { code: "TOOL_DENIED" });
  assert.throws(() => compiled.parseReply(reply(compiled.prompt, { type: "tool_call", name: "view_file", args: { AbsolutePath: 123 } })), { code: "TOOL_DENIED" });
  const valid = reply(compiled.prompt, { type: "final", text: "ok" });
  assert.throws(() => compiled.parseReply(valid + "\n" + valid), { code: "INVALID_MODEL_ENVELOPE" });
  assert.throws(() => compiled.parseReply("Here is a shell command: " + valid), { code: "INVALID_MODEL_ENVELOPE" });
});

test("A normal Web final answer is accepted when tools are optional, while attempted protocol and required-tool replies stay strict", () => {
  const compiled = compileNativeTurn(request());
  const plain = compiled.parseReply("The project review is ready.") as any;
  assert.equal(plain.response.candidates[0].content.parts[0].text, "The project review is ready.");
  const jsonFence = reply(compiled.prompt, { type: "final", text: "JSON fence is accepted" }).replace("ag-native-response", "json");
  assert.equal((compiled.parseReply(jsonFence) as any).response.candidates[0].content.parts[0].text, "JSON fence is accepted");
  assert.throws(() => compiled.parseReply('{"type":"tool_call","name":"view_file","args":{}}'), { code: "INVALID_MODEL_ENVELOPE" });
  const required = compileNativeTurn({ ...request(), request: { ...request().request, toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["view_file"] } } } });
  assert.throws(() => required.parseReply("I cannot call a tool."), { code: "TOOL_REQUIRED" });
});

test("Browser transport keeps ordinary code examples but selects exactly one native protocol block", () => {
  const explanation = "Use this example:\nconst answer = 42;";
  assert.equal(selectNativeBrowserReply(explanation, ["const answer = 42;"]), explanation);
  const envelope = '{"nonce":"' + "a".repeat(48) + '","type":"final","text":"ok"}';
  assert.equal(selectNativeBrowserReply("Rendered response", [envelope]), envelope);
  assert.throws(() => selectNativeBrowserReply("Rendered response", [envelope, envelope]), { code: "AMBIGUOUS_MODEL_REPLY" });
});

test("Oversized contexts, attachments and duplicate tool names fail without truncation", () => {
  assert.throws(() => compileNativeTurn(request("x".repeat(MAX_NATIVE_PROMPT_CHARS))), { code: "CONTEXT_TOO_LARGE" });
  const image = request();
  (image.request.contents[0].parts as unknown[]).push({ inlineData: { mimeType: "image/png", data: "not-uploaded" } });
  assert.throws(() => compileNativeTurn(image), { code: "UNSUPPORTED_CONTENT" });
  const duplicate = request();
  duplicate.request.tools.push(duplicate.request.tools[0]);
  assert.throws(() => compileNativeTurn(duplicate), { code: "AMBIGUOUS_TOOL" });
});

test("Per-request schemas and function policy cannot reuse or exceed another turn's tool authority", () => {
  const body = request();
  Object.assign(body.request.tools[0].functionDeclarations[0].parameters, { $id: "https://fixtures.invalid/native-tool-args" });
  body.request.tools[0].functionDeclarations.push({ name: "other_tool", parameters: { type: "OBJECT", required: ["AbsolutePath"], properties: { AbsolutePath: { type: "STRING" } }, additionalProperties: false } });
  // Repeated $id across independent turns must not collide in a process-wide schema registry.
  compileNativeTurn(body); compileNativeTurn(body);
  const configured = (config: unknown) => compileNativeTurn({ ...body, request: { ...body.request, toolConfig: { functionCallingConfig: config } } });
  const none = configured({ mode: "NONE" });
  assert.deepEqual(none.toolNames, []);
  assert.throws(() => none.parseReply(reply(none.prompt, { type: "tool_call", name: "view_file", args: { AbsolutePath: "D:/owned.txt" } })), { code: "TOOL_DENIED" });
  none.parseReply(reply(none.prompt, { type: "final", text: "No tools were used." }));
  const allowed = configured({ mode: "ANY", allowedFunctionNames: ["view_file"] });
  allowed.parseReply(reply(allowed.prompt, { type: "tool_call", name: "view_file", args: { AbsolutePath: "D:/owned.txt" } }));
  assert.throws(() => allowed.parseReply(reply(allowed.prompt, { type: "tool_call", name: "other_tool", args: { AbsolutePath: "D:/owned.txt" } })), { code: "TOOL_DENIED" });
  assert.throws(() => allowed.parseReply(reply(allowed.prompt, { type: "final", text: "Skipped the required call." })), { code: "TOOL_REQUIRED" });
  assert.throws(() => configured({ mode: "VALIDATED", allowedFunctionNames: ["invented"] }), { code: "INVALID_TOOL_CONFIG" });
  assert.throws(() => configured({ mode: "AUTO", allowedFunctionNames: ["view_file"] }), { code: "INVALID_TOOL_CONFIG" });
  assert.throws(() => configured({ mode: "UNKNOWN" }), { code: "INVALID_TOOL_CONFIG" });
});

test("Changed transport IDs cannot repeat a browser Send; native session and ordered context remain distinct", () => {
  const original = { ...request(), requestId: "transport-one", traceId: "trace-one" };
  assert.equal(compileNativeTurn(original).requestId, compileNativeTurn({ ...original, requestId: "transport-two", traceId: "trace-two" }).requestId);
  assert.notEqual(compileNativeTurn(original).requestId, compileNativeTurn({ ...original, sessionId: "another-session" }).requestId);
  assert.notEqual(compileNativeTurn(original).requestId, compileNativeTurn(request("different content")).requestId);
});

test("Native model identity survives restart and refuses a newly occupied reserved enum", t => {
  const root = temporary(t), file = path.join(root, "identity.json");
  const first = new NativeModelIdentity(file);
  const merged = first.merge({ models: { native: { model: "MODEL_PLACEHOLDER_M650" } } });
  assert.ok((merged.models as JsonObject)[WEB_CATALOG_MODEL]);
  assert.equal((merged.models as JsonObject)[WEB_MODEL], undefined);
  assert.equal(first.matches(WEB_CATALOG_MODEL), true);
  assert.equal(first.matches("models/" + WEB_CATALOG_MODEL), true);
  assert.equal(first.symbol, "MODEL_PLACEHOLDER_M649");
  const second = new NativeModelIdentity(file);
  assert.equal(second.symbol, first.symbol);
  assert.throws(() => second.merge({ models: { changed: { model: first.symbol } } }), { code: "MODEL_IDENTITY_CONFLICT" });
});

test("Real HTTP control forwarding preserves account routing and leaves native catalog entries intact", async t => {
  const f = await fixture(t, async () => { throw Error("No generation expected"); });
  assert.equal((await f.post("/v1internal:loadCodeAssist", {})).status, 200);
  const catalog = await (await f.post("/v1internal:fetchAvailableModels", {}, { cookie: "must-not-forward" })).json();
  assert.equal(catalog.models.native.model, "MODEL_PLACEHOLDER_M650");
  assert.equal(catalog.models[WEB_CATALOG_MODEL].model, "MODEL_PLACEHOLDER_M649");
  assert.equal(catalog.models[WEB_CATALOG_MODEL].supportsImages, false);
  assert.equal(catalog.models[WEB_CATALOG_MODEL].modelExperiments, undefined);
  assert.equal(catalog.models[WEB_MODEL], undefined);
  assert.equal(f.calls[0].origin, "https://cloudcode-pa.googleapis.com");
  assert.equal(f.calls[1].origin, "https://daily-cloudcode-pa.googleapis.com");
  assert.equal(f.calls[1].headers.cookie, undefined);
  assert.deepEqual(catalog.agentModelSorts[0].groups[0].modelIds, ["native", WEB_CATALOG_MODEL]);
});

test("Array native catalogs advertise a complete custom list entry", t => {
  const root = temporary(t), identity = new NativeModelIdentity(path.join(root, "identity.json"));
  const catalog = identity.merge({ models: [{ name: "models/native", model: "MODEL_PLACEHOLDER_M650" }] });
  const entry = (catalog.models as JsonObject[])[0];
  assert.deepEqual(entry, {
    displayName: "Gemini Web (Local)", supportsImages: false, supportsThinking: false, supportsVideo: false,
    supportedMimeTypes: { "text/plain": true }, name: "models/" + WEB_CATALOG_MODEL, version: "1.0",
    description: "Uses the signed-in Gemini Web conversation in this local browser.",
    inputTokenLimit: 100000, outputTokenLimit: 8192, supportedGenerationMethods: ["generateContent", "countTokens"],
  });
});

test("HTTP fixture tool loop returns the real executor fixture file content through native functionResponse", async t => {
  const marker = "ACTUAL_FIXTURE_BYTES_" + Date.now();
  let browserCalls = 0;
  const f = await fixture(t, async (_id, prompt) => {
    browserCalls++;
    return reply(prompt, browserCalls === 1
      ? { type: "tool_call", name: "view_file", args: { AbsolutePath: path.join(f.root, "owned.txt") } }
      : { type: "final", text: prompt.includes(marker) ? marker : "MISSING_TOOL_RESULT" });
  });
  fs.writeFileSync(path.join(f.root, "owned.txt"), marker);
  const one = await (await f.post("/v1internal:generateContent", request())).json();
  const call = one.response.candidates[0].content.parts[0].functionCall;
  assert.equal(call.name, "view_file");
  // The fixture executor, not the proxy or browser, owns the file operation.
  const bytes = fs.readFileSync(call.args.AbsolutePath, "utf8");
  const next = request() as any;
  next.request.contents.push({ role: "model", parts: [{ functionCall: call }] }, { role: "user", parts: [{ functionResponse: { id: call.id, name: call.name, response: { content: bytes } } }] });
  const two = await (await f.post("/v1internal:generateContent", next)).json();
  assert.equal(two.response.candidates[0].content.parts[0].text, marker);
  assert.equal(browserCalls, 2);
  assert.equal(f.calls.length, 0, "No native generation may fall back to a Google API");
});

test("Concurrent HTTP retries and terminal retries send only once and preserve the response identity", async t => {
  let sends = 0;
  const f = await fixture(t, async (_id, prompt) => {
    sends++; await new Promise(resolve => setTimeout(resolve, 30)); return reply(prompt, { type: "final", text: "ONCE" });
  });
  const body = request("same native round");
  const responses = await Promise.all([f.post("/v1internal:generateContent", body), f.post("/v1internal:generateContent", body)]);
  const first = await responses[0].json(), second = await responses[1].json();
  assert.deepEqual(first, second);
  assert.deepEqual(await (await f.post("/v1internal:generateContent", body)).json(), first);
  assert.equal(sends, 1);
});

test("SSE emits bound native candidates, and an unsupported selected model never falls back", async t => {
  const f = await fixture(t, async (_id, prompt) => reply(prompt, { type: "final", text: "SSE_NATIVE_OK" }));
  const stream = await f.post("/v1internal:streamGenerateContent?alt=sse", request());
  assert.match(stream.headers.get("content-type")!, /text\/event-stream/);
  const text = await stream.text();
  const data = JSON.parse(text.split("\n").find(line => line.startsWith("data: "))!.slice(6));
  assert.equal(data.response.candidates[0].content.parts[0].text, "SSE_NATIVE_OK");
  const denied = await f.post("/v1internal:generateContent", { ...request(), model: "native-google-model" });
  assert.equal(denied.status, 409);
  const deniedError = (await denied.json()).error;
  assert.equal(deniedError.code, 409); assert.equal(deniedError.details[0].reason, "NATIVE_MODEL_NOT_SELECTED");
  assert.equal(f.calls.length, 0);
  const health = await (await fetch(f.url + "/__native/health")).json();
  assert.deepEqual(health.lastTurn, {
    phase: "model_selection", status: "rejected", code: "NATIVE_MODEL_NOT_SELECTED",
    receivedModelSelectors: { model: "native-google-model" }, expectedModel: WEB_MODEL,
  });
  assert.equal(health.upstreamCatalog, undefined);
  await f.post("/v1internal:fetchAvailableModels", {});
  const catalogHealth = await (await fetch(f.url + "/__native/health")).json();
  assert.equal(catalogHealth.upstreamCatalog.references[0].key, "native");
  assert.equal(catalogHealth.upstreamCatalog.references[0].model, "MODEL_PLACEHOLDER_M650");
});

test("Cross-origin calls, unauthenticated requests, arbitrary paths and unauthorized shutdown are rejected", async t => {
  const f = await fixture(t, async () => { throw Error("No generation expected"); });
  assert.equal((await f.post("/v1internal:generateContent", request(), { origin: "https://untrusted.invalid" })).status, 403);
  assert.equal((await f.post("/v1internal:generateContent", request(), { authorization: "" })).status, 401);
  assert.equal((await f.post("/v1internal:https://untrusted.invalid/", {})).status, 404);
  assert.equal((await fetch(f.url + "/__native/stop", { method: "POST" })).status, 401);
  assert.equal(f.proxy.counters.browserRequests, 0);
});

test("A generation deadline aborts the browser request and an uncertain failure is never resent", async t => {
  let sends = 0, aborted = false;
  const f = await fixture(t, async (_id, _prompt, signal, generationOptions) => {
    generationOptions?.onSubmissionStarted?.();
    sends++;
    await new Promise<void>(() => signal.addEventListener("abort", () => { aborted = true; }, { once: true })); // Deliberately uncooperative: the proxy still enforces its deadline.
    return "unreachable";
  }, 30);
  const body = request("slow");
  assert.equal((await f.post("/v1internal:generateContent", body)).status, 504);
  assert.equal((await f.post("/v1internal:generateContent", body)).status, 504);
  assert.equal(sends, 1); assert.equal(aborted, true); assert.equal(f.proxy.counters.active, 0);
});

test("Native progress extends only the idle budget and cannot exceed the independent hard duration", { timeout: 5000 }, async t => {
  const quiet = await fixture(t, async () => new Promise(() => {}), 1000, 60);
  const started = performance.now();
  assert.equal((await quiet.post("/v1internal:generateContent", request("silent"))).status, 504);
  assert.ok(performance.now() - started < 700);
  const progressing = await fixture(t, async (_id, prompt, signal, options) => {
    let revision = 0;
    const timer = setInterval(() => options!.onProgress!({ revision: ++revision, text: "observable " + revision }), 20);
    signal.addEventListener("abort", () => clearInterval(timer), { once: true });
    try { await new Promise(resolve => setTimeout(resolve, 160)); return reply(prompt, { type: "final", text: "progress completed" }); }
    finally { clearInterval(timer); }
  }, 1000, 90);
  assert.equal((await progressing.post("/v1internal:generateContent", request("progress"))).status, 200);
  const hard = await fixture(t, async (_id, _prompt, signal, options) => {
    options?.onSubmissionStarted?.();
    let revision = 0;
    const timer = setInterval(() => options!.onProgress!({ revision: ++revision, text: "observable " + revision }), 20);
    signal.addEventListener("abort", () => clearInterval(timer), { once: true });
    return new Promise(() => {});
  }, 160, 90);
  assert.equal((await hard.post("/v1internal:generateContent", request("hard limit"))).status, 504);
  assert.equal(hard.proxy.counters.active, 0);
});

test("Native HTTP disconnect propagates abort without waiting for a browser result", { timeout: 5000 }, async t => {
  let resolve!: () => void;
  const observed = new Promise<void>(r => { resolve = r; });
  const f = await fixture(t, async (_id, _prompt, signal) => { signal.addEventListener("abort", resolve, { once: true }); return new Promise(() => {}); });
  const controller = new AbortController();
  const response = await f.post("/v1internal:streamGenerateContent?alt=sse", request("cancel socket"), undefined, controller.signal);
  await response.body!.getReader().read(); controller.abort(); await observed;
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.proxy.counters.active, 0);
});

test("Isolated profile setup is idempotent, restores only owned bytes and refuses external changes", t => {
  const root = temporary(t), endpoint = "http://127.0.0.1:9236";
  const first = configureIsolatedProfile(root, endpoint);
  assert.equal(configureIsolatedProfile(root, endpoint).action, "unchanged");
  const settings = JSON.parse(fs.readFileSync(first.settings, "utf8"));
  assert.equal(settings["jetski.cloudCodeUrl"], endpoint);
  fs.writeFileSync(first.settings, "{\"external\":true}");
  assert.throws(() => configureIsolatedProfile(root, endpoint, "restore"), { code: "CONFIG_CONFLICT" });
  assert.equal(fs.readFileSync(first.settings, "utf8"), "{\"external\":true}");
  const fresh = path.join(root, "fresh");
  const configured = configureIsolatedProfile(fresh, endpoint);
  assert.equal(configureIsolatedProfile(fresh, endpoint, "restore").action, "restored");
  assert.equal(fs.existsSync(configured.settings), false);
  const edited = configureIsolatedProfile(path.join(root, "edited"), endpoint);
  const editedJson = JSON.parse(fs.readFileSync(edited.settings, "utf8"));
  editedJson["workbench.colorTheme"] = "User theme"; editedJson["window.title"] = "User title";
  fs.writeFileSync(edited.settings, JSON.stringify(editedJson));
  assert.equal(configureIsolatedProfile(path.join(root, "edited"), endpoint).action, "unchanged");
  configureIsolatedProfile(path.join(root, "edited"), endpoint, "restore");
  assert.deepEqual(JSON.parse(fs.readFileSync(edited.settings, "utf8")), { "workbench.colorTheme": "User theme", "window.title": "User title" });
  assert.throws(() => configureIsolatedProfile(path.join(root, "bad"), "http://untrusted.invalid:9236"), { code: "INVALID_ENDPOINT" });
});
