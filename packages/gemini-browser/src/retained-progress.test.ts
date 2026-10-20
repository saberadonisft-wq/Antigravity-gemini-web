import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { GeminiDomFixtureServer } from "./fixture-server.js";
import { LiveGeminiBrowserAdapter, ProgressDeadline, inspectBrowserModels } from "./index.js";
import { GeminiBrowserDriver } from "./gemini-browser-driver.js";
import { CdpClient } from "./cdp-client.js";
import { removeFixtureProfile } from "./fixture-cleanup.js";

test("Idle time follows actual progress and remains bounded by the independent hard duration", () => {
  const clock = new ProgressDeadline(0, 1000, 300);
  assert.equal(clock.remaining(200), 100);
  clock.activity(200); assert.equal(clock.remaining(400), 100);
  clock.activity(900); assert.equal(clock.remaining(999), 1); assert.equal(clock.expired(1000), true);
  const idle = new ProgressDeadline(0, 1000, 100); assert.equal(idle.expired(100), true);
});

test("Explicit existing-chat attach preserves history and draft, never creates a tab, and rejects duplicates", { timeout: 25000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-driver-test-profile-"));
  const fixture = new GeminiDomFixtureServer({ signedIn: true, streamDelayMs: 10 });
  const port = await new Promise<number>(resolve => { const server = net.createServer(); server.listen(0, "127.0.0.1", () => { const value = (server.address() as net.AddressInfo).port; server.close(() => resolve(value)); }); });
  let live: LiveGeminiBrowserAdapter | undefined;
  t.after(async () => { try { await live?.cleanup(); } finally { await fixture.stop(); await removeFixtureProfile(directory); } });
  await fixture.start();
  live = new LiveGeminiBrowserAdapter({ targetUrl: fixture.url, userDataDir: directory, debugPort: port, headless: true, fixtureMode: true, allowedOrigins: [fixture.url] });
  await live.openBrowser();
  assert.equal((await live.checkStatus()).browserState, "ready");
  const existingWs = live.driver.cdp!.wsUrl;
  const url = fixture.url + "/saved_conversation";
  await live.driver.cdp!.evaluate(`history.replaceState({}, '', ${JSON.stringify(url)})`);
  await live.submitPrompt("original-history", "Existing history");
  assert.equal((await live.pollResponse("original-history", { deadlineMs: 5000 })).status, "completed");
  const before = await live.driver.inspectDom(); assert.equal(before.responseCount, 1);
  await live.driver.inputPrompt("DO_NOT_ERASE_DRAFT");
  await assert.rejects(live.openExistingConversation(url), /draft/);
  assert.equal(await live.driver.cdp!.evaluate("document.querySelector('[contenteditable=true]').textContent"), "DO_NOT_ERASE_DRAFT");
  await live.driver.cdp!.evaluate("document.querySelector('[contenteditable=true]').textContent = ''");
  await assert.rejects(live.openExistingConversation(fixture.url + "/missing"), /exactly one/);
  const lease = await live.openExistingConversation(url);
  await assert.rejects(live.openExistingConversation(url), /active lease/);
  assert.equal(live.driver.cdp!.wsUrl, existingWs);
  await live.submitPrompt("continued-history", "New follow-up");
  assert.equal((await live.pollResponse("continued-history", { deadlineMs: 5000 })).status, "completed");
  assert.equal((await live.driver.inspectDom()).responseCount, 2);
  await lease.suspend!(); await lease.resume!(); await lease.close();
  assert.ok(await CdpClient.findTarget(port, target => target.webSocketDebuggerUrl === existingWs));
  const duplicated = await live.driver.cdp!.send<{ targetId: string }>("Target.createTarget", { url });
  try { await assert.rejects(live.openExistingConversation(url), /exactly one/); }
  finally { await CdpClient.closeOwnedTarget(port, duplicated.targetId); }
  const targets = await live.driver.cdp!.send<{ targetInfos: Array<{ type: string }> }>("Target.getTargets");
  assert.equal(targets.targetInfos.filter(target => target.type === "page").length, 1);
  assert.equal((await live.driver.inspectDom()).responseCount, 2, "Attach and failed attempts must not create extra turns.");
});

