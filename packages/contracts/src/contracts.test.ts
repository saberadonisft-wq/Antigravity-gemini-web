import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_VERSION,
  ControlCommandSchema,
  CommandAckSchema,
  RuntimeSnapshotSchema,
  SettingsPatchSchema,
  RuntimeEventSchema,
  OperationRecordSchema,
  createPageSchema,
  SessionSummarySchema,
} from "./index.js";

test("ControlCommandSchema accepts valid commands and rejects invalid schemas", () => {
  const validOpen = {
    requestId: "req-1",
    type: "browser.open" as const,
    payload: {},
  };
  const parsedOpen = ControlCommandSchema.parse(validOpen);
  assert.equal(parsedOpen.type, "browser.open");

  // Rejects unknown command type
  assert.throws(() => {
    ControlCommandSchema.parse({
      requestId: "req-2",
      type: "invalid.command",
      payload: {},
    });
  });

  // Rejects extra unexpected fields in payload (strict)
  assert.throws(() => {
    ControlCommandSchema.parse({
      requestId: "req-3",
      type: "browser.open",
      payload: { unknownField: true },
    });
  });

  // Rejects top-level unknown fields (strict outer object) [F4 regression]
  assert.throws(() => {
    ControlCommandSchema.parse({
      requestId: "req-3b",
      type: "browser.open",
      payload: {},
      foreignInjection: true,
    });
  });

  // Rejects invalid payload types
  assert.throws(() => {
    ControlCommandSchema.parse({
      requestId: "req-4",
      type: "runtime.check",
      payload: { scope: "invalid_scope" },
    });
  });
});

test("SettingsPatchSchema strictly rejects unknown fields and accepts partial valid patches", () => {
  const validPatch = { theme: "dark" as const };
  const parsed = SettingsPatchSchema.parse(validPatch);
  assert.equal(parsed.theme, "dark");

  assert.throws(() => {
    SettingsPatchSchema.parse({
      theme: "dark",
      arbitraryHack: "malicious",
    });
  });
});

test("CommandAckSchema validates accepted and rejected variants properly", () => {
  const acceptedAck = CommandAckSchema.parse({
    requestId: "req-1",
    accepted: true,
    operationId: "op-1",
  });
  assert.equal(acceptedAck.accepted, true);

  const rejectedAck = CommandAckSchema.parse({
    requestId: "req-2",
    accepted: false,
    error: {
      code: "CONFIG_CONFLICT",
      message: "Stale revision",
      retryable: false,
    },
  });
  assert.equal(rejectedAck.accepted, false);

  // Rejects missing error when accepted: false
  assert.throws(() => {
    CommandAckSchema.parse({
      requestId: "req-3",
      accepted: false,
    });
  });
});

test("RuntimeSnapshotSchema enforces schemaVersion 0.1", () => {
  const baseSnapshot = {
    schemaVersion: SCHEMA_VERSION,
    runtimeInstanceId: "inst-1",
    revision: 1,
    lastEventSequence: 10,
    observedAt: new Date().toISOString(),
    mode: "demo" as const,
    runtime: { state: "ready" as const },
    browser: { state: "closed" as const },
    account: { state: "unknown" as const },
    integration: { target: "native_ide" as const, state: "unverified" as const },
    capabilities: {
      nativeRoute: { state: "unverified" as const },
      modelSelection: { state: "unverified" as const },
      toolExecution: { state: "unverified" as const },
      customMcp: { state: "unverified" as const },
      cancelTurn: { state: "unverified" as const },
      imageInput: { state: "unverified" as const },
      contextCompaction: { state: "unverified" as const },
      usageObservation: { state: "unverified" as const },
      logExport: { state: "unverified" as const },
    },
    availableModels: [],
    selectedModelId: null,
    sessions: [],
    settings: {
      theme: "system" as const,
      language: "vi" as const,
      diagnosticLevel: "normal" as const,
      revision: 0,
    },
    lastCheck: null,
  };

  const parsed = RuntimeSnapshotSchema.parse(baseSnapshot);
  assert.equal(parsed.schemaVersion, "0.1");

  // Wrong schema version must fail
  assert.throws(() => {
    RuntimeSnapshotSchema.parse({
      ...baseSnapshot,
      schemaVersion: "0.2",
    });
  });
});

test("RuntimeEventSchema strictly validates event payloads [F4 regression]", () => {
  // Rejects malformed payload like { snapshot: 17 } for snapshot.updated
  assert.throws(() => {
    RuntimeEventSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      runtimeInstanceId: "inst-1",
      sequence: 1,
      id: "evt-1",
      occurredAt: new Date().toISOString(),
      type: "snapshot.updated",
      payload: { snapshot: 17 },
    });
  });
});

test("OperationRecordSchema rejects invented operation types [F4 regression]", () => {
  assert.throws(() => {
    OperationRecordSchema.parse({
      id: "op-1",
      requestId: "req-1",
      type: "invented.shell" as any,
      state: "running",
      updatedAt: new Date().toISOString(),
    });
  });
});

test("createPageSchema rejects unknown top-level fields [F4 regression]", () => {
  const pageSchema = createPageSchema(SessionSummarySchema);
  assert.throws(() => {
    pageSchema.parse({
      items: [],
      extraField: "invalid",
    });
  });
});

test("OperationRecordSchema enforces discriminated command/result/state rules [R6 regression]", () => {
  const now = new Date().toISOString();

  // 1. Failed state MUST have an error object
  assert.throws(() => {
    OperationRecordSchema.parse({
      id: "op-fail-no-err",
      requestId: "req-1",
      type: "browser.open",
      state: "failed",
      updatedAt: now,
    });
  });

  // 2. Failed state must NOT have a result payload
  assert.throws(() => {
    OperationRecordSchema.parse({
      id: "op-fail-with-res",
      requestId: "req-2",
      type: "browser.open",
      state: "failed",
      result: { summary: "something" },
      error: { code: "HOST_NOT_FOUND", message: "fail", retryable: false },
      updatedAt: now,
    });
  });

  // 3. browser.open must NOT accept preview result
  assert.throws(() => {
    OperationRecordSchema.parse({
      id: "op-bad-result-match",
      requestId: "req-3",
      type: "browser.open",
      state: "succeeded",
      result: {
        previewId: "prev-1",
        action: "install",
        summary: "should not be here",
        canApply: false,
      },
      updatedAt: now,
    });
  });

  // 4. integration.preview in succeeded state must have valid preview result
  assert.throws(() => {
    OperationRecordSchema.parse({
      id: "op-preview-no-result",
      requestId: "req-4",
      type: "integration.preview",
      state: "succeeded",
      updatedAt: now,
    });
  });

  // 5. Valid operations pass
  const validPreviewOp = OperationRecordSchema.parse({
    id: "op-preview-ok",
    requestId: "req-5",
    type: "integration.preview",
    state: "succeeded",
    result: {
      previewId: "prev-1",
      action: "install",
      summary: "Plan ready",
      canApply: true,
    },
    updatedAt: now,
  });
  assert.equal(validPreviewOp.state, "succeeded");

  const validFailedOp = OperationRecordSchema.parse({
    id: "op-fail-ok",
    requestId: "req-6",
    type: "account.check",
    state: "failed",
    error: {
      code: "LOGIN_REQUIRED",
      message: "Need login",
      retryable: false,
    },
    updatedAt: now,
  });
  assert.equal(validFailedOp.state, "failed");
});

