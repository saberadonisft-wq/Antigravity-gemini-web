import test from "node:test";
import assert from "node:assert/strict";
import { nativeBrowserTransport, nativeSnapshotTransport, transportReplyCategory, MAX_WEB_MESSAGE_CHARS } from "./browser-transport.js";
import { McpNativeBrowserBackend, type NativeBrowserProgress } from "./browser-backend.js";

test("The additional observed generic Web error is classified structurally without interpreting quoted prose as an error", () => {
  assert.equal(transportReplyCategory("I encountered an error doing what you asked. Could you try again?"), "known_error_text");
  assert.equal(transportReplyCategory('The example says: "I encountered an error doing what you asked. Could you try again?"'), "other");
});
import { MAX_NATIVE_PROMPT_CHARS, sha256, type JsonObject } from "./native-protocol.js";
import { hasValidUnicode } from "./unicode.js";
import { NativeTransportTraceSchema, type NativeTransportTrace } from "@antigravity-gemini-web/contracts";

test("Long context fragments preserve every character and Unicode boundary with one commit revision", () => {
  const original = " \n" + "x".repeat(26997) + "😀\n" + "context\n".repeat(16000) + "\n \t";
  const messages = nativeBrowserTransport(original, "final-revision", "previous-revision");
  assert.ok(messages.length > 3);
  let previous = "previous-revision";
  const reconstructed: string[] = [];
  for (const message of messages.slice(0, -1)) {
    assert.ok(message.prompt.length <= MAX_WEB_MESSAGE_CHARS);
    assert.ok(hasValidUnicode(message.prompt));
    assert.equal(message.baseRevision, previous); previous = message.revision!;
    const match = /<ag_fragment_([a-f0-9]{32})_(\d+)>\n([\s\S]*)\n<\/ag_fragment_\1_\2>$/.exec(message.prompt);
    assert.ok(match); reconstructed.push(match[3]);
    assert.ok(message.prompt.includes(message.acknowledgement!));
  }
  assert.equal(reconstructed.join(""), original);
  assert.equal(messages.at(-1)!.baseRevision, previous);
  assert.equal(messages.at(-1)!.revision, "final-revision");
  assert.equal(messages.at(-1)!.acknowledgement, undefined);
  assert.deepEqual(nativeBrowserTransport("short", "new", "old"), [{ prompt: "short", revision: "new", baseRevision: "old" }]);
  assert.throws(() => nativeBrowserTransport("x".repeat(MAX_NATIVE_PROMPT_CHARS + 1)), { code: "CONTEXT_TOO_LARGE" });
  assert.ok(nativeBrowserTransport("x".repeat(MAX_NATIVE_PROMPT_CHARS), "max").every(message => message.prompt.length <= MAX_WEB_MESSAGE_CHARS));
});

function fixture(options: { badAck?: boolean; errorAck?: boolean; cancelSecond?: AbortController } = {}) {
  const backend = new McpNativeBrowserBackend("unused-test-cli");
  const submissions: JsonObject[] = [], cancelled: string[] = [], progress: NativeBrowserProgress[] = [];
  let current: JsonObject, previous = "base", pending = false;
  Object.assign(backend, {
    connect: async () => {},
    call: async (name: string, args: JsonObject) => {
      if (name === "gemini_status") return { browserState: "ready", accountState: "signed_in", activeRequestId: null, physicalReceiptInspectionSupported:true, maxPromptChars: MAX_WEB_MESSAGE_CHARS, freshConversationSupported: true, retainedConversationSupported: true, progressStreamingSupported: true, conversationUrlCheckpointSupported: true };
      if (name === "gemini_submit") {
        assert.ok(String(args.prompt).length <= MAX_WEB_MESSAGE_CHARS);
        const conversation = args.conversation as JsonObject;
        assert.equal(conversation.key, "fixture-conversation");
        assert.equal(conversation.base_revision, previous); previous = String(conversation.revision);
        current = args; submissions.push(args); pending = false;
        return {};
      }
      if (name === "gemini_cancel") { cancelled.push(String(args.request_id)); return { cancelled: true }; }
      if (name === "gemini_result") {
        assert.equal(args.request_id, current.request_id);
        const ack = /reply exactly (AG_CONTEXT_ACK_[a-f0-9]+_\d+)/.exec(String(current.prompt))?.[1];
        if (options.cancelSecond && submissions.length === 2) { options.cancelSecond.abort(); return { status: "pending" }; }
        if (!pending) { pending = true; return { status: "pending", progress: { revision: 1, text: ack ? '{"type":"tool_call","args":{"secret":"never expose staging output"}}' : "final progress" } }; }
        return { status: "completed", text: ack ? options.errorAck ? "I seem to be encountering an error. Can I try something else for you?" : options.badAck ? '{"type":"tool_call","name":"run_command"}' : ack : "FINAL_NATIVE_REPLY" };
      }
      throw Error("Unexpected test broker call");
    },
  });
  return { backend, submissions, cancelled, progress };
}

