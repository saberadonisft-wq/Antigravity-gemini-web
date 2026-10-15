import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeFixtureProfile } from "./fixture-cleanup.js";
import {
  LiveGeminiBrowserAdapter,
  GeminiBrowserDriver,
  type CdpClient,
  type DomInspectionResult,
} from "./index.js";
import type { UiError } from "@antigravity-gemini-web/contracts";

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


test("V2 Regression: Attached browser cleanup only disconnects and does NOT send Browser.close or taskkill", async (t) => {
  const driver = new GeminiBrowserDriver({ fixtureMode: true });
  driver.isOwnedProcess = false;
  driver.isAttachedTarget = true;

  const sentCommands: string[] = [];
  let closed = false;

  const mockCdp = {
    isConnected: true,
    send: async (method: string) => {
      sentCommands.push(method);
      return {};
    },
    close: () => {
      closed = true;
    },
  };

  driver.cdp = mockCdp as unknown as CdpClient;

  // Cleanup attached driver
  await driver.close();

  // MUST NOT send Browser.close when not owned!
  assert.equal(sentCommands.includes("Browser.close"), false, "Attached target cleanup must NOT send Browser.close");
  assert.equal(closed, true, "CDP transport must be closed");
  assert.equal(driver.cdp, null);

  // Now verify owned process DOES send Browser.close
  const ownedDriver = new GeminiBrowserDriver({ fixtureMode: true });
  ownedDriver.isOwnedProcess = true;
  const ownedSent: string[] = [];
  ownedDriver.cdp = {
    isConnected: true,
    send: async (method: string) => {
      ownedSent.push(method);
      return {};
    },
    close: () => {},
  } as unknown as CdpClient;

  await ownedDriver.close();
  assert.equal(ownedSent.includes("Browser.close"), true, "Owned process cleanup MUST send Browser.close");
});

test("V3 Regression: Unrelated surface with generic textarea is rejected, never signed_in, and never invents model", async (t) => {
  const port = await getFreePort();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`
      <!DOCTYPE html>
      <html>
        <head><title>Unrelated Support Portal</title></head>
        <body>
          <h2>Customer Support</h2>
          <textarea id="comment" placeholder="Leave a feedback"></textarea>
          <button id="submit">Submit</button>
        </body>
      </html>
    `);
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));

  const tempProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-v3-test-profile-"));
  const debugPort = await getFreePort();

  // Adapter in Live Mode (fixtureMode: false by default)
  const adapter = new LiveGeminiBrowserAdapter({
    targetUrl: `http://127.0.0.1:${port}/`,
    userDataDir: tempProfileDir,
    debugPort,
    headless: true,
    fixtureMode: false, // Strictly live mode
  });

  t.after(async () => {
    try {
      await adapter.cleanup();
    } finally {
      try {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      } finally {
        assert.equal(path.dirname(path.resolve(tempProfileDir)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(tempProfileDir).startsWith("gemini-v3-test-profile-"));
        await removeFixtureProfile(tempProfileDir);
      }
    }
  });

  // Test 1: Controlled DOM proof on simulated https://example.invalid/support
  const controlledAdapter = new LiveGeminiBrowserAdapter({ fixtureMode: false });
  controlledAdapter.driver.cdp = {
    isConnected: true,
    evaluate: async (script: string) => {
      // Simulate execution on https://example.invalid/support
      return {
        url: "https://example.invalid/support",
        origin: "https://example.invalid",
        pathname: "/support",
        title: "Customer Support",
        isAllowedSurface: false,
        hasComposer: false,
        hasSendButton: false,
        isGenerating: false,
        accountState: "unknown",
        modelDetected: undefined,
        responseCount: 0,
        lastResponseText: "",
        hasCodeBlock: false,
      };
    },
    close: () => {},
  } as unknown as CdpClient;

  const controlledStatus = await controlledAdapter.checkStatus();
  assert.equal(controlledStatus.browserState, "closed");
  assert.equal(controlledStatus.accountState, "unknown");
  assert.equal(controlledStatus.displayLabel, undefined, "Must NOT invent model for invalid surface");

  // Test 2: Unrelated local server in live mode (rejected surface)
  const openRes = await adapter.driver.launchOrAttach(2000);
  assert.equal(openRes, false, "Must not attach/open unrelated surface in live mode");
  const status = await adapter.checkStatus();
  assert.equal(status.browserState, "closed");
  assert.equal(status.accountState, "unknown");
  assert.equal(status.displayLabel, undefined);

  await assert.rejects(
    async () => {
      await adapter.sendPrompt("Hello on wrong surface");
    },
    (err: unknown) => {
      const uiErr = err as UiError;
      assert.equal(uiErr.code, "LOGIN_REQUIRED");
      return true;
    }
  );
});

