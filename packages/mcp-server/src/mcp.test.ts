import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { GeminiBrowserAdapter, PromptTurnResponse } from "@antigravity-gemini-web/gemini-browser";
import { GeminiMcpService, MAX_BROWSER_PROMPT_CHARS } from "./service.js";
import { createGeminiMcpServer } from "./server.js";
import { fileURLToPath } from "node:url";
import { removeOwnedFixture } from "./fixture-cleanup.js";

function controlledBrowser() {
  let resolve!: (value: PromptTurnResponse) => void;
  const reply = new Promise<PromptTurnResponse>(r => { resolve = r; });
  const stats = { sends: 0, opens: 0, cleaned: false };
  const adapter: GeminiBrowserAdapter = {
    checkStatus: async () => ({ browserState: "ready", accountState: "signed_in", checkedAt: new Date().toISOString() }),
    openBrowser: async () => { stats.opens++; return { opened: true }; },
    submitPrompt: async turnId => { stats.sends++; return { turnId, submittedAt: new Date().toISOString(), status: "accepted" }; },
    pollResponse: async () => reply,
    cancelPrompt: async turnId => { resolve({ turnId, status: "cancelled", text: "", completedAt: new Date().toISOString() }); return { turnId, cancelled: true }; },
    cleanup: async () => { stats.cleaned = true; resolve({ turnId: "closed", status: "failed", text: "", completedAt: new Date().toISOString() }); },
    sendPrompt: async () => { throw Error("Use receipt API"); },
  };
  return { adapter, stats, resolve };
}
function output(result: unknown): Record<string, any> {
  const value = result as { content: { text: string }[] };
  return JSON.parse(value.content[0].text);
}

test("Import observation holds browser admission, creates no receipt and cannot publish after shutdown",async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"gemini-mcp-test-")),browser=controlledBrowser();let finish!:(value:any)=>void;
  const observation={status:"not_observed" as const,observedAt:new Date().toISOString(),identityVerified:false,chatUploadControlObserved:false,memoryControlsObserved:false,evidence:"visible_controls_only" as const,googleSubmission:"not_submitted" as const};
  browser.adapter.inspectImportSurface=async()=>new Promise(resolve=>{finish=resolve;});
  const service=new GeminiMcpService(browser.adapter,path.join(root,"receipts.json"));t.after(async()=>{await service.close();removeOwnedFixture(root);});
  const first=service.inspectImportSurface("a".repeat(64));assert.equal((await service.status()).browserOperationActive,true);
  await assert.rejects(service.inspectImportSurface("a".repeat(64)),{code:"BUSY"});await assert.rejects(service.submit("blocked_import_probe","No Send"),{code:"BUSY"});await assert.rejects(service.openBrowser(),{code:"BUSY"});
  finish(observation);assert.equal((await first).status,"not_observed");assert.equal((await service.inspectReceipt("blocked_import_probe")).found,false);assert.equal((await service.status()).browserOperationActive,false);
  const late=service.inspectImportSurface("a".repeat(64));await service.close();finish(observation);await assert.rejects(late,{code:"SERVICE_UNAVAILABLE"});
});

test("Expired results are withdrawn on every read API while physical receipts and Send fences survive",async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"gemini-mcp-test-")),browser=controlledBrowser(),service=new GeminiMcpService(browser.adapter,path.join(root,"receipts.json"));
  browser.adapter.pollResponse=async turnId=>({turnId,status:"completed",text:"expired cache fixture",completedAt:new Date().toISOString()});
  t.after(async()=>{await service.close();removeOwnedFixture(root);});
  for(const surface of ["result","receipt","status"] as const){
    const id="expiry_read_"+surface;await service.submit(id,"synthetic "+surface);assert.equal((await service.result(id,1000)).status,"completed");
    const originalNow=Date.now,advanced=originalNow()+600001;
    try{
      Date.now=()=>advanced;
      if(surface==="result")await assert.rejects(service.result(id),{code:"OUTCOME_UNKNOWN"});
      if(surface==="receipt")assert.equal((await service.inspectReceipt(id)).resultAvailable,false);
      if(surface==="status")assert.equal((await service.status()).cachedResults,0);
      const receipt=await service.inspectReceipt(id);assert.equal(receipt.found,true);assert.equal(receipt.replayAllowed,false);assert.equal(receipt.receipt?.phase,"terminal");
      await assert.rejects(service.submit(id,"synthetic "+surface),{code:"OUTCOME_UNKNOWN"});
    }finally{Date.now=originalNow;}
  }
  assert.equal(browser.stats.sends,3);assert.equal(browser.stats.opens,0);
});