test("Real CDP fixture retains one task tab, verifies Argon/effort, streams progress and cancels active polling", { timeout: 30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-driver-test-profile-"));
  const fixture = new GeminiDomFixtureServer({ signedIn: true, streamDelayMs: 15, modelPickerDelayMs: 500, modelOptionsDelayMs: 500 });
  const port = await new Promise<number>(resolve => { const server = net.createServer(); server.listen(0, "127.0.0.1", () => { const value = (server.address() as net.AddressInfo).port; server.close(() => resolve(value)); }); });
  let live: LiveGeminiBrowserAdapter | undefined;
  t.after(async () => { try { await live?.cleanup(); } finally { await fixture.stop(); await removeFixtureProfile(directory); } });
  await fixture.start();
  live = new LiveGeminiBrowserAdapter({ targetUrl: fixture.url, userDataDir: directory, debugPort: port, headless: true, fixtureMode: true, allowedOrigins: [fixture.url] });
  assert.equal((await live.openBrowser()).opened, true);
  assert.equal((await live.checkStatus()).browserState, "ready");
  await live.driver.inputPrompt("KEEP_ORIGINAL_DRAFT"); const original = live.driver.cdp!.wsUrl;
  const lease = await live.openFreshConversation(); const owned = live.driver.cdp!.wsUrl;
  const policy = { model: "4 Argon", effort: "Low" };
  assert.deepEqual(await live.selectModel(policy), policy);
  await assert.rejects(live.selectModel({ model: "Unavailable Model" }), { code: "MODEL_UNAVAILABLE" });
  for (let index = 0; index < 3; index++) {
    if (index) { await lease.resume!(); assert.equal(live.driver.cdp!.wsUrl, owned); }
    await live.submitPrompt("retained-" + index, "fixture turn " + index, { modelSelection: policy });
    const updates: string[] = [];
    const result = await live.pollResponse("retained-" + index, { deadlineMs: 5000, stallTimeoutMs: 1000, onProgress: progress => updates.push(progress.text) });
    assert.equal(result.status, "completed"); assert.ok(updates.length > 1);
    assert.equal((await live.driver.inspectDom()).responseCount, index + 1);
    assert.equal(await live.driver.cdp!.evaluate("document.body.dataset.feedbackClicked || null"), null, "Send feedback must never be mistaken for Send message.");
    await lease.suspend!(); assert.equal(live.driver.cdp!.wsUrl, original);
    assert.equal(await live.driver.cdp!.evaluate("document.querySelector('[contenteditable=true]').textContent"), "KEEP_ORIGINAL_DRAFT");
  }
  await lease.resume!();
  await live.submitPrompt("retained-cancel", "long fixture generation", { modelSelection: policy });
  const started = performance.now();
  const pending = live.pollResponse("retained-cancel", { deadlineMs: 600000 });
  await assert.rejects(lease.preserve!(), /unsettled/);
  assert.equal((await live.cancelPrompt("retained-cancel")).cancelled, true);
  assert.equal((await pending).status, "cancelled"); assert.ok(performance.now() - started < 3000);
  await lease.close(); assert.equal(live.driver.cdp!.wsUrl, original);
  const targets = await live.driver.cdp!.send<{ targetInfos: Array<{ type: string }> }>("Target.getTargets");
  assert.equal(targets.targetInfos.filter(target => target.type === "page").length, 1);
  const inspectable = await live.openFreshConversation();
  const inspectableWs = live.driver.cdp!.wsUrl;
  await inspectable.preserve!();
  await assert.rejects(inspectable.resume!(), /invalidated/);
  await inspectable.close(); // Retired lease cannot close the preserved page later.
  assert.ok(await CdpClient.findTarget(port, target => target.webSocketDebuggerUrl === inspectableWs));
  assert.equal(live.driver.cdp!.wsUrl, original);
  // Preservation intentionally leaves Chrome alive in production. This test
  // owns the entire fixture process/profile and must close it before removal.
  await live.driver.close();
});

test("Manual edits invalidate a retained target, and a changed Web model blocks Send", { timeout: 20000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-driver-test-profile-"));
  const fixture = new GeminiDomFixtureServer({ signedIn: true });
  const server = net.createServer();
  const port = await new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => { const value = (server.address() as net.AddressInfo).port; server.close(() => resolve(value)); }));
  let live: LiveGeminiBrowserAdapter | undefined;
  t.after(async () => { try { await live?.cleanup(); } finally { await fixture.stop(); await removeFixtureProfile(directory); } });
  await fixture.start();
  live = new LiveGeminiBrowserAdapter({ targetUrl: fixture.url, userDataDir: directory, debugPort: port, headless: true, fixtureMode: true, allowedOrigins: [fixture.url] });
  await live.openBrowser(); await live.checkStatus();
  const lease = await live.openFreshConversation();
  await live.selectModel({ model: "4 Argon", effort: "High" });
  await live.driver.cdp!.evaluate("document.querySelector('[data-model-option=\"4 Argon\"]').classList.remove('selected')");
  await assert.rejects(live.submitPrompt("selection-changed", "must not send", { modelSelection: { model: "4 Argon", effort: "High" } }), { code: "MODEL_UNAVAILABLE" });
  assert.equal((await live.driver.inspectDom()).responseCount, 0);
  await live.driver.inputPrompt(""); await lease.suspend!();
  await lease.resume!(); await live.driver.inputPrompt("EXTERNAL_EDIT");
  // Returning to the original page must not accept a modified owned conversation.
  await assert.rejects(lease.resume!());
  await lease.close();
  // Simulate the user visiting /usage while the debug browser remains open.
  await live.driver.cdp!.send("Page.navigate", { url: fixture.url.replace(/app$/, "usage") });
  for (let retry = 0; retry < 20 && (await live.driver.inspectDom()).isAllowedSurface; retry++) await new Promise(resolve => setTimeout(resolve, 50));
  const joining = new GeminiBrowserDriver({ targetUrl: fixture.url, userDataDir: directory, debugPort: port, fixtureMode: true, allowedOrigins: [fixture.url] });
  try {
    assert.equal(await joining.launchOrAttach(5000), true); assert.equal(joining.isOwnedProcess, false);
    assert.equal(joining.isAttachedTarget, true);
    joining.cdp!.close(); // Deterministically reproduce the lost page-ACK socket.
    await joining.close();
    assert.equal(live.driver.isProcessAlive, true, "Attached cleanup cannot close the original debug browser.");
    const targets = await live.driver.cdp!.send<{ targetInfos: Array<{ type: string }> }>("Target.getTargets");
    assert.equal(targets.targetInfos.filter(target => target.type === "page").length, 1);
  } finally { await joining.close(); }
});