test("V4 Regression: Partial response after timeout returns status 'failed' with TIMEOUT code, never completed", async () => {
  const adapter = new LiveGeminiBrowserAdapter({ fixtureMode: true });

  // Stub driver status & DOM inspection
  (adapter as any).checkStatus = async () => ({
    browserState: "ready",
    accountState: "signed_in",
    checkedAt: new Date().toISOString(),
  });

  adapter.driver.inspectDom = async (): Promise<DomInspectionResult> => ({
    url: "http://127.0.0.1/app",
    origin: "http://127.0.0.1",
    pathname: "/app",
    title: "Gemini",
    isAllowedSurface: true,
    hasComposer: true,
    hasSendButton: true,
    isGenerating: false,
    accountState: "signed_in",
    responseCount: 1,
    lastResponseText: "PARTIAL STREAM TOKENS",
    hasCodeBlock: false,
  });

  adapter.driver.inputPrompt = async () => true;
  adapter.driver.clickSend = async () => true;

  // Driver poll returns uncompleted response with partial text
  adapter.driver.pollForResponse = async () => ({
    text: "PARTIAL STREAM TOKENS THAT NEVER FINISHED",
    completed: false, // Timeout occurred before stop button disappeared!
    cancelled: false,
    hasCodeBlock: false,
  });

  await adapter.submitPrompt("turn-v4-partial", "Write a long essay");
  const response = await adapter.pollResponse("turn-v4-partial", { deadlineMs: 100 });

  // Must NOT report completed!
  assert.equal(response.status, "failed", "Partial timeout response must NOT be completed");
  assert.equal(response.error?.code, "TIMEOUT");
  assert.equal(response.text, "PARTIAL STREAM TOKENS THAT NEVER FINISHED");

  // sendPrompt must fail
  await assert.rejects(async () => {
    (adapter as any).activeTurns.clear();
    await adapter.sendPrompt("Write a long essay");
  });
});

test("V5 Regression: Cancellation: requested vs confirmed, failure handling, and terminal immutability", async () => {
  const adapter = new LiveGeminiBrowserAdapter({ fixtureMode: true });

  (adapter as any).checkStatus = async () => ({
    browserState: "ready",
    accountState: "signed_in",
    checkedAt: new Date().toISOString(),
  });

  adapter.driver.inspectDom = async (): Promise<DomInspectionResult> => ({
    url: "http://127.0.0.1/app",
    origin: "http://127.0.0.1",
    pathname: "/app",
    title: "Gemini",
    isAllowedSurface: true,
    hasComposer: true,
    hasSendButton: true,
    isGenerating: false,
    accountState: "signed_in",
    responseCount: 1,
    lastResponseText: "",
    hasCodeBlock: false,
  });

  adapter.driver.inputPrompt = async () => true;
  adapter.driver.clickSend = async () => true;

  // 1. Stop button returns false
  adapter.driver.clickStop = async () => false;
  await adapter.submitPrompt("turn-v5-fail", "Test cancel failure");
  const cancelResFail = await adapter.cancelPrompt("turn-v5-fail");
  assert.equal(cancelResFail.cancelled, false, "Must return cancelled: false when clickStop returns false");

  // 2. Stop button throws exception
  adapter.driver.clickStop = async () => {
    throw new Error("CDP evaluate failed");
  };
  const cancelResThrow = await adapter.cancelPrompt("turn-v5-fail");
  assert.equal(cancelResThrow.cancelled, false, "Must return cancelled: false when clickStop throws");

  // 3. Stop button succeeds and confirmed on DOM
  adapter.driver.clickStop = async () => true;
  adapter.driver.inspectDom = async (): Promise<DomInspectionResult> => ({
    url: "http://127.0.0.1/app",
    origin: "http://127.0.0.1",
    pathname: "/app",
    title: "Gemini",
    isAllowedSurface: true,
    hasComposer: true,
    hasSendButton: true,
    isGenerating: false, // Confirmed stopped!
    accountState: "signed_in",
    responseCount: 1,
    lastResponseText: "Aborted output",
    hasCodeBlock: false,
  });

  const cancelResOk = await adapter.cancelPrompt("turn-v5-fail");
  assert.equal(cancelResOk.cancelled, true, "Cancel must be confirmed when stop verified on DOM");

  // 4. Cancel on already-terminal turn must be rejected
  const cancelAgain = await adapter.cancelPrompt("turn-v5-fail");
  assert.equal(cancelAgain.cancelled, false, "Cannot cancel turn already in terminal cancelled state");
  assert.ok(cancelAgain.reason?.includes("terminal"));

  // 5. Poll on cancelled turn returns immutable terminal cancelled response
  const poll1 = await adapter.pollResponse("turn-v5-fail");
  const poll2 = await adapter.pollResponse("turn-v5-fail");
  assert.equal(poll1.status, "cancelled");
  assert.equal(poll2.status, "cancelled");
  assert.equal(poll1.completedAt, poll2.completedAt, "Terminal outcome must be strictly immutable");
});

