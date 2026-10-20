import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeFixtureProfile } from "./fixture-cleanup.js";
import net from "node:net";
import { GeminiDomFixtureServer, openFixtureBrowser } from "./fixture-server.js";
import { LiveGeminiBrowserAdapter, GeminiBrowserDriver } from "./index.js";
import { createHash } from "node:crypto";

test("Composer readiness waits through the initial about:blank navigation but rejects other origins", async () => {
  const driver = new GeminiBrowserDriver({ fixtureMode: true, allowedOrigins: ["http://127.0.0.1:4321"] });
  let reads = 0;
  const cdp = {
    isConnected: true,
    evaluate: async () => {
      reads++;
      return reads === 1
        ? { url: "about:blank", allowed: false, ready: false, signature: "" }
        : { url: "http://127.0.0.1:4321/app", allowed: true, ready: true, signature: "stable" };
    },
  };
  Object.assign(driver, { cdp });
  assert.equal(await driver.waitForComposerReady(), true);
  assert.ok(reads >= 3, "composer must remain stable after navigation commits");

  reads = 0;
  Object.assign(driver, { cdp: { ...cdp, evaluate: async () => {
    reads++;
    return { url: "http://127.0.0.1:4321/app", allowed: reads >= 2, ready: reads >= 2, signature: "stable" };
  } } });
  assert.equal(await driver.waitForComposerReady(), true, "a valid Gemini page may need time to hydrate signed-in account state");
  assert.ok(reads >= 3, "readiness must wait for account hydration and a stable composer");

  Object.assign(driver, { cdp: { ...cdp, evaluate: async () => ({ url: "https://accounts.google.com/", allowed: false, ready: false, signature: "" }) } });
  assert.equal(await driver.waitForComposerReady(), false);
});

test("Google traffic verification is an explicit user action without allowing the challenge origin for prompts", async () => {
  const adapter = new LiveGeminiBrowserAdapter();
  let url = "https://www.google.com/sorry/index?continue=PRIVATE_SYNTHETIC_QUERY";
  Object.assign(adapter.driver, { cdp: { isConnected: true }, inspectDom: async () => ({ url, isAllowedSurface: false, accountState: "unknown", hasComposer: false }) });
  const status = await adapter.checkStatus();
  assert.equal(status.browserState, "needs_user_action"); assert.equal(status.error?.code, "BROWSER_USER_ACTION_REQUIRED");
  assert.equal(status.error?.detail, "google_traffic_verification"); assert.ok(!JSON.stringify(status).includes("PRIVATE_SYNTHETIC_QUERY"));
  assert.deepEqual(adapter.driver.allowedOrigins, []);
  url = "https://www.google.com.evil.invalid/sorry/index";
  assert.equal((await adapter.checkStatus()).browserState, "closed");
});

test("Strict profile identity rejects an occupied CDP port belonging to another profile without changing its tabs", { timeout: 40000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-driver-test-profile-"));
  const fixture = new GeminiDomFixtureServer({ signedIn: true }); await fixture.start();
  const port = await getFreePort(), options = { targetUrl: fixture.url, userDataDir: directory, debugPort: port, headless: true, fixtureMode: true, allowedOrigins: [fixture.url], requireProfileIdentity: true };
  const owner = new GeminiBrowserDriver(options), wrong = new GeminiBrowserDriver({ ...options, userDataDir: directory + "-another" }), joining = new GeminiBrowserDriver(options);
  t.after(async () => { try { await wrong.close(); await joining.close(); await owner.close(); } finally { await fixture.stop(); await removeFixtureProfile(directory); } });
  assert.equal(await owner.launchOrAttach(25000), true, "A fresh CI Chrome process must expose its fixture target before identity checks");
  const loadedUntil = performance.now() + 5000;
  while (performance.now() < loadedUntil) {
    const dom = await owner.inspectDom();
    if (dom.hasComposer && dom.accountState === "signed_in") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await owner.waitForComposerReady(), true, JSON.stringify(await owner.inspectDom()));
  await owner.cdp!.evaluate("document.querySelector('[contenteditable]').innerText = 'preserved draft'");
  const targets = await owner.cdp!.send("Target.getTargets");
  await assert.rejects(wrong.launchOrAttach(), /another or unverified browser profile/);
  assert.equal(wrong.isConnected, false); assert.equal(wrong.isOwnedProcess, false);
  assert.equal(await owner.cdp!.evaluate("document.querySelector('[contenteditable]').innerText"), "preserved draft");
  const pageIds = (value: { targetInfos: Array<{ type: string; targetId: string }> }) => value.targetInfos.filter(target => target.type === "page").map(target => target.targetId).sort();
  assert.deepEqual(pageIds(await owner.cdp!.send("Target.getTargets")), pageIds(targets));
  assert.equal(await joining.launchOrAttach(), true); assert.equal(joining.isOwnedProcess, false);
});

