import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeFixtureProfile } from "./fixture-cleanup.js";
import net from "node:net";
import { GeminiDomFixtureServer } from "./fixture-server.js";
import { LiveGeminiBrowserAdapter } from "./index.js";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}


test("Browser driver lifecycle on owned DOM fixture: 3 turns (text, markdown, code block), cancel, and cleanup", { timeout: 60000 }, async (t) => {
  // 1. Unique temp profile and ephemeral ports (Requirement 4)
  const tempProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-driver-test-profile-"));
  const fixtureServer = new GeminiDomFixtureServer({ signedIn: true, streamDelayMs: 20 });
  await fixtureServer.start();

  const debugPort = await getFreePort();
  const adapter = new LiveGeminiBrowserAdapter({
    targetUrl: fixtureServer.url,
    userDataDir: tempProfileDir,
    debugPort,
    headless: true,
    fixtureMode: true,
    allowedOrigins: [fixtureServer.url, `http://127.0.0.1:${fixtureServer.port}`],
  });

  // 2. Register t.after cleanup FIRST before any assertions (Requirement 3)
  t.after(async () => {
    try {
      await adapter.cleanup();
    } finally {
      try {
        await fixtureServer.stop();
      } finally {
        assert.equal(path.dirname(path.resolve(tempProfileDir)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(tempProfileDir).startsWith("gemini-driver-test-profile-"));
        await removeFixtureProfile(tempProfileDir);
      }
    }
  });

  // 3. Open browser and attach CDP to DOM fixture
  const openRes = await adapter.openBrowser();
  assert.equal(openRes.opened, true, "Browser should open and connect CDP");

  // 4. Inspect status via positive evidence
  const status = await adapter.checkStatus();
  assert.equal(status.browserState, "ready");
  assert.equal(status.accountState, "signed_in");
  assert.equal(status.displayLabel, "Gemini 1.5 Pro");

  // 5. Turn 1: Plain Text conversation
  const receipt1 = await adapter.submitPrompt("turn-1", "Hello Gemini, please introduce yourself.");
  assert.equal(receipt1.status, "accepted");
  assert.equal(receipt1.turnId, "turn-1");

  const response1 = await adapter.pollResponse("turn-1", { deadlineMs: 5000 });
  assert.equal(response1.status, "completed");
  assert.ok(response1.text.includes("Turn 1 text response"), `Turn 1 text mismatch: ${response1.text}`);

  // 6. Turn 2: Markdown structure with headers and lists
  const receipt2 = await adapter.submitPrompt("turn-2", "Provide a plan in markdown.");
  assert.equal(receipt2.status, "accepted");

  const response2 = await adapter.pollResponse("turn-2", { deadlineMs: 5000 });
  assert.equal(response2.status, "completed");
  assert.ok(response2.text.includes("Turn 2 Markdown Header"), `Turn 2 markdown mismatch: ${response2.text}`);
  assert.ok(response2.text.includes("Item 1: Planning"));

  // 7. Turn 3: Code fence block
  const receipt3 = await adapter.submitPrompt("turn-3", "Write a typescript function.");
  assert.equal(receipt3.status, "accepted");

  const response3 = await adapter.pollResponse("turn-3", { deadlineMs: 5000 });
  assert.equal(response3.status, "completed");
  assert.ok(response3.text.includes("typescript"), `Turn 3 code fence mismatch: ${response3.text}`);
  assert.ok(response3.text.includes("runTask"));

  // 8. Cancellation test
  const receipt4 = await adapter.submitPrompt("turn-4", "Generate a very long response.");
  assert.equal(receipt4.status, "accepted");

  const cancelRes = await adapter.cancelPrompt("turn-4");
  assert.equal(cancelRes.cancelled, true);

  const response4 = await adapter.pollResponse("turn-4", { deadlineMs: 3000 });
  assert.equal(response4.status, "cancelled");
});