test("V6 Regression: Duplicate submissions, conflicting prompt content, and sequential turn reservation", async () => {
  const adapter = new LiveGeminiBrowserAdapter({ fixtureMode: true });

  let sendClickCount = 0;
  (adapter as any).checkStatus = async () => ({
    browserState: "ready",
    accountState: "signed_in",
    checkedAt: new Date().toISOString(),
  });

  adapter.driver.inspectDom = async (): Promise<DomInspectionResult> => ({
    url: "http://127.0.0.1/app",
    origin: "http://127.0.0.1",
    pathname: "/app",
    title: "Gemini",
    isAllowedSurface: true,
    hasComposer: true,
    hasSendButton: true,
    isGenerating: false,
    accountState: "signed_in",
    responseCount: 0,
    lastResponseText: "",
    hasCodeBlock: false,
  });

  adapter.driver.inputPrompt = async () => true;
  adapter.driver.clickSend = async () => {
    sendClickCount++;
    return true;
  };

  // 1. First submission
  const receipt1 = await adapter.submitPrompt("turn-seq-1", "Prompt Alpha");
  assert.equal(receipt1.status, "accepted");
  assert.equal(sendClickCount, 1);

  // 2. Duplicate submission with identical turnId and prompt -> idempotent, no second Send click!
  const receiptDup = await adapter.submitPrompt("turn-seq-1", "Prompt Alpha");
  assert.equal(receiptDup.status, "accepted");
  assert.equal(sendClickCount, 1, "Idempotent duplicate submission must NOT re-click Send");

  // 3. Conflicting submission with same turnId but different prompt content -> rejected
  await assert.rejects(
    async () => {
      await adapter.submitPrompt("turn-seq-1", "Prompt Beta (Conflicting)");
    },
    (err: unknown) => {
      const uiErr = err as UiError;
      assert.equal(uiErr.code, "CONFIG_CONFLICT");
      return true;
    }
  );

  // 4. Overlapping submission while turn-seq-1 is non-terminal -> rejected with BUSY
  await assert.rejects(
    async () => {
      await adapter.submitPrompt("turn-seq-2", "Prompt Gamma");
    },
    (err: unknown) => {
      const uiErr = err as UiError;
      assert.equal(uiErr.code, "BUSY");
      assert.ok(uiErr.message.includes("turn-seq-1"));
      return true;
    }
  );

  // 5. Complete turn-seq-1
  adapter.driver.pollForResponse = async () => ({
    text: "Response Alpha",
    completed: true,
    cancelled: false,
    hasCodeBlock: false,
  });
  const res1 = await adapter.pollResponse("turn-seq-1");
  assert.equal(res1.status, "completed");

  // 6. Now turn-seq-2 can be submitted cleanly
  const receipt2 = await adapter.submitPrompt("turn-seq-2", "Prompt Gamma");
  assert.equal(receipt2.status, "accepted");
  assert.equal(sendClickCount, 2);
});
