import { test } from "node:test";
import assert from "node:assert/strict";
import { EnvelopeParser, LiveModelBridgeStub } from "./index.js";
import type { UiError } from "@antigravity-gemini-web/contracts";

test("EnvelopeParser strictly ignores generic json code blocks [F7 regression]", () => {
  // An explanatory JSON block in response must NOT be parsed as an execution command!
  const textWithGenericJson = `
Here is an example JSON config:
\`\`\`json
{
  "schemaVersion": "0.1",
  "callId": "call-1",
  "sessionId": "sess-1",
  "turnId": "turn-123",
  "requestNonce": "nonce-1",
  "tool": "read_file",
  "args": { "path": "stale_config.json" }
}
\`\`\`
Hope this helps!
  `;
  assert.equal(EnvelopeParser.parse(textWithGenericJson), null);
});

test("EnvelopeParser validates antigravity-tool marker, authority binding, and tool schemas [F7 regression]", () => {
  const textWithTool = `
Requesting file inspection:
\`\`\`antigravity-tool
{
  "schemaVersion": "0.1",
  "callId": "call-valid-1",
  "sessionId": "sess-alpha",
  "turnId": "turn-123",
  "requestNonce": "nonce-xyz",
  "tool": "read_file",
  "args": { "path": "test.txt" }
}
\`\`\`
  `;

  // Valid binding
  const parsed = EnvelopeParser.parse(textWithTool, {
    sessionId: "sess-alpha",
    turnId: "turn-123",
    requestNonce: "nonce-xyz",
  });
  assert.ok(parsed);
  assert.equal(parsed.callId, "call-valid-1");
  assert.equal(parsed.tool, "read_file");
  assert.equal(parsed.args["path"], "test.txt");

  // Stale turn binding mismatch throws CONTRACT_MISMATCH
  assert.throws(
    () => {
      EnvelopeParser.parse(textWithTool, {
        sessionId: "sess-alpha",
        turnId: "turn-DIFFERENT",
      });
    },
    (err: unknown) => {
      const uiErr = err as UiError;
      return uiErr.code === "CONTRACT_MISMATCH";
    }
  );

  // Missing required tool argument throws TOOL_DENIED
  const textWithBadArgs = `
\`\`\`antigravity-tool
{
  "schemaVersion": "0.1",
  "callId": "call-bad-1",
  "sessionId": "sess-alpha",
  "turnId": "turn-123",
  "requestNonce": "nonce-xyz",
  "tool": "read_file",
  "args": {}
}
\`\`\`
  `;
  assert.throws(
    () => {
      EnvelopeParser.parse(textWithBadArgs);
    },
    (err: unknown) => {
      const uiErr = err as UiError;
      return uiErr.code === "TOOL_DENIED";
    }
  );
});

test("LiveModelBridgeStub rejects inference routing with NATIVE_ROUTE_UNVERIFIED", async () => {
  const bridge = new LiveModelBridgeStub();
  await assert.rejects(
    async () => {
      await bridge.routeInference("t-1", "test prompt");
    },
    (err: unknown) => {
      const uiErr = err as UiError;
      return uiErr.code === "NATIVE_ROUTE_UNVERIFIED";
    }
  );
});

test("EnvelopeParser.parseForExecution mandates authority binding, host inventory, and call ledger [R7 regression]", () => {
  const sampleResponse = `
Here is the file inspection tool call:
\`\`\`antigravity-tool
{
  "schemaVersion": "0.1",
  "callId": "call-exec-1",
  "sessionId": "sess-live",
  "turnId": "turn-456",
  "requestNonce": "nonce-live-1",
  "tool": "read_file",
  "args": { "path": "src/index.ts" }
}
\`\`\`
  `;

  // 1. Missing or partial binding throws CONTRACT_MISMATCH
  assert.throws(
    () => {
      EnvelopeParser.parseForExecution(sampleResponse, {
        sessionId: "",
        turnId: "turn-456",
        requestNonce: "nonce-live-1",
        allowedTools: ["read_file"],
      });
    },
    (err: unknown) => (err as UiError).code === "CONTRACT_MISMATCH"
  );

  // 2. Stale turn ID in binding throws CONTRACT_MISMATCH
  assert.throws(
    () => {
      EnvelopeParser.parseForExecution(sampleResponse, {
        sessionId: "sess-live",
        turnId: "turn-OLD",
        requestNonce: "nonce-live-1",
        allowedTools: ["read_file"],
      });
    },
    (err: unknown) => (err as UiError).code === "CONTRACT_MISMATCH"
  );

  // 3. Tool NOT in host allowed inventory throws TOOL_DENIED
  assert.throws(
    () => {
      EnvelopeParser.parseForExecution(sampleResponse, {
        sessionId: "sess-live",
        turnId: "turn-456",
        requestNonce: "nonce-live-1",
        allowedTools: ["patch_file", "run_test"], // read_file is NOT allowed in this inventory!
      });
    },
    (err: unknown) => (err as UiError).code === "TOOL_DENIED"
  );

  // 4. Valid execution call succeeds and registers in executedCallIds ledger
  const callLedger = new Set<string>();
  const parsed = EnvelopeParser.parseForExecution(sampleResponse, {
    sessionId: "sess-live",
    turnId: "turn-456",
    requestNonce: "nonce-live-1",
    allowedTools: ["read_file"],
    executedCallIds: callLedger,
  });
  assert.ok(parsed);
  assert.equal(parsed.callId, "call-exec-1");
  assert.ok(callLedger.has("call-exec-1"));

  // 5. Duplicate call ID execution throws CONTRACT_MISMATCH
  assert.throws(
    () => {
      EnvelopeParser.parseForExecution(sampleResponse, {
        sessionId: "sess-live",
        turnId: "turn-456",
        requestNonce: "nonce-live-1",
        allowedTools: ["read_file"],
        executedCallIds: callLedger, // already contains call-exec-1
      });
    },
    (err: unknown) => (err as UiError).code === "CONTRACT_MISMATCH"
  );
});