test("Browser MCP can finish more than 128 requests without forgetting durable Send identities", { timeout: 20000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-test-"));
  const browser = controlledBrowser();
  browser.adapter.pollResponse = async turnId => ({ turnId, status: "completed", text: "cached reply", completedAt: new Date().toISOString() });
  const ledger = path.join(root, "receipts.json"), service = new GeminiMcpService(browser.adapter, ledger);
  t.after(async () => { await service.close(); removeOwnedFixture(root); });
  for (let index = 0; index < 140; index++) {
    const id = "bounded_" + index;
    await service.submit(id, "prompt " + index);
    assert.equal((await service.result(id, 1000)).status, "completed");
  }
  await assert.rejects(service.submit("bounded_0", "prompt 0"), { code: "OUTCOME_UNKNOWN" });
  await assert.rejects(service.submit("bounded_0", "changed"), { code: "CONFIG_CONFLICT" });
  assert.equal((await service.submit("bounded_139", "prompt 139")).status, "completed");
  assert.equal(browser.stats.sends, 140);
  assert.ok((await service.status()).cachedResults <= 32);
  const restarted = new GeminiMcpService(browser.adapter, ledger);
  await assert.rejects(restarted.submit("bounded_0", "prompt 0"), { code: "OUTCOME_UNKNOWN" });
  await restarted.close();
});

test("MCP initialize/discovery, durable dedup, polling and immutable result via actual protocol", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-test-"));
  const browser = controlledBrowser();
  const ledger = path.join(root, "receipts.json");
  const service = new GeminiMcpService(browser.adapter, ledger);
  const server = createGeminiMcpServer(service);
  const client = new Client({ name: "owned-test", version: "1" });
  t.after(async () => { await service.close(); await client.close(); await server.close(); removeOwnedFixture(root); });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ["gemini_cancel", "gemini_inspect_import", "gemini_open_browser", "gemini_receipt", "gemini_release_conversation", "gemini_result", "gemini_status", "gemini_submit"]);
  assert.equal(output(await client.callTool({ name: "gemini_status", arguments: {} })).nativeInference, "unverified");
  assert.equal(browser.stats.opens, 0);
  const prompt = "SECRET_TEST_PROMPT_does_not_belong_in_ledger";
  const args = { request_id: "request_0001", prompt };
  await Promise.all([client.callTool({ name: "gemini_submit", arguments: args }), client.callTool({ name: "gemini_submit", arguments: args })]);
  assert.equal(browser.stats.sends, 1);
  assert.equal(output(await client.callTool({ name: "gemini_submit", arguments: { ...args, prompt: "changed" } })).code, "CONFIG_CONFLICT");
  assert.equal(output(await client.callTool({ name: "gemini_submit", arguments: { request_id: "request_0002", prompt } })).code, "BUSY");
  assert.equal(output(await client.callTool({ name: "gemini_result", arguments: { request_id: args.request_id, wait_ms: 5 } })).status, "pending");
  browser.resolve({ turnId: "owned", status: "completed", text: "REAL_TEST_REPLY", completedAt: new Date().toISOString() });
  const result = output(await client.callTool({ name: "gemini_result", arguments: { request_id: args.request_id, wait_ms: 500 } }));
  assert.equal(result.text, "REAL_TEST_REPLY");
  const metadata=output(await client.callTool({name:"gemini_receipt",arguments:{request_id:args.request_id}}));
  assert.equal(metadata.receipt.phase,"terminal");assert.equal(metadata.replayAllowed,false);assert.equal(metadata.text,undefined);
  assert.equal(output(await client.callTool({ name: "gemini_cancel", arguments: { request_id: args.request_id } })).cancelled, false);
  assert.equal(fs.readFileSync(ledger, "utf8").includes(prompt), false);
  assert.equal(fs.readFileSync(ledger, "utf8").includes("REAL_TEST_REPLY"), false);
  const resumed = new GeminiMcpService(browser.adapter, ledger);
  await assert.rejects(resumed.submit(args.request_id, prompt), { code: "OUTCOME_UNKNOWN" });
  await resumed.close();
  assert.equal(browser.stats.sends, 1);
  const invalid = await client.callTool({ name: "gemini_submit", arguments: { request_id: "request_0003", prompt: "x".repeat(MAX_BROWSER_PROMPT_CHARS + 1) } });
  assert.equal(invalid.isError, true);
});

