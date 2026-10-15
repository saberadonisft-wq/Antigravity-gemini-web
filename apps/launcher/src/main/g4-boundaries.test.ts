import { test } from "node:test";
import assert from "node:assert/strict";
import { type LauncherClient, type RuntimeEvent, type UiError, RuntimeSnapshotSchema, sanitizeDiagnostics } from "@antigravity-gemini-web/contracts";
import { IpcSecurityBridge, type IpcCallContext } from "./ipc-bridge.js";
import { createPreloadClient, type IpcInvoker } from "../preload/client.js";
import { focusLauncherWindow } from "./window-lifecycle.js";
import { MockLauncherClient } from "../renderer/client/mock-client.js";

function setup() {
  const backend = new MockLauncherClient();
  const context: IpcCallContext = { sender: { id: 1, send: () => {} }, isMainFrame: true, origin: "app://local/index.html" };
  const bridge = new IpcSecurityBridge({ backend, trustedSender: sender => sender.id === 1, allowedOrigins: ["app://local", "http://127.0.0.1:5173"] });
  return { backend, context, bridge };
}

test("G4 fix: exact origins reject host/port/userinfo prefix spoofs", async () => {
  const { bridge, context } = setup();
  for (const origin of ["app://local.attacker", "http://127.0.0.1:51730", "app://local@attacker", "http://127.0.0.1:5173.attacker"]) {
    await assert.rejects(bridge.handleInvoke("launcher:getSnapshot", { ...context, origin }), (error: UiError) => error.code === "UNAUTHORIZED_ORIGIN");
  }
  await assert.rejects(bridge.handleInvoke("launcher:getSnapshot", { ...context, sender: { id: 2, send() {} } }), (error: UiError) => error.code === "UNAUTHORIZED_SENDER");
});

test("G4 fix: invalid cursor/query and extra arguments fail before reaching backend", async () => {
  const { bridge, context } = setup();
  await assert.rejects(bridge.handleInvoke("launcher:getSessions", context, { cookie: "synthetic" }), (error: UiError) => error.code === "INVALID_ARGUMENT");
  await assert.rejects(bridge.handleInvoke("launcher:getActivity", context, { limit: 100000 }), (error: UiError) => error.code === "CONTRACT_MISMATCH");
  await assert.rejects(bridge.handleInvoke("launcher:getSnapshot", context, "unexpected"), (error: UiError) => error.code === "INVALID_ARGUMENT");
});

test("G4 fix: outgoing snapshot and event metadata are validated and deeply redacted", async t => {
  const { bridge, context, backend } = setup();
  const snapshot = await backend.getSnapshot();
  snapshot.integration.error = { code: "SERVICE_UNAVAILABLE", message: 'Authorization: Bearer SYNTHETIC_G4_SECRET', retryable: false };
  t.mock.method(backend, "getSnapshot", async () => snapshot);
  const result = await bridge.handleInvoke("launcher:getSnapshot", context);
  assert.equal(JSON.stringify(result).includes("SYNTHETIC_G4_SECRET"), false);
  const received: unknown[] = [];
  context.sender.send = (_channel, value) => received.push(value);
  let publish!: (event: RuntimeEvent) => void;
  t.mock.method(backend, "subscribe", (listener: (event: RuntimeEvent) => void) => { publish = listener; return () => {}; });
  await bridge.handleInvoke("launcher:subscribe", context);
  publish({ schemaVersion: "0.1", runtimeInstanceId: "fixture", sequence: 1, id: "event", occurredAt: new Date().toISOString(), type: "snapshot.updated", payload: { snapshot } });
  assert.equal(JSON.stringify(received).includes("SYNTHETIC_G4_SECRET"), false);
  const invalid = { ...snapshot, schemaVersion: "invalid" };
  t.mock.method(backend, "getSnapshot", async () => invalid);
  const reply = await bridge.invoke("launcher:getSnapshot", context);
  assert.equal(reply.ok, false);
  if (!reply.ok) assert.equal(reply.error.code, "CONTRACT_MISMATCH");
  bridge.disposeAll();
});

test("G4 fix: a chosen destination is never ignored when there is no file exporter", async () => {
  const { backend, context } = setup();
  const bridge = new IpcSecurityBridge({ backend, trustedSender: () => true, onSaveDialog: async () => "D:\\synthetic.json" });
  await assert.rejects(bridge.handleInvoke("launcher:execute", context, { requestId: "export", type: "activity.export", payload: { range: "last_24h" } }), (error: UiError) => error.code === "SERVICE_UNAVAILABLE");
});

test("G4 fix: preload establishes subscription before snapshot and unregisters the last listener", async () => {
  const { bridge, context } = setup();
  const calls: string[] = [];
  const eventListeners = new Set<(...args: unknown[]) => void>();
  const invoker: IpcInvoker = {
    invoke: async (channel, ...args) => { calls.push(channel); return bridge.invoke(channel, context, ...args); },
    on: (_channel, listener) => { eventListeners.add(listener); },
    removeListener: (_channel, listener) => { eventListeners.delete(listener); },
  };
  const preload = createPreloadClient(invoker);
  const off = preload.subscribe(() => {});
  RuntimeSnapshotSchema.parse(await preload.getSnapshot());
  assert.ok(calls.indexOf("launcher:subscribe") < calls.indexOf("launcher:getSnapshot"));
  off();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(eventListeners.size, 0);
  assert.ok(calls.includes("launcher:unsubscribe"));
  assert.equal(JSON.stringify(sanitizeDiagnostics({ message: 'password = "SYNTHETIC_SECRET"' })).includes("SYNTHETIC_SECRET"), false);
});

test("G4 IPC: window navigation / reload while operation is pending safely unregisters sender", async () => {
  const { bridge, context, backend } = setup();
  let senderDisposed = false;
  context.sender.send = () => {
    if (senderDisposed) throw new Error("Window was navigated away; send must not be called");
  };
  let publishEvent!: (event: RuntimeEvent) => void;
  backend.subscribe = (listener) => {
    publishEvent = listener;
    return () => {};
  };
  await bridge.handleInvoke("launcher:subscribe", context);

  // Simulate window navigation / reload event
  bridge.disposeSender(context.sender.id);
  senderDisposed = true;

  // Emitting event after navigation must not call destroyed sender or throw
  assert.doesNotThrow(() => {
    publishEvent({
      schemaVersion: "0.1",
      runtimeInstanceId: "fixture",
      sequence: 1,
      id: "evt-nav",
      occurredAt: new Date().toISOString(),
      type: "snapshot.updated",
      payload: { snapshot: null as any },
    });
  });
});

test("G4 IPC: second-instance handler restores minimized window and focuses", async () => {
  let restored = false;
  let shown = false;
  let focused = false;
  const mockWindow = {
    isMinimized: () => true,
    restore: () => { restored = true; },
    show: () => { shown = true; },
    focus: () => { focused = true; },
  };

  focusLauncherWindow(mockWindow);

  assert.equal(restored, true);
  assert.equal(shown, true);
  assert.equal(focused, true);
});

test("G4 IPC: cleanup failure in disposeAll fails closed with structured SERVICE_UNAVAILABLE error", () => {
  const { bridge, context } = setup();
  const badUnsubscribe = () => { throw new Error("synthetic disposal failure"); };
  (bridge as any).activeSubscribers.set(context.sender.id, badUnsubscribe);

  assert.throws(
    () => bridge.disposeAll(),
    (err: UiError) => err.code === "SERVICE_UNAVAILABLE"
  );
});