test("An account changed after input is rejected before the actual Send click; a verified account can continue", { timeout: 20000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-driver-test-profile-"));
  const fixture = new GeminiDomFixtureServer({ signedIn: true, streamDelayMs: 2 });
  await fixture.start();
  const live = new LiveGeminiBrowserAdapter({ targetUrl: fixture.url, userDataDir: directory, debugPort: await getFreePort(), headless: true, fixtureMode: true, allowedOrigins: [fixture.url] });
  t.after(async () => { try { await live.cleanup(); } finally { await fixture.stop(); await removeFixtureProfile(directory); } });
  assert.equal((await openFixtureBrowser(live)).opened, true);
  const fingerprint = createHash("sha256").update("testuser@example.com").digest("hex");
  const input = live.driver.inputPrompt.bind(live.driver);
  live.driver.inputPrompt = async (text, check) => {
    const result = await input(text, check);
    await live.driver.cdp!.evaluate(`document.querySelector('[data-test-id="user-avatar"]').setAttribute('aria-label', 'Google Account: another@example.com')`);
    return result;
  };
  await assert.rejects(live.submitPrompt("identity-before-send", "Synthetic identity probe", { expectedAccountFingerprint: fingerprint }), { code: "ACCOUNT_IDENTITY_CHANGED", delivery: "not_sent", submissionDiagnostic: { inputChars: "Synthetic identity probe".length, readbackVerified: true, sendClickAttempted: false, acceptanceObserved: false } });
  assert.equal(await live.driver.cdp!.evaluate("document.querySelectorAll('.user-query').length"), 0);
  assert.equal((await live.driver.inspectDom()).responseCount, 0);
  live.driver.inputPrompt = input;
  await live.driver.cdp!.evaluate(`document.querySelector('[data-test-id="user-avatar"]').setAttribute('aria-label', 'Google Account: testuser@example.com')`);
  const accepted = await live.submitPrompt("identity-corrected", "Verified synthetic continuation", { expectedAccountFingerprint: fingerprint });
  assert.deepEqual(accepted.submissionDiagnostic, { inputChars: "Verified synthetic continuation".length, readbackVerified: true, sendClickAttempted: true, acceptanceObserved: true });
  assert.equal((await live.pollResponse("identity-corrected", { deadlineMs: 5000 })).status, "completed");
  assert.equal(await live.driver.cdp!.evaluate("document.querySelectorAll('.user-query').length"), 1);
});