test("Persistence failure and corrupt receipts fail before browser side effects", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-test-"));
  t.after(() => removeOwnedFixture(root));
  const file = path.join(root, "file"); fs.writeFileSync(file, "not a directory");
  const browser = controlledBrowser();
  const service = new GeminiMcpService(browser.adapter, path.join(file, "receipts.json"));
  await assert.rejects(service.submit("request_0001", "text"), { code: "LEDGER_UNAVAILABLE" });
  assert.equal(browser.stats.sends, 0);
  fs.writeFileSync(path.join(root, "broken.json"), "[{truncated");
  assert.throws(() => new GeminiMcpService(browser.adapter, path.join(root, "broken.json")), { code: "LEDGER_UNAVAILABLE" });
});

test("Cancellation is confirmed by the browser and uncertain failures keep the browser reserved", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-test-"));
  const browser = controlledBrowser();
  const service = new GeminiMcpService(browser.adapter, path.join(root, "receipts.json"));
  t.after(async () => { await service.close(); removeOwnedFixture(root); });
  await service.submit("request_cancel", "cancel me");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await service.cancel("request_cancel")).cancelled, true);
  assert.equal((await service.result("request_cancel", 100)).status, "cancelled");
  assert.equal((await service.cancel("request_cancel")).cancelled, false);
  const uncertainBrowser = controlledBrowser();
  uncertainBrowser.adapter.submitPrompt = async () => { throw Error("lost acknowledgement with sensitive raw text"); };
  const uncertain = new GeminiMcpService(uncertainBrowser.adapter, path.join(root, "uncertain.json"));
  await uncertain.submit("request_unknown", "private prompt");
  const result = await uncertain.result("request_unknown", 100);
  assert.equal(result.status, "failed");
  assert.equal(JSON.stringify(result).includes("sensitive raw text"), false);
  await assert.rejects(uncertain.submit("request_new_01", "do not resend"), { code: "BUSY" });
  await uncertain.close();
});

test("Real stdio process initializes without Chrome, denies concurrent profile owner, can reconnect after EOF", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-test-"));
  const profile = path.join(root, "browser_profile");
  const entry = fileURLToPath(new URL("./cli.js", import.meta.url));
  const params = { command: process.execPath, args: [entry], env: { AG_MCP_BROWSER_PROFILE: profile, AG_MCP_STATE_DIR: path.join(root, "state"), AG_MCP_DEBUG_PORT: "65412" }, stderr: "pipe" as const };
  const transport = new StdioClientTransport(params);
  const client = new Client({ name: "owned-stdio", version: "1" });
  t.after(async () => { await client.close(); removeOwnedFixture(root); });
  await client.connect(transport);
  assert.ok(transport.pid);
  assert.equal(output(await client.callTool({ name: "gemini_status", arguments: {} })).browserState, "closed");
  const competitor = new Client({ name: "owned-competitor", version: "1" });
  const competitorTransport = new StdioClientTransport({ ...params, env: { ...params.env, AG_MCP_STATE_DIR: path.join(root, "another-state") } });
  try { await assert.rejects(competitor.connect(competitorTransport)); } finally { await competitor.close(); }
  assert.equal((await client.listTools()).tools.length, 8);
  const absent=output(await client.callTool({name:"gemini_receipt",arguments:{request_id:"unseen_receipt_001"}}));
  assert.equal(absent.found,false);assert.equal(absent.replayAllowed,false);
  assert.ok(!fs.existsSync(path.join(root,"state","receipts.json.sqlite")),"Metadata lookup alone must not initialize storage or open Chrome");
  await client.close();
  const reconnect = new Client({ name: "owned-reconnect", version: "1" });
  try { await reconnect.connect(new StdioClientTransport(params)); assert.equal((await reconnect.listTools()).tools.length, 8); }
  finally { await reconnect.close(); }
});
