// Local protocol caller + real Gemini Web. This does not certify IDE UI Cancel.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NATIVE_RUNTIME_REVISION } from "../../packages/native-antigravity/dist/native-proxy.js";

const endpoint = "http://127.0.0.1:9236";
const health = async () => {
  const response = await fetch(endpoint + "/__native/health", { signal: AbortSignal.timeout(2000) });
  const status = await response.json();
  if (!response.ok || status.service !== "gemini-native-proxy") throw Error("Unexpected local service");
  return status;
};
const initial = await health();
if (!process.argv.includes("--live")) {
  console.log(JSON.stringify({ runtimeRevision: initial.runtimeRevision, modelSelection: initial.modelSelection, deadlines: initial.deadlines, active: initial.counters.active, livePromptsSent: 0 }));
} else {
  assert.equal(initial.runtimeRevision, NATIVE_RUNTIME_REVISION); assert.equal(initial.counters.active, 0);
  const evidence = { checkedAt: new Date().toISOString(), caller: "synthetic_loopback_protocol_client", browser: "real_Gemini_Web", ideUiCancel: "NOT_TESTED", modelSelection: initial.modelSelection, turns: [], status: "RUNNING" };
  const file = path.resolve("docs/evidence/mcp/native-latency-live.json");
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), 90000);
  const sessionId = "native_smoke_" + randomUUID();
  const contents = [];
  async function begin(text, id = sessionId) {
    contents.push({ role: "user", parts: [{ text }] });
    const response = await fetch(endpoint + "/v1internal:streamGenerateContent?alt=sse", { method: "POST", headers: { authorization: "Bearer synthetic-local-acceptance", "content-type": "application/json" }, body: JSON.stringify({ model: "antigravity-gemini-web", sessionId: id, request: { contents: id === sessionId ? contents : [contents.at(-1)] } }), signal: controller.signal });
    if (!response.ok) throw Error("HTTP_" + response.status);
    const started = performance.now(); let firstTextMs, parts = [], frames = 0, finish, failure, traceId;
    const reading = (async () => {
      const decoder = new TextDecoder(); let buffered = "";
      for await (const bytes of response.body) {
        buffered += decoder.decode(bytes, { stream: true });
        for (;;) {
          const index = buffered.indexOf("\n"); if (index < 0) break;
          const line = buffered.slice(0, index); buffered = buffered.slice(index + 1);
          if (!line.startsWith("data: ")) continue;
          const value = JSON.parse(line.slice(6)); frames++;
          traceId ??= value.traceId;
          if (value.error) failure = value.error.status;
          const candidate = value.response?.candidates?.[0];
          if (candidate?.content?.parts) for (const part of candidate.content.parts) if (typeof part.text === "string") { if (part.text) firstTextMs ??= Math.round(performance.now() - started); parts.push(part.text); }
          if (candidate?.finishReason) finish = candidate.finishReason;
        }
      }
      const observed = { elapsedMs: Math.round(performance.now() - started), firstTextMs: firstTextMs ?? null, frames, finish, failure, proxy: (await health()).lastTurn };
      if (observed.proxy?.requestId === traceId && observed.proxy.phase === "failed") failure = observed.failure = observed.proxy.code;
      evidence.turns.push(observed); console.log(JSON.stringify(observed));
      return { text: parts.join(""), failure, finish };
    })();
    void reading.catch(() => {});
    return reading;
  }
  try {
    // A long synthetic prefix makes suffix transfer reduction measurable without source/user data.
    const first = await begin("Synthetic fixture data, no tools needed. " + "fixture-data-0123456789 ".repeat(400) + "\nReply exactly NATIVE_STREAM_ONE.");
    assert.equal(first.failure, undefined); assert.equal(first.text.trim(), "NATIVE_STREAM_ONE");
    contents.push({ role: "model", parts: [{ text: first.text }] });
    const second = await begin("Continue this same fixture conversation. Reply exactly NATIVE_STREAM_TWO.");
    assert.equal(second.failure, undefined); assert.equal(second.text.trim(), "NATIVE_STREAM_TWO");
    assert.equal(evidence.turns[1].proxy.reused, true); assert.ok(evidence.turns[1].proxy.promptChars < evidence.turns[1].proxy.fullPromptChars);
    // Start a separate task, wait for observed Web generation, then cancel the owned turn.
    const cancellation = begin("Write a very long list of the integers from 1 to 20000, with explanations. No tools.", "cancel_smoke_" + randomUUID());
    void cancellation.catch(() => {});
    const waitUntil = performance.now() + 30000;
    let generating = false;
    while (performance.now() < waitUntil) {
      const status = await health();
      if (["generating", "responding"].includes(status.lastTurn?.phase) && status.counters.active > 0) { generating = true; break; }
      if (status.lastTurn?.phase === "failed") break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(generating, true, "Cancellation must be tested after observable Web generation");
    const owner = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".gemini/antigravity-gemini-web-live/app_data/native-route/proxy-owner.json"), "utf8"));
    const status = await health(); assert.equal(owner.pid, status.pid); assert.equal(owner.endpoint, endpoint);
    const stopped = await fetch(endpoint + "/__native/cancel", { method: "POST", headers: { "x-native-control-token": owner.controlToken }, signal: AbortSignal.timeout(3000) });
    assert.equal(stopped.ok, true); assert.equal((await stopped.json()).cancelRequested, 1);
    const cancelled = await cancellation; assert.equal(cancelled.failure, "CANCELLED"); assert.equal(cancelled.finish, "STOP");
    assert.equal((await health()).counters.active, 0);
    const client = new Client({ name: "native-cancel-observer", version: "1" });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve("packages/mcp-server/dist/cli.js")], env: { AG_MCP_TARGET_CLIENT: "any" }, stderr: "pipe" }), { timeout: 5000 });
      const read = async (name, args) => {
        const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
        assert.notEqual(result.isError, true);
        return JSON.parse(result.content.find(part => part.type === "text").text);
      };
      const cancelledId = evidence.turns.at(-1).proxy.requestId;
      const cleanupDeadline = performance.now() + 10000;
      let status, result;
      do {
        result = await read("gemini_result", { request_id: cancelledId, wait_ms: 500 });
        status = await read("gemini_status", {});
        if (result.status !== "pending" && status.activeRequestId === null) break;
        if (status.activeRequestId && status.activeRequestId !== cancelledId) throw Error("Another task owns the browser");
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (performance.now() < cleanupDeadline);
      evidence.afterCancel = { checkedAt: new Date().toISOString(), activeRequestId: status.activeRequestId, browserState: status.browserState, accountState: status.accountState, browserTurnStatus: result.status, errorCode: result.error?.code, retainedConversations: status.retainedConversations };
      assert.equal(status.activeRequestId, null); assert.equal(result.status, "cancelled");
    } finally { await client.close(); }
    evidence.status = "PASS_PROTOCOL_AND_BROWSER";
  } catch (error) {
    controller.abort(); evidence.status = "FAILED";
    evidence.error = error instanceof assert.AssertionError ? "ASSERTION_FAILED" : error?.name === "AbortError" ? "PROBE_DEADLINE" : "PROBE_FAILED";
    process.exitCode = 1;
  } finally { clearTimeout(watchdog); fs.writeFileSync(file, JSON.stringify(evidence, null, 2) + "\n"); console.log(JSON.stringify({ status: evidence.status, evidence: path.relative(process.cwd(), file) })); }
}
