import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { type RuntimeFacade } from "@antigravity-gemini-web/runtime";
import { type IpcSecurityBridge } from "./ipc-bridge.js";

export async function runDesktopSmoke(window: BrowserWindow, runtime: RuntimeFacade, bridge: IpcSecurityBridge, getSecurity: () => { sandboxed: boolean; contextIsolated: boolean } | undefined): Promise<void> {
  const content = window.webContents;
  assert.equal(app.getPath("userData"), path.join(runtime.appDataDir, "electron"));
  assert.equal(app.getPath("sessionData"), path.join(runtime.appDataDir, "electron", "session"));
  const errors: string[] = [];
  content.on("preload-error", () => errors.push("preload-error"));
  const evaluate = (script: string) => content.executeJavaScript(script, true);
  async function capture(file: string): Promise<void> {
    await evaluate("document.getAnimations().forEach(animation=>animation.finish())");
    // Hidden windows may retain the previous compositor frame until capture.
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    await content.capturePage();
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    fs.writeFileSync(path.join(runtime.appDataDir, file), (await content.capturePage()).toPNG());
  }
  async function waitFor(script: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await evaluate(script)) return;
      await new Promise<void>(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Desktop UI assertion deadline: " + script);
  }
  await waitFor("!!window.launcherClient && document.body.innerText.includes('Tổng quan hệ thống')");
  assert.equal(await evaluate("document.querySelectorAll('nav button:not(.nav-hidden)').length"), 3, "Only the three requested tabs should be visible");
  assert.equal(await evaluate("[...document.querySelectorAll('nav button.nav-hidden')].every(button => getComputedStyle(button).display === 'none' && !button.checkVisibility())"), true, "Hidden views must not remain visible or keyboard reachable");
  const security = getSecurity();
  assert.equal(security?.sandboxed, true); assert.equal(security?.contextIsolated, true);
  const surface = await evaluate("({ methods: Object.keys(window.launcherClient).sort(), require: typeof window.require, process: typeof window.process })");
  assert.deepEqual(surface.methods, ["copyNativeExtensionPairingCode", "execute", "executeNativeAccount", "executeNativeChatImport", "executeNativeKnowledge", "getActivity", "getNativeAccounts", "getNativeChatImports", "getNativeKnowledge", "getOperation", "getSessions", "getSnapshot", "importNativeKnowledge", "inspectNativeChatImport", "subscribe"]);
  assert.equal(await evaluate("window.launcherClient.getNativeAccounts().then(()=> 'unexpected',error=>error.code)"),"UNSUPPORTED_OPERATION");
  assert.equal(surface.require, "undefined"); assert.equal(surface.process, "undefined");
  const snapshot = await evaluate("window.launcherClient.getSnapshot()");
  assert.equal(snapshot.mode, "live"); assert.equal(snapshot.integration.state, "unverified");
  assert.deepEqual(snapshot.availableModels, []);
  const missingPreload = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await missingPreload.loadURL("app://local/index.html?mode=live");
    const body = await missingPreload.webContents.executeJavaScript("document.body.innerText");
    assert.ok(body.includes("PRELOAD_UNAVAILABLE"));
    assert.equal(body.includes("Demo · dữ liệu mô phỏng"), false);
  } finally { missingPreload.close(); }
  await evaluate("window.__smokeEvents = []; window.__smokeUnsubscribe = window.launcherClient.subscribe(event => window.__smokeEvents.push(event)); void 0;");
  await evaluate("window.launcherClient.getSnapshot()");
  const ack = await evaluate("window.launcherClient.execute({ requestId: 'desktop-smoke-check', type: 'runtime.check', payload: { scope: 'connection' } })");
  assert.equal(ack.accepted, true);
  await waitFor("window.launcherClient.getOperation(" + JSON.stringify(ack.operationId) + ").then(operation => operation.state === 'succeeded')");
  const op = await evaluate("window.launcherClient.getOperation(" + JSON.stringify(ack.operationId) + ")");
  assert.equal(op.state, "succeeded");
  await waitFor("window.__smokeEvents.some(event => event.type === 'operation.updated')");
  const gate = await evaluate("window.launcherClient.execute({ requestId:'desktop-smoke-gate', type:'integration.apply', payload:{previewId:'fake'} }).then(() => 'unexpected', error => error.code)");
  assert.equal(gate, "NATIVE_ROUTE_UNVERIFIED");
  await evaluate("window.__smokeUnsubscribe()");
  const before = await evaluate("window.__smokeEvents.length");
  runtime.engine.recordActivity("info", "fixture", "Synthetic IPC event after unsubscribe");
  await new Promise<void>(resolve => setTimeout(resolve, 100));
  assert.equal(await evaluate("window.__smokeEvents.length"), before);

  await evaluate("[...document.querySelectorAll('nav button')].find(button => button.textContent.includes('Cài đặt')).click()");
  await waitFor("!!document.querySelector('#settings-theme')");
  await evaluate("(() => { const selector=document.querySelector('#settings-theme'); selector.value='dark'; selector.dispatchEvent(new Event('change',{bubbles:true})); })();");
  await new Promise<void>(resolve => setTimeout(resolve, 50));
  await evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent.includes('Lưu thiết lập')).click()");
  await waitFor("document.body.innerText.includes('Đã lưu cài đặt thành công')");
  assert.equal((await runtime.getSnapshot()).settings.theme, "dark");
  assert.equal(JSON.parse(fs.readFileSync(path.join(runtime.appDataDir, "settings.json"), "utf8")).theme, "dark");

  // Exercise the React form, not a mock client's preference object.
  await evaluate("(() => { const selector=document.querySelector('#settings-theme'); selector.value='light'; selector.dispatchEvent(new Event('change',{bubbles:true})); })();");
  await new Promise<void>(resolve => setTimeout(resolve, 50));
  let authoritative = await runtime.getSnapshot();
  await runtime.execute({ requestId: "desktop-external-preferences", type: "settings.update", payload: { expectedRevision: authoritative.settings.revision, patch: { diagnosticLevel: "verbose_redacted" } } });
  await waitFor("document.body.innerText.includes('Revision: 3')");
  assert.equal(await evaluate("document.querySelector('#settings-theme').value"), "light", "New snapshot must not discard unsaved draft");
  await evaluate("document.querySelector('[data-action=settings-save]').click()");
  await waitFor("document.body.innerText.includes('Lưu thất bại')");
  assert.equal(await evaluate("document.querySelector('#settings-theme').value"), "light");
  assert.equal((await runtime.getSnapshot()).settings.theme, "dark");
  await evaluate("document.querySelector('[data-action=settings-discard]').click()");
  assert.equal(await evaluate("document.querySelector('#settings-theme').value"), "dark");
  await evaluate("(() => { const selector=document.querySelector('#settings-language'); selector.value='en'; selector.dispatchEvent(new Event('change',{bubbles:true})); })();");
  await new Promise<void>(resolve => setTimeout(resolve, 50));
  await evaluate("document.querySelector('[data-action=settings-save]').click()");
  await waitFor("document.documentElement.lang === 'en' && document.body.innerText.includes('Settings saved successfully')");
  assert.equal((await runtime.getSnapshot()).settings.language, "en");
  content.reload();
  await new Promise<void>(resolve => content.once("did-finish-load", () => resolve()));
  await waitFor("document.documentElement.lang === 'en' && !!document.querySelector('nav')");
  await evaluate("document.querySelectorAll('nav button')[4].click()");
  await waitFor("!!document.querySelector('#settings-theme')");
  await evaluate("(() => { const selector=document.querySelector('#settings-theme'); selector.value='light'; selector.dispatchEvent(new Event('change',{bubbles:true})); })();");
  await new Promise<void>(resolve => setTimeout(resolve, 50));
  authoritative = await runtime.getSnapshot();
  await runtime.execute({ requestId: "desktop-english-conflict", type: "settings.update", payload: { expectedRevision: authoritative.settings.revision, patch: { diagnosticLevel: "normal" } } });
  await evaluate("document.querySelector('[data-action=settings-save]').click()");
  await waitFor("document.body.innerText.includes('Your draft is retained') && document.body.innerText.includes('CONFIG_CONFLICT')");
  assert.equal(await evaluate("document.querySelector('#settings-theme').value"), "light");
  await evaluate("document.querySelector('[data-action=settings-discard]').click()");
  const englishViews = ["System Overview", "Initial Setup", "Sessions & Tasks", "Activity & Diagnostics", "Application Settings"];
  for (const [index, title] of englishViews.entries()) {
    await evaluate("document.querySelectorAll('nav button')[" + index + "].click()");
    await waitFor("document.body.innerText.includes(" + JSON.stringify(title) + ")");
    if (index === 1) assert.equal(await evaluate("document.querySelector('[data-action=native-e2e]').disabled"), true);
  }
  const contrast: unknown[] = [];
  const luminance = (hex: string) => {
    const channels = hex.replace("#", "").match(/../g)!.map(channel => parseInt(channel, 16) / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  for (const storedTheme of ["light", "dark"] as const) {
    authoritative = await runtime.getSnapshot();
    await runtime.execute({ requestId: "desktop-theme-" + storedTheme, type: "settings.update", payload: { expectedRevision: authoritative.settings.revision, patch: { theme: storedTheme } } });
    await waitFor("document.documentElement.getAttribute('data-theme') === 'light'");
    const tokens = await evaluate("Object.fromEntries(['--bg-primary','--bg-secondary','--bg-tertiary','--text-primary','--text-secondary','--text-muted'].map(key => [key,getComputedStyle(document.documentElement).getPropertyValue(key).trim()]))");
    for (const foreground of ["--text-primary", "--text-secondary", "--text-muted"]) for (const background of ["--bg-primary", "--bg-secondary", "--bg-tertiary"]) {
      const a = luminance(tokens[foreground]), b = luminance(tokens[background]);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      assert.ok(ratio >= 4.5, "light " + foreground + " on " + background + " contrast " + ratio);
      contrast.push({ theme: "light", storedTheme, foreground, background, ratio });
    }
    if (storedTheme === "light") {
      await evaluate("document.querySelectorAll('nav button')[0].click()");
      await waitFor("document.body.innerText.includes('System Overview')");
      await capture("launcher-english-light.png");
    }
  }
  authoritative = await runtime.getSnapshot();
  await runtime.execute({ requestId: "desktop-restore-locale", type: "settings.update", payload: { expectedRevision: authoritative.settings.revision, patch: { theme: "dark", language: "vi" } } });
  await waitFor("document.documentElement.lang === 'vi'");
  content.reload();
  await new Promise<void>(resolve => content.once("did-finish-load", () => resolve()));
  await waitFor("document.documentElement.getAttribute('data-theme') === 'light' && document.body.innerText.includes('Tổng quan hệ thống')");
  const layout: unknown[] = [];
  for (const [width, height] of [[1280, 800], [1024, 720], [800, 600]]) {
    window.setContentSize(width!, height!);
    await waitFor("innerWidth==="+width+" && innerHeight==="+height);
    for (const [index, view] of ["overview", "onboarding", "sessions", "activity", "settings"].entries()) {
      await evaluate("document.querySelectorAll('nav button')[" + index + "].click()");
      await new Promise<void>(resolve => setTimeout(resolve, 80));
      const dimensions = await evaluate("({ view:" + JSON.stringify(view) + ", width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth })");
      assert.ok(dimensions.documentWidth <= dimensions.width, "No horizontal viewport overflow: " + view);
      layout.push(dimensions);
    }
    await evaluate("document.querySelectorAll('nav button')[0].click()");
    await waitFor("document.body.innerText.includes('Tổng quan hệ thống')");
    await capture("launcher-" + width + "x" + height + ".png");
  }
  await evaluate("document.activeElement?.blur();");
  content.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
  content.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
  await waitFor("document.activeElement && document.activeElement.tagName !== 'BODY'");
  assert.equal(errors.length, 0);
  const result = { mode: "desktop-live-control", nativeInference: "unverified", ipcRoundTrip: true, eventSubscription: true, unsubscribe: true, settingsPersistence: true, settingsDraftConflict: true, languagePersistence: true, englishViews, contrast, reload: true, sandbox: true, contextIsolation: true, nodeIntegration: false, keyboardFocus: true, layout, versions: process.versions };
  fs.writeFileSync(path.join(runtime.appDataDir, "desktop-smoke.json"), JSON.stringify(result, null, 2));
}
