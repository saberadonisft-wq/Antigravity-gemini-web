import { test } from "node:test";
import assert from "node:assert/strict";
import { IpcSecurityBridge, type IpcCallContext, type IpcSender } from "./ipc-bridge.js";
import { createPreloadClient, type IpcInvoker } from "../preload/client.js";
import { RuntimeFacade } from "@antigravity-gemini-web/runtime";
import type { RuntimeEvent, ControlCommand } from "@antigravity-gemini-web/contracts";

test("G4-IPC: Unknown channel is strictly rejected with UNKNOWN_CHANNEL", async () => {
  const facade = new RuntimeFacade({ mode: "demo" });
  const bridge = new IpcSecurityBridge({ backend: facade, trustedSender: () => true });

  const context: IpcCallContext = {
    sender: { id: 1, send: () => {} },
    isMainFrame: true,
    origin: "app://local",
  };

  await assert.rejects(
    async () => {
      await bridge.handleInvoke("shell:exec", context);
    },
    (err: any) => {
      assert.equal(err.code, "UNKNOWN_CHANNEL");
      return true;
    }
  );
});

test("G4-IPC: Subframe or iframe caller is strictly rejected with UNAUTHORIZED_FRAME", async () => {
  const facade = new RuntimeFacade({ mode: "demo" });
  const bridge = new IpcSecurityBridge({ backend: facade, trustedSender: () => true });

  const context: IpcCallContext = {
    sender: { id: 1, send: () => {} },
    isMainFrame: false, // from iframe
    origin: "app://local",
  };

  await assert.rejects(
    async () => {
      await bridge.handleInvoke("launcher:getSnapshot", context);
    },
    (err: any) => {
      assert.equal(err.code, "UNAUTHORIZED_FRAME");
      return true;
    }
  );
});

test("G4-IPC: Unauthorized origin is rejected with UNAUTHORIZED_ORIGIN", async () => {
  const facade = new RuntimeFacade({ mode: "demo" });
  const bridge = new IpcSecurityBridge({
    backend: facade, trustedSender: () => true,
    allowedOrigins: ["app://local", "http://127.0.0.1:5173"],
  });

  const context: IpcCallContext = {
    sender: { id: 1, send: () => {} },
    isMainFrame: true,
    origin: "https://malicious-website.com",
  };

  await assert.rejects(
    async () => {
      await bridge.handleInvoke("launcher:getSnapshot", context);
    },
    (err: any) => {
      assert.equal(err.code, "UNAUTHORIZED_ORIGIN");
      return true;
    }
  );
});

test("G4-IPC: Invalid command payload is rejected by shared Zod schema with CONTRACT_MISMATCH", async () => {
  const facade = new RuntimeFacade({ mode: "demo" });
  const bridge = new IpcSecurityBridge({ backend: facade, trustedSender: () => true });

  const context: IpcCallContext = {
    sender: { id: 1, send: () => {} },
    isMainFrame: true,
    origin: "app://local",
  };

  await assert.rejects(
    async () => {
      await bridge.handleInvoke("launcher:execute", context, {
        requestId: "req-1",
        type: "unknown.command",
        payload: {},
      });
    },
    (err: any) => {
      assert.equal(err.code, "CONTRACT_MISMATCH");
      return true;
    }
  );
});

test("G4-IPC: Capability gating strictly rejects unverified integration, model selection, and e2e checks", async () => {
  const facade = new RuntimeFacade({ mode: "demo" });
  const bridge = new IpcSecurityBridge({ backend: facade, trustedSender: () => true });

  const context: IpcCallContext = {
    sender: { id: 1, send: () => {} },
    isMainFrame: true,
    origin: "app://local",
  };

  // integration.apply rejected
  await assert.rejects(
    async () => {
      await bridge.handleInvoke("launcher:execute", context, {
        requestId: "req-gate-1",
        type: "integration.apply",
        payload: { previewId: "prev-1" },
      });
    },
    (err: any) => {
      assert.equal(err.code, "NATIVE_ROUTE_UNVERIFIED");
      return true;
    }
  );

  // model.select rejected
  await assert.rejects(
    async () => {
      await bridge.handleInvoke("launcher:execute", context, {
        requestId: "req-gate-2",
        type: "model.select",
        payload: { modelId: "gemini-2.5-pro" },
      });
    },
    (err: any) => {
      assert.equal(err.code, "MODEL_UNAVAILABLE");
      return true;
    }
  );

  // runtime.check end_to_end rejected
  await assert.rejects(
    async () => {
      await bridge.handleInvoke("launcher:execute", context, {
        requestId: "req-gate-3",
        type: "runtime.check",
        payload: { scope: "end_to_end" },
      });
    },
    (err: any) => {
      assert.equal(err.code, "NATIVE_ROUTE_UNVERIFIED");
      return true;
    }
  );
});

test("G4-IPC: Save dialog cancellation returns accepted: false with CANCELLED error", async () => {
  const facade = new RuntimeFacade({ mode: "demo" });
  const bridge = new IpcSecurityBridge({
    backend: facade, trustedSender: () => true,
    onSaveDialog: async () => null, // User cancelled file picker dialog
  });

  const context: IpcCallContext = {
    sender: { id: 1, send: () => {} },
    isMainFrame: true,
    origin: "app://local",
  };

  const ack: any = await bridge.handleInvoke("launcher:execute", context, {
    requestId: "req-export-1",
    type: "activity.export",
    payload: { range: "current_session" },
  });

  assert.equal(ack.accepted, false);
  assert.equal(ack.error.code, "CANCELLED");
});

test("G4-IPC: Preload client round-trip to Main IPC bridge and RuntimeFacade", async () => {
  const facade = new RuntimeFacade({ mode: "demo" });
  await facade.start();

  const eventsReceived: RuntimeEvent[] = [];
  const sender: IpcSender = {
    id: 42,
    send: (channel: string, event: any) => {
      if (channel === "launcher:event") {
        eventsReceived.push(event);
      }
    },
  };

  const context: IpcCallContext = {
    sender,
    isMainFrame: true,
    origin: "app://local",
  };

  const bridge = new IpcSecurityBridge({ backend: facade, trustedSender: () => true });

  // Simulate IPC invoker connecting preload client to bridge
  const invoker: IpcInvoker = {
    async invoke(channel: string, ...args: any[]) {
      return bridge.invoke(channel, context, ...args);
    },
    on(_channel: string, _listener: any) {},
    removeListener(_channel: string, _listener: any) {},
  };

  const preloadClient = createPreloadClient(invoker);

  // 1. getSnapshot
  const snap = await preloadClient.getSnapshot();
  assert.equal(snap.schemaVersion, "0.1");
  assert.equal(snap.mode, "demo");

  // 2. execute allowed command (browser.open)
  const ack = await preloadClient.execute({
    requestId: "req-open-1",
    type: "browser.open",
    payload: {},
  });
  assert.equal(ack.accepted, true);
  assert.ok(ack.operationId);

  // 3. getOperation
  const op = await preloadClient.getOperation(ack.operationId);
  assert.equal(op.id, ack.operationId);
  assert.equal(op.type, "browser.open");

  // 4. getSessions
  const sessionsPage = await preloadClient.getSessions();
  assert.ok(Array.isArray(sessionsPage.items));

  // 5. getActivity
  const activityPage = await preloadClient.getActivity({});
  assert.ok(Array.isArray(activityPage.items));

  // 6. subscribe via bridge
  const subAck: any = await bridge.handleInvoke("launcher:subscribe", context);
  assert.equal(subAck.subscribed, true);

  // Clean up
  bridge.disposeSender(42);
  await facade.stop();
});

