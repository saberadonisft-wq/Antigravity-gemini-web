import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveGeminiBrowserAdapter } from "./index.js";
import type { UiError } from "@antigravity-gemini-web/contracts";

test("LiveGeminiBrowserAdapter reports unknown account and never produces fake opened: true [F1 regression]", { timeout: 60000 }, async (t) => {
  // Controlled closed driver configuration with non-existent binary and unused port
  const adapter = new LiveGeminiBrowserAdapter({
    chromePath: "C:\\non-existent-chrome-path\\chrome.exe",
    debugPort: 59999,
  });

  t.after(async () => {
    await adapter.cleanup();
  });

  const initialStatus = await adapter.checkStatus();
  assert.equal(initialStatus.browserState, "closed");
  assert.equal(initialStatus.accountState, "unknown");

  const openRes = await adapter.openBrowser();
  // Must NOT claim opened: true when no browser process was started
  assert.equal(openRes.opened, false);
  assert.ok(openRes.actionReason?.toLowerCase().includes("failed"));

  await assert.rejects(
    async () => {
      await adapter.sendPrompt("Hello Gemini");
    },
    (err: unknown) => {
      const uiErr = err as UiError;
      assert.equal(uiErr.code, "LOGIN_REQUIRED");
      assert.equal(uiErr.suggestedAction, "open_browser");
      return true;
    }
  );
});