test("Native long-context transport exposes only the committed reply and keeps one revision-bound conversation", async () => {
  const f = fixture();
  const result = await f.backend.generate("fixture_request", "x".repeat(75000), new AbortController().signal, { conversation: { key: "fixture-conversation", revision: sha256("target"), baseRevision: "base" }, onProgress: event => f.progress.push(event) });
  assert.equal(result, "FINAL_NATIVE_REPLY");
  assert.equal(f.submissions.length, 4);
  assert.equal((f.submissions.at(-1)!.conversation as JsonObject).revision, sha256("target"));
  assert.ok(f.progress.some(event => event.stage === "context_delivery"));
  assert.ok(f.progress.filter(event => event.stage === "context_delivery").every(event => event.text === "" && !event.codeBlocks));
  assert.deepEqual(f.progress.map(event => event.revision), f.progress.map((_, index) => index + 1));
});

test("Every physical fragment/commit is mapped before broker submission and carries the logical attempt owner", async()=>{
  const f=fixture(), mapped:string[]=[];
  const owner={logicalRequestId:"native_"+sha256("logical"),logicalAttemptId:"00000000-0000-4000-8000-000000000001",accountId:"acc_A",identityEpoch:1};
  await f.backend.generate("fixture_request","x".repeat(75000),new AbortController().signal,{conversation:{key:"fixture-conversation",revision:sha256("target"),baseRevision:"base"},receiptOwner:owner,onPhysicalSubmission:id=>{assert.equal(f.submissions.length,mapped.length);mapped.push(id);}});
  assert.deepEqual(mapped,f.submissions.map(row=>row.request_id));assert.equal(mapped.length,4);
  assert.ok(f.submissions.every(row=>JSON.stringify(row.native_owner)===JSON.stringify(owner)));
});

test("A mapping persistence failure prevents the next Send and preserves uncertainty after an earlier fragment",async()=>{
  for(const afterFirst of [false,true]){
    const f=fixture();let count=0;
    await assert.rejects(f.backend.generate("fixture_request","x".repeat(75000),new AbortController().signal,{conversation:{key:"fixture-conversation",revision:sha256("target"),baseRevision:"base"},onPhysicalSubmission:()=>{if(++count>(afterFirst?1:0))throw Error("Synthetic mapping write failure");}}),{code:"REQUEST_LEDGER_UNAVAILABLE",delivery:afterFirst?"unknown":"not_sent"});
    assert.equal(f.submissions.length,afterFirst?1:0);
  }
});

test("An unacknowledged fragment cannot become a native tool call or trigger a commit", async () => {
  const f = fixture({ badAck: true });
  const trace: NativeTransportTrace[] = [];
  await assert.rejects(f.backend.generate("fixture_request", "x".repeat(75000), new AbortController().signal, { conversation: { key: "fixture-conversation", revision: "final", baseRevision: "base" }, onTransportTrace: event => trace.push(event) }), { code: "CONTEXT_FRAGMENT_ACK_FAILED", phase: "response", delivery: "unknown" });
  assert.equal(f.submissions.length, 1);
  assert.ok(trace.every(event => NativeTransportTraceSchema.safeParse(event).success));
  assert.equal(trace.find(event => event.stage === "completed")?.ackMatches, false);
  assert.equal(trace.at(-1)?.code, "CONTEXT_FRAGMENT_ACK_FAILED");
  assert.ok(!JSON.stringify(trace).includes('"name":"run_command"'));
  assert.ok(!JSON.stringify(trace).includes("never expose staging output"));
  assert.ok(trace.every(event => event.messageIndex === 1 && event.messageCount === 4));
});