test("Account identity uses all visible avatar attributes and fails closed on conflicting emails", { timeout: 20000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-driver-test-profile-"));
  const fixture = new GeminiDomFixtureServer({ signedIn: true });
  await fixture.start();
  const live = new LiveGeminiBrowserAdapter({ targetUrl: fixture.url, userDataDir: directory, debugPort: await getFreePort(), headless: true, fixtureMode: true, allowedOrigins: [fixture.url] });
  t.after(async () => { try { await live.cleanup(); } finally { await fixture.stop(); await removeFixtureProfile(directory); } });
  assert.equal((await openFixtureBrowser(live)).opened, true);
  const domDeadline = Date.now() + 10000;
  let domReady = false;
  while (Date.now() < domDeadline) {
    try {
      const dom = await live.driver.inspectDom();
      if (dom.isAllowedSurface && dom.accountState === "signed_in" && dom.hasComposer) { domReady = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(domReady, true, "fixture Gemini tab should finish its initial navigation before simulating account hydration");

  await live.driver.cdp!.evaluate(`(() => {
    const avatar = document.querySelector('[data-test-id="user-avatar"]');
    avatar.setAttribute('aria-label', 'Google Account');
    avatar.setAttribute('title', 'testuser@example.com');
    avatar.setAttribute('alt', 'Profile image');
    const hidden = document.createElement('img');
    hidden.setAttribute('data-test-id', 'user-avatar');
    hidden.setAttribute('aria-label', 'hidden@example.com');
    hidden.style.display = 'none';
    document.body.appendChild(hidden);
  })()`);
  let inspection = await live.driver.inspectDom();
  assert.equal(inspection.accountState, "signed_in");
  assert.equal(inspection.accountIdentity, "testuser@example.com", "generic aria-label must not hide the email in title");

  await live.driver.cdp!.evaluate(`(() => {
    const second = document.createElement('img');
    second.setAttribute('data-test-id', 'user-avatar');
    second.setAttribute('aria-label', 'another@example.com');
    second.style.cssText = 'position:fixed;width:24px;height:24px;left:0;top:0';
    document.body.appendChild(second);
  })()`);
  inspection = await live.driver.inspectDom();
  assert.equal(inspection.accountIdentity, undefined, "conflicting visible account emails must not select an identity");
});

test("Browser status waits for the account email to hydrate on a new signed-in tab", { timeout: 20000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-driver-test-profile-"));
  const fixture = new GeminiDomFixtureServer({ signedIn: true });
  await fixture.start();
  const live = new LiveGeminiBrowserAdapter({ targetUrl: fixture.url, userDataDir: directory, debugPort: await getFreePort(), headless: true, fixtureMode: true, allowedOrigins: [fixture.url] });
  t.after(async () => { try { await live.cleanup(); } finally { await fixture.stop(); await removeFixtureProfile(directory); } });
  assert.equal((await openFixtureBrowser(live)).opened, true);
  const domDeadline = Date.now() + 10000;
  let domReady = false;
  while (Date.now() < domDeadline) {
    try {
      const dom = await live.driver.inspectDom();
      if (dom.isAllowedSurface && dom.accountState === "signed_in" && dom.hasComposer) { domReady = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(domReady, true, "fixture Gemini tab should finish its initial navigation before simulating account hydration");

  await live.driver.cdp!.evaluate(`(() => {
    const avatar = document.querySelector('[data-test-id="user-avatar"]');
    avatar.setAttribute('aria-label', 'Google Account');
    setTimeout(() => avatar.setAttribute('aria-label', 'Google Account: testuser@example.com'), 350);
  })()`);
  const started = performance.now();
  const status = await live.checkStatus();
  assert.equal(status.browserState, "ready", JSON.stringify(status));
  assert.equal(status.accountState, "signed_in");
  assert.equal(status.accountIdentity, "testuser@example.com");
  assert.ok(performance.now() - started >= 250, "status should wait for the delayed account label");
});

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

test("Composer readiness waits through a terminal response's editor transition and supports cancellation before Send", { timeout: 20000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-driver-test-profile-"));
  const fixture = new GeminiDomFixtureServer({ signedIn: true, streamDelayMs: 2, composerReadyDelayMs: 1500 });
  await fixture.start();
  const live = new LiveGeminiBrowserAdapter({ targetUrl: fixture.url, userDataDir: directory, debugPort: await getFreePort(), headless: true, fixtureMode: true, allowedOrigins: [fixture.url] });
  t.after(async () => { try { await live.cleanup(); } finally { await fixture.stop(); await removeFixtureProfile(directory); } });
  assert.equal((await openFixtureBrowser(live)).opened, true);
  await live.submitPrompt("ready-first", "first");
  assert.equal((await live.pollResponse("ready-first", { deadlineMs: 5000 })).status, "completed");
  assert.equal(await live.driver.cdp!.evaluate("document.querySelector('[contenteditable]').getAttribute('aria-busy')"), "true");
  await live.submitPrompt("ready-second", "second");
  assert.equal((await live.driver.inspectDom()).responseCount, 2);
  assert.equal((await live.pollResponse("ready-second", { deadlineMs: 5000 })).status, "completed");
  await live.driver.cdp!.evaluate("document.querySelector('[contenteditable]').setAttribute('aria-busy', 'true')");
  let checks = 0;
  await assert.rejects(live.driver.inputPrompt("must not be entered", () => { if (++checks >= 3) throw Error("cancel readiness"); }), /cancel readiness/);
  assert.equal((await live.driver.inspectDom()).responseCount, 2);
  assert.equal((await live.driver.inspectDom()).composerChars, 0);
});


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
  const openRes = await openFixtureBrowser(adapter);
  assert.equal(openRes.opened, true, "Browser should open and connect CDP");

  // 4. Inspect status via positive evidence
  const status = await adapter.checkStatus();
  assert.equal(status.browserState, "ready", JSON.stringify(status));
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

test("Response completion waits past missing Stop and partial JSON for the newest answer's stable feedback row", { timeout: 25000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-driver-test-profile-"));
  const fixture = new GeminiDomFixtureServer({ signedIn: true });
  let live: LiveGeminiBrowserAdapter | undefined;
  t.after(async () => { try { await live?.cleanup(); } finally { await fixture.stop(); await removeFixtureProfile(directory); } });
  await fixture.start();
  live = new LiveGeminiBrowserAdapter({ targetUrl: fixture.url, userDataDir: directory, debugPort: await getFreePort(), headless: true, fixtureMode: true, allowedOrigins: [fixture.url] });
  await openFixtureBrowser(live);
  assert.equal((await live.checkStatus()).browserState, "ready");
  const cdp = live.driver.cdp!;
  const partial = '{"nonce":"937bdcdd13038b8a3ba0e990705cdb4f';
  const full = JSON.stringify({ nonce: "a".repeat(48), type: "tool_call", name: "view_file", args: { AbsolutePath: "D:/fixture.txt" } });
  await cdp.evaluate(`(() => {
    const history = document.getElementById('conversation');
    history.innerHTML = '<div class="model-response"><div class="model-response-text">old answer</div><button aria-label="Good response">old feedback</button></div><div class="model-response" id="current-answer"><div class="model-response-text"><pre><code></code></pre><button aria-label="Copy code">Copy</button></div><div id="completion-row" style="display:none"><button aria-label="localized feedback"><mat-icon fonticon="thumb_up"></mat-icon></button></div></div>';
    document.querySelector('#current-answer code').textContent = ${JSON.stringify(partial)};
  })()`);
  const initial = await live.driver.inspectDom();
  assert.equal(initial.responseCount, 2);
  assert.equal(initial.isGenerating, false);
  assert.equal(initial.hasResponseCompletion, false, "Previous feedback, Copy and hidden action rows cannot complete this answer.");
  let settled = false;
  const polling = live.driver.pollForResponse(1, 5000).then(result => { settled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(settled, false, "Even stable partial JSON with no Stop button must remain pending.");
  await cdp.evaluate(`(() => {
    const stop = document.createElement('button'); stop.id = 'localized-stop'; stop.setAttribute('aria-label', 'Dừng câu trả lời'); stop.textContent = 'Stop'; document.body.appendChild(stop);
    document.querySelector('#current-answer code').textContent = ${JSON.stringify(full)};
    document.getElementById('completion-row').style.display = 'block';
  })()`);
  assert.equal((await live.driver.inspectDom()).isGenerating, true, "A visible localized Stop is detected even after a hidden Stop match.");
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(settled, false, "Feedback cannot finish an answer while generation is active.");
  await cdp.evaluate("document.getElementById('localized-stop').remove()");
  const result = await polling;
  assert.equal(result.completed, true);
  assert.deepEqual(result.codeBlocks, [full]);
  assert.equal(JSON.parse(result.codeBlocks![0]).type, "tool_call");
  await cdp.evaluate("document.getElementById('completion-row').style.display = 'none'");
  assert.equal((await live.driver.pollForResponse(1, 350)).completed, false, "A missing terminal marker times out without claiming completion.");
});

test("Trusted editor input updates the editor model exactly and blocks Send after asynchronous clipping", { timeout: 25000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-driver-test-profile-"));
  const fixture = new GeminiDomFixtureServer({ signedIn: true });
  let live: LiveGeminiBrowserAdapter | undefined;
  t.after(async () => { try { await live?.cleanup(); } finally { await fixture.stop(); await removeFixtureProfile(directory); } });
  await fixture.start();
  live = new LiveGeminiBrowserAdapter({ targetUrl: fixture.url, userDataDir: directory, debugPort: await getFreePort(), headless: true, fixtureMode: true, allowedOrigins: [fixture.url] });
  await openFixtureBrowser(live); assert.equal((await live.checkStatus()).browserState, "ready");
  const cdp = live.driver.cdp!;
  await cdp.evaluate(`(() => {
    const editor = document.getElementById('composerInput');
    editor.addEventListener('input', event => { if (event.isTrusted) window.fixtureEditorModel = editor.innerText; });
    document.getElementById('sendBtn').addEventListener('click', event => { if (!event.isTrusted) event.stopImmediatePropagation(); }, true);
  })()`);
  const text = '<native_context_json>\n' + JSON.stringify({ text: "Fixture tiếng Việt 😀 ".repeat(900), tools: ["verify_context"] }) + '\n</native_context_json>';
  assert.equal(await live.driver.inputPrompt(text), true);
  assert.equal(await cdp.evaluate("window.fixtureEditorModel"), text);
  await live.submitPrompt("trusted-click-fixture", "Trusted input and click required");
  assert.equal((await live.pollResponse("trusted-click-fixture", { deadlineMs: 5000 })).status, "completed");
  await cdp.evaluate(`document.getElementById('composerInput').addEventListener('input', () => setTimeout(() => { document.getElementById('composerInput').innerText = 'CLIPPED'; }, 0))`);
  await assert.rejects(live.submitPrompt("clipped-fixture", text), { code: "INPUT_FAILED" });
  assert.equal(await cdp.evaluate("document.querySelectorAll('.user-query').length"), 1);
  assert.equal((await live.driver.inspectDom()).responseCount, 1);
});

test("A virtualized answer count still acknowledges Send and polls the new response by identity", { timeout: 20000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-driver-test-profile-"));
  const fixture = new GeminiDomFixtureServer({ signedIn: true, streamDelayMs: 10 });
  let live: LiveGeminiBrowserAdapter | undefined;
  t.after(async () => { try { await live?.cleanup(); } finally { await fixture.stop(); await removeFixtureProfile(directory); } });
  await fixture.start();
  live = new LiveGeminiBrowserAdapter({ targetUrl: fixture.url, userDataDir: directory, debugPort: await getFreePort(), headless: true, fixtureMode: true, allowedOrigins: [fixture.url] });
  await openFixtureBrowser(live); assert.equal((await live.checkStatus()).browserState, "ready");
  await live.driver.cdp!.evaluate(`(() => {
    document.getElementById('conversation').innerHTML = '<div class="model-response" id="old-answer"><div class="model-response-text">OLD ANSWER</div><button aria-label="Good response">Feedback</button></div>';
    document.getElementById('sendBtn').addEventListener('click', () => document.getElementById('old-answer').remove(), { capture: true, once: true });
    const stop = document.getElementById('stopBtn'); stop.className = ''; stop.setAttribute('aria-label', 'Unknown localized control'); stop.style.display = 'none';
  })()`);
  assert.equal((await live.driver.inspectDom()).responseCount, 1);
  await live.submitPrompt("virtualized-fixture", "Synthetic next turn");
  const result = await live.pollResponse("virtualized-fixture", { deadlineMs: 5000 });
  assert.equal(result.status, "completed");
  assert.ok(result.text.includes("Turn 1 text response"));
  assert.equal((await live.driver.inspectDom()).responseCount, 1);
});
