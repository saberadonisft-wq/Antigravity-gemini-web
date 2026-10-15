import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileNativeTurn, MAX_NATIVE_PROMPT_CHARS, WEB_MODEL, NativeRouteError, type JsonObject } from "./native-protocol.js";
import { startNativeProxy, NativeModelIdentity, type ControlTransport } from "./native-proxy.js";
import { configureIsolatedProfile } from "./installation.js";
import type { NativeBrowserBackend } from "./browser-backend.js";

const fence = String.fromCharCode(96).repeat(3);
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
async function fixture(t: TestContext, generate: NativeBrowserBackend["generate"], generationTimeoutMs = 3000) {
  const root = temporary(t);
  const calls: Array<{ origin: string; route: string; headers: Record<string, string> }> = [];
  const control: ControlTransport = async (origin, route, _body, headers) => {
    calls.push({ origin, route, headers });
    return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(route.endsWith("loadCodeAssist")
      ? { paidTier: { usesGcpTos: false } } : { models: { native: { model: "MODEL_PLACEHOLDER_M650", displayName: "Native" } }, agentModelSorts: [{ groups: [{ modelIds: ["native"] }] }] })) };
  };
  const proxy = await startNativeProxy({ port: 0, stateDirectory: root, control, backend: { generate, close: async () => {} }, controlToken: "owned-control", generationTimeoutMs });
  t.after(() => proxy.close());
  const url = "http://127.0.0.1:" + proxy.port;
  const post = (route: string, body: unknown, extra?: Record<string, string>, signal?: AbortSignal) => fetch(url + route, { method: "POST", headers: { authorization: "Bearer fixture-only", "content-type": "application/json", ...extra }, body: JSON.stringify(body), signal });
  return { root, calls, proxy, url, post };
}

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

test("Stale nonces, invented tools, invalid types and ambiguous response blocks never become native calls", () => {
  const compiled = compileNativeTurn(request());
  assert.throws(() => compiled.parseReply(fence + "ag-native-response\n" + JSON.stringify({ nonce: "stale", type: "final", text: "x" }) + "\n" + fence), { code: "STALE_MODEL_AUTHORITY" });
  assert.throws(() => compiled.parseReply(reply(compiled.prompt, { type: "tool_call", name: "run_command", args: {} })), { code: "TOOL_DENIED" });
  assert.throws(() => compiled.parseReply(reply(compiled.prompt, { type: "tool_call", name: "view_file", args: { AbsolutePath: 123 } })), { code: "TOOL_DENIED" });
  const valid = reply(compiled.prompt, { type: "final", text: "ok" });
  assert.throws(() => compiled.parseReply(valid + "\n" + valid), { code: "INVALID_MODEL_ENVELOPE" });
  assert.throws(() => compiled.parseReply("Here is a shell command: " + valid), { code: "INVALID_MODEL_ENVELOPE" });
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
  assert.ok((merged.models as JsonObject)[WEB_MODEL]);
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
  assert.equal(catalog.models[WEB_MODEL].model, "MODEL_PLACEHOLDER_M649");
  assert.equal(catalog.models[WEB_MODEL].supportsImages, false);
  assert.equal(f.calls[0].origin, "https://cloudcode-pa.googleapis.com");
  assert.equal(f.calls[1].origin, "https://daily-cloudcode-pa.googleapis.com");
  assert.equal(f.calls[1].headers.cookie, undefined);
  assert.deepEqual(catalog.agentModelSorts[0].groups[0].modelIds, ["native", WEB_MODEL]);
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
  assert.equal((await denied.json()).error.code, "NATIVE_MODEL_NOT_SELECTED");
  assert.equal(f.calls.length, 0);
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
  const f = await fixture(t, async (_id, _prompt, signal) => {
    sends++;
    await new Promise<void>(() => signal.addEventListener("abort", () => { aborted = true; }, { once: true })); // Deliberately uncooperative: the proxy still enforces its deadline.
    return "unreachable";
  }, 30);
  const body = request("slow");
  assert.equal((await f.post("/v1internal:generateContent", body)).status, 504);
  assert.equal((await f.post("/v1internal:generateContent", body)).status, 504);
  assert.equal(sends, 1); assert.equal(aborted, true); assert.equal(f.proxy.counters.active, 0);
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