test("Cancellation during staging targets the active fragment and never sends later parts or commit", async () => {
  const controller = new AbortController(), f = fixture({ cancelSecond: controller });
  await assert.rejects(f.backend.generate("fixture_request", "x".repeat(75000), controller.signal, { conversation: { key: "fixture-conversation", revision: "final", baseRevision: "base" } }), { name: "AbortError" });
  assert.equal(f.submissions.length, 2);
  assert.deepEqual(f.cancelled, [f.submissions[1].request_id]);
});

test("Known Web error text is classified without exposing it, forwarding tools or relaxing the fragment ACK", async () => {
  const f = fixture({ errorAck: true }), trace: NativeTransportTrace[] = [];
  await assert.rejects(f.backend.generate("fixture_request", "x".repeat(75000), new AbortController().signal, { conversation: { key: "fixture-conversation", revision: "final", baseRevision: "base" }, onTransportTrace: event => trace.push(event) }), { code: "CONTEXT_FRAGMENT_ACK_FAILED" });
  assert.equal(f.submissions.length, 1);
  assert.equal(trace.find(event => event.stage === "completed")?.responseCategory, "known_error_text");
  assert.ok(!JSON.stringify(trace).includes("I seem to be encountering"));
});


test("Experimental snapshot preserves exact native prompt, revision and nonce without fragment ACKs", async () => {
  const nonce = "a".repeat(48), prompt = "Việt_😀_".repeat(11000);
  const [message] = nativeSnapshotTransport(prompt, nonce, sha256("target"), sha256("base"));
  assert.equal(message.snapshotAttachment?.content, prompt);
  assert.equal(message.snapshotAttachment?.sha256, sha256(prompt));
  assert.equal(message.revision, sha256("target")); assert.equal(message.baseRevision, sha256("base"));
  assert.ok(message.prompt.includes(nonce)); assert.ok(message.prompt.length < MAX_WEB_MESSAGE_CHARS);
  assert.equal(message.acknowledgement, undefined);
  assert.throws(() => nativeSnapshotTransport(prompt, "not-a-compiled-nonce"), {code:"INVALID_SNAPSHOT"});
  assert.throws(() => nativeSnapshotTransport("x".repeat(262145), nonce), {code:"CONTEXT_TOO_LARGE"});
  const fingerprint = "b".repeat(64), submissions: JsonObject[] = [], traces: NativeTransportTrace[] = [];
  const backend = new McpNativeBrowserBackend("unused", undefined, fingerprint);
  Object.assign(backend, {connect:async()=>{},call:async(name:string,args:JsonObject)=>{
    if(name==="gemini_status")return {browserState:"ready",accountState:"signed_in",accountIdentity:{fingerprint},accountIdentityVerificationSupported:true,nativeSnapshotAttachmentSupported:true,nativeSnapshotFileRetentionSupported:true,maxPromptChars:28000,freshConversationSupported:true,retainedConversationSupported:true,progressStreamingSupported:true,conversationUrlCheckpointSupported:true};
    if(name==="gemini_submit"){submissions.push(args);return {};}
    return {status:"completed",text:'{"nonce":"'+nonce+'","type":"final","text":"done"}'};
  }});
  await backend.generate("snapshot-fixture",prompt,new AbortController().signal,{snapshotAttachment:true,responseNonce:nonce,onTransportTrace:value=>traces.push(value)});
  assert.equal(submissions.length,1);assert.equal((submissions[0].snapshot_attachment as JsonObject).content,prompt);
  assert.ok(traces.every(value=>value.kind==="attachment"&&value.attachment?.sha256===sha256(prompt)));
  assert.ok(!JSON.stringify(traces).includes("Việt"));assert.ok(!JSON.stringify(traces).includes(nonce));
});


test("Old snapshot runtimes without file-retention support are refused before any submission",async()=>{
  const fingerprint="b".repeat(64),backend=new McpNativeBrowserBackend("unused",undefined,fingerprint);let submitted=false;
  Object.assign(backend,{connect:async()=>{},call:async(name:string)=>{
    if(name==="gemini_submit")submitted=true;
    return {browserState:"ready",accountState:"signed_in",accountIdentity:{fingerprint},nativeSnapshotAttachmentSupported:true,nativeSnapshotFileRetentionSupported:false};
  }});
  await assert.rejects(backend.generate("old-file-runtime","x".repeat(78000),new AbortController().signal,{snapshotAttachment:true,responseNonce:"a".repeat(48)}),{code:"BROWSER_RUNTIME_UPDATE_REQUIRED",phase:"checkpoint",delivery:"not_sent"});assert.equal(submitted,false);
});

