import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveNativeAntigravityAdapter } from "./index.js";
import type { UiError } from "@antigravity-gemini-web/contracts";

test("LiveNativeAntigravityAdapter always returns unverified status and never produces fake success", async () => {
  const adapter = new LiveNativeAntigravityAdapter();
  const status = await adapter.checkStatus();

  assert.equal(status.target, "native_ide");
  assert.equal(status.state, "unverified");
  assert.equal(status.capability.state, "unverified");
  assert.equal(status.capability.reasonCode, "NATIVE_ROUTE_UNVERIFIED");
  assert.equal(status.hostVersion, undefined);
  assert.equal(status.hostDetected, undefined);

  const preview = await adapter.previewBridge("install");
  assert.equal(preview.canApply, false);
  assert.ok(preview.unverifiedReason?.includes("NATIVE_ROUTE_UNVERIFIED"));

  await assert.rejects(
    async () => {
      await adapter.applyBridge(preview.previewId);
    },
    (err: unknown) => {
      const uiErr = err as UiError;
      assert.equal(uiErr.code, "NATIVE_ROUTE_UNVERIFIED");
      assert.equal(uiErr.retryable, false);
      return true;
    }
  );
});