test("Closing the original tab cannot lose a completed retained response or prevent owned-target cleanup", { timeout: 25000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-driver-test-profile-"));
  const fixture = new GeminiDomFixtureServer({ signedIn: true, streamDelayMs: 5 });
  const server = net.createServer();
  const port = await new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => { const value = (server.address() as net.AddressInfo).port; server.close(() => resolve(value)); }));
  let live: LiveGeminiBrowserAdapter | undefined;
  let witness: CdpClient | undefined;
  t.after(async () => { witness?.close(); try { await live?.cleanup(); } finally { await fixture.stop(); await removeFixtureProfile(directory); } });
  await fixture.start();
  live = new LiveGeminiBrowserAdapter({ targetUrl: fixture.url, userDataDir: directory, debugPort: port, headless: true, fixtureMode: true, allowedOrigins: [fixture.url] });
  assert.equal((await live.openBrowser()).opened, true);
  const originalWs = live.driver.cdp!.wsUrl;
  const original = await CdpClient.findTarget(port, target => target.webSocketDebuggerUrl === originalWs);
  assert.ok(original);
  const lease = await live.openFreshConversation();
  const ownedWs = live.driver.cdp!.wsUrl;
  const owned = await CdpClient.findTarget(port, target => target.webSocketDebuggerUrl === ownedWs);
  assert.ok(owned);
  const created = await live.driver.cdp!.send<{ targetId: string }>("Target.createTarget", { url: fixture.url });
  const unrelated = await CdpClient.findTarget(port, target => target.id === created.targetId);
  assert.ok(unrelated?.webSocketDebuggerUrl);
  witness = new CdpClient(unrelated.webSocketDebuggerUrl); await witness.connect();
  const witnessDriver = new GeminiBrowserDriver({fixtureMode:true,allowedOrigins:[fixture.url]});
  witnessDriver.cdp = witness;
  assert.equal(await witnessDriver.waitForComposerReady(),true);
  await witness.evaluate("new Promise(resolve => { const timer = setInterval(() => { const composer = document.querySelector('[contenteditable=true]'); if (composer) { clearInterval(timer); composer.textContent = 'UNRELATED_DRAFT'; resolve(true); } }, 20); setTimeout(() => { clearInterval(timer); resolve(false); }, 3000); })");
  assert.equal((await live.driver.cdp!.send<{ success: boolean }>("Target.closeTarget", { targetId: original.id })).success, true);
  await CdpClient.confirmTargetClosed(port, original.id);
  await assert.rejects(live.driver.attachToExistingWs(originalWs));
  assert.equal(live.driver.cdp!.wsUrl, ownedWs);
  assert.equal(live.driver.isConnected, true, "A failed return to a closed page must keep the owned CDP connection alive.");
  for (let index = 0; index < 2; index++) {
    if (index) await lease.resume!();
    await live.submitPrompt("closed-anchor-" + index, "fixture response " + index);
    assert.equal((await live.pollResponse("closed-anchor-" + index, { deadlineMs: 5000 })).status, "completed");
    await lease.suspend!();
    assert.equal(live.driver.cdp!.wsUrl, ownedWs, "A missing original tab must not retarget an unrelated page.");
  }
  await lease.resume!(); await live.driver.inputPrompt("EXTERNAL_EDIT");
  await assert.rejects(lease.resume!(), "A closed original tab does not weaken the owned-conversation checkpoint.");
  await lease.close(); await CdpClient.confirmTargetClosed(port, owned.id);
  assert.equal(await witness.evaluate("document.querySelector('[contenteditable=true]').textContent"), "UNRELATED_DRAFT");
  assert.equal((await witness.send<{ targetInfos: Array<{ type: string }> }>("Target.getTargets")).targetInfos.filter(target => target.type === "page").length, 1);
  assert.equal((await live.checkStatus()).browserState, "ready", "Cleanup may reconnect on the next explicit status check.");
  const lastLease = await live.openFreshConversation();
  await live.driver.cdp!.send("Target.closeTarget", { targetId: created.targetId });
  await CdpClient.confirmTargetClosed(port, created.targetId);
  await lastLease.close();
});