test("Initial text and file context use 3.8 only for exact ACKs, then commit on the captured primary model", async () => {
  for (const transport of ["short", "fragmented", "snapshot"]) {
    const fingerprint = "b".repeat(64), nonce = "a".repeat(48), primary = { model: "4 Argon", effort: "High" }, context = { model: "3.8 Flash" };
    const backend = new McpNativeBrowserBackend("unused", undefined, fingerprint), submissions: JsonObject[] = [], traces: NativeTransportTrace[] = [];
    let current: JsonObject = {};
    Object.assign(backend, { connect: async () => {}, call: async (name: string, args: JsonObject) => {
      if (name === "gemini_status") return { browserState: "ready", accountState: "signed_in", accountIdentity: { fingerprint }, accountIdentityVerificationSupported: true,
        temporaryModelSelectionSupported: true, modelSelectionSupported: true, nativeSnapshotAttachmentSupported: true, nativeSnapshotFileRetentionSupported: true,
        maxPromptChars: 28000, freshConversationSupported: true, retainedConversationSupported: true, progressStreamingSupported: true, conversationUrlCheckpointSupported: true };
      if (name === "gemini_submit") { current = args; submissions.push(args); return {}; }
      if (name === "gemini_result") {
        const ack = /reply exactly (AG_CONTEXT_ACK_[a-f0-9]+_\d+)/i.exec(String(current.prompt))?.[1];
        return { status: "completed", text: ack ?? "FINAL_NATIVE_REPLY", verifiedModel: current.model_selection, ...(current.temporary_model_selection ? { restoredModel: primary } : {}) };
      }
      throw Error("Unexpected broker call");
    } });
    const prompt = transport === "short" ? "Synthetic first context" : "x".repeat(78642);
    const reply = await backend.generate("context_model_fixture", prompt, new AbortController().signal, { contextModelSelection: context, snapshotAttachment: transport === "snapshot", responseNonce: nonce,
      conversation: { key: "context_model_fixture_chat", revision: sha256(prompt) }, onTransportTrace: trace => traces.push(trace) });
    assert.equal(reply, "FINAL_NATIVE_REPLY"); assert.ok(submissions.length >= 2);
    assert.equal(traces.length, submissions.length * 2);
    assert.ok(submissions.slice(0, -1).every(args => (args.model_selection as JsonObject).model === context.model && args.temporary_model_selection === true));
    assert.deepEqual(submissions.at(-1)?.model_selection, primary); assert.equal(submissions.at(-1)?.temporary_model_selection, undefined);
    assert.ok(traces.filter(trace => trace.stage === "completed").slice(0, -1).every(trace => trace.ackMatches && trace.restoredModel?.model === primary.model));
    assert.ok(submissions.every(args => String(args.prompt).length <= MAX_WEB_MESSAGE_CHARS));
    assert.equal(submissions.filter(args => args.snapshot_attachment).length, transport === "snapshot" ? 1 : 0);
  }
});

test("Missing primary restoration proof stops context staging before COMMIT", async () => {
  const fingerprint = "b".repeat(64), backend = new McpNativeBrowserBackend("unused", undefined, fingerprint); let submitted = 0, current: JsonObject = {};
  Object.assign(backend, { connect: async () => {}, call: async (name: string, args: JsonObject) => {
    if (name === "gemini_status") return { browserState: "ready", accountState: "signed_in", accountIdentity: { fingerprint }, accountIdentityVerificationSupported: true, temporaryModelSelectionSupported: true,
      maxPromptChars: 28000, freshConversationSupported: true, retainedConversationSupported: true, progressStreamingSupported: true, conversationUrlCheckpointSupported: true };
    if (name === "gemini_submit") { submitted++; current = args; return {}; }
    return { status: "completed", text: /reply exactly (AG_CONTEXT_ACK_[a-f0-9]+_\d+)/i.exec(String(current.prompt))?.[1], verifiedModel: current.model_selection };
  } });
  await assert.rejects(backend.generate("missing_restore_fixture", "Synthetic", new AbortController().signal, { contextModelSelection: { model: "3.8 Flash" }, conversation: { key: "missing_restore_chat", revision: sha256("Synthetic") } }), { code: "MODEL_RESTORE_PENDING" });
  assert.equal(submitted, 1);
});
