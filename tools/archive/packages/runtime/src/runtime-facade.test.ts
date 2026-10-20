import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { RuntimeFacade } from "./runtime-facade.js";
import type { UiError } from "@antigravity-gemini-web/contracts";

test("G4-Facade: RuntimeFacade lifecycle, journal loading, and coordinator retrieval", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "facade-test-"));
  try {
    const facade = new RuntimeFacade({
      mode: "demo",
      appDataDir: tempDir,
    });

    await facade.start();

    // Verify coordinator creation
    const coord1 = facade.getOrCreateCoordinator("ws-1", "sess-1");
    assert.ok(coord1);
    const coord2 = facade.getOrCreateCoordinator("ws-1", "sess-1");
    assert.equal(coord1, coord2, "Coordinators for same session must be identical instance");

    // Snapshot
    const snap = await facade.getSnapshot();
    assert.equal(snap.schemaVersion, "0.1");

    // Stop and verify clean shutdown
    await facade.stop();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("G4-Facade: Capability gating rejects unverified commands at facade boundary", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "facade-gate-test-"));
  try {
    const facade = new RuntimeFacade({
      mode: "demo",
      appDataDir: tempDir,
    });
    await facade.start();

    // 1. integration.apply
    await assert.rejects(
      async () => {
        await facade.execute({
          requestId: "req-facade-gate-1",
          type: "integration.apply",
          payload: { previewId: "prev-1" },
        });
      },
      (err: any) => {
        assert.equal(err.code, "NATIVE_ROUTE_UNVERIFIED");
        return true;
      }
    );

    // 2. model.select
    await assert.rejects(
      async () => {
        await facade.execute({
          requestId: "req-facade-gate-2",
          type: "model.select",
          payload: { modelId: "gemini-2.5-pro" },
        });
      },
      (err: any) => {
        assert.equal(err.code, "MODEL_UNAVAILABLE");
        return true;
      }
    );

    // 3. runtime.check end_to_end
    await assert.rejects(
      async () => {
        await facade.execute({
          requestId: "req-facade-gate-3",
          type: "runtime.check",
          payload: { scope: "end_to_end" },
        });
      },
      (err: any) => {
        assert.equal(err.code, "NATIVE_ROUTE_UNVERIFIED");
        return true;
      }
    );

    await facade.stop();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("G4-Facade: Allowed commands execute and track operations through facade", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "facade-exec-test-"));
  try {
    const facade = new RuntimeFacade({
      mode: "demo",
      appDataDir: tempDir,
    });
    await facade.start();

    // Execute allowed command (browser.open)
    const ack = await facade.execute({
      requestId: "req-facade-open-1",
      type: "browser.open",
      payload: {},
    });

    assert.equal(ack.accepted, true);
    assert.ok(ack.operationId);

    // Query operation record
    const op = await facade.getOperation(ack.operationId);
    assert.equal(op.id, ack.operationId);
    assert.equal(op.type, "browser.open");

    // Sessions and Activity
    const sessions = await facade.getSessions();
    assert.ok(Array.isArray(sessions.items));

    const activities = await facade.getActivity({});
    assert.ok(Array.isArray(activities.items));

    await facade.stop();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