test("An exclusive Thinking submenu stays verifiable with a large composer and cannot silently repair a changed effort", { timeout: 20000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-driver-test-profile-"));
  const fixture = new GeminiDomFixtureServer({ signedIn: true, exclusiveEffortMenu: true, modelOptionsDelayMs: 400, transientMenuCloseMs: 100 });
  const server = net.createServer();
  const port = await new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => { const value = (server.address() as net.AddressInfo).port; server.close(() => resolve(value)); }));
  let live: LiveGeminiBrowserAdapter | undefined;
  t.after(async () => { try { await live?.cleanup(); } finally { await fixture.stop(); await removeFixtureProfile(directory); } });
  await fixture.start();
  live = new LiveGeminiBrowserAdapter({ targetUrl: fixture.url, userDataDir: directory, debugPort: port, headless: true, fixtureMode: true, allowedOrigins: [fixture.url] });
  await live.openBrowser(); await live.checkStatus();
  const policy = { model: "4 Argon", effort: "Low" };
  const prompt = "Synthetic native context for model selection. ".repeat(1700);
  const assertClosed = async () => assert.equal(await live!.driver.cdp!.evaluate("document.getElementById('modePicker').getAttribute('aria-expanded') === 'false' && document.getElementById('modeMenu').hidden && document.getElementById('effortMenu').hidden"), true);
  await live.selectModel(policy); await assertClosed();
  await live.driver.inputPrompt(prompt);
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.deepEqual(await live.driver.selectModel(policy, true), policy);
    await assertClosed();
    assert.equal(await live.driver.cdp!.evaluate("document.getElementById('composerInput').textContent.length"), prompt.length);
  }
  await live.selectModel({ model: "4 Argon", effort: "High" });
  const surface = { fixtureMode: true, allowedOrigins: [fixture.url] };
  const beforeContext = await inspectBrowserModels(live.driver.cdp!, surface);
  assert.deepEqual(beforeContext.selected, { model: "4 Argon", effort: "High" });
  assert.ok(beforeContext.options.some(option => option.model === "3.8 Flash" && !option.disabled));
  await assertClosed();
  await live.selectModel({ model: "3.8 Flash" });
  assert.equal((await inspectBrowserModels(live.driver.cdp!, surface)).selected.model, "3.8 Flash");
  await live.selectModel(beforeContext.selected);
  assert.deepEqual((await inspectBrowserModels(live.driver.cdp!, surface)).selected, beforeContext.selected);
  assert.equal(await live.driver.cdp!.evaluate("document.getElementById('composerInput').textContent.length"), prompt.length);
  await assert.rejects(live.driver.selectModel(policy, true), { code: "MODEL_UNAVAILABLE" });
  await assertClosed();
  assert.equal(await live.driver.cdp!.evaluate("document.querySelector('[data-effort-option=High]').classList.contains('selected')"), true);
  assert.equal((await live.driver.inspectDom()).responseCount, 0, "Verifying menus must never send a prompt.");
  await live.driver.cdp!.evaluate(`(() => {
    const control = document.getElementById('effortPicker'), panel = document.getElementById('effortMenu');
    window.__effortCaptureClicks = 0;
    control.removeAttribute('aria-expanded');
    control.onclick = () => {
      window.__effortCaptureClicks++;
      panel.hidden = !panel.hidden;
      if (!panel.hidden) {
        const rows = [...panel.querySelectorAll('[data-effort-option]')]; rows.forEach(e => e.hidden = true);
        setTimeout(() => rows.forEach(e => e.hidden = false), 300);
      }
    };
    return true;
  })()`);
  assert.deepEqual((await inspectBrowserModels(live.driver.cdp!, surface)).selected, beforeContext.selected);
  assert.equal(await live.driver.cdp!.evaluate("window.__effortCaptureClicks"), 1, "Opening a submenu must not toggle it repeatedly while its selected row mounts.");
  await assertClosed();
  await live.driver.cdp!.evaluate("document.querySelector('[data-model-option=\"3.8 Flash\"]').classList.add('selected')");
  await assert.rejects(inspectBrowserModels(live.driver.cdp!, surface), { code: "MODEL_UNAVAILABLE" });
  await assertClosed();
});
